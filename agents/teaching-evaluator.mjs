/**
 * Teaching Evaluator Agent
 *
 * The "master teacher" that evaluates whether a section effectively
 * teaches its concept. Combines:
 *   1. Student simulator feedback (are students following?)
 *   2. Pedagogical analysis (is the teaching sequence logical?)
 *   3. Tool-narration alignment (does the visual support the words?)
 *   4. Bloom's taxonomy check (are we at the right cognitive level?)
 *
 * The evaluator makes three kinds of decisions:
 *
 *   ✅ PROCEED — Teaching is effective, move to recording
 *   🔄 REWRITE_NARRATION — Tool is fine but explanation needs work
 *   🛠️ EVOLVE_TOOL — The tool itself can't adequately show this concept
 *
 * When EVOLVE_TOOL is triggered, the evaluator generates specific
 * requirements for what the tool needs to add/change. This feeds
 * into the Tool Evolver agent, which modifies the HTML.
 *
 * This creates the core pedagogical loop:
 *
 *   teach → simulate students → evaluate → evolve tool → re-teach
 */

import { readFile } from 'fs/promises';
import { simulateClassroom } from './student-simulator.mjs';
import { runAgent, parseVerdict } from '../utils/claude-agent.mjs';

/**
 * Full pedagogical evaluation of a section.
 *
 * @param {string} framePath - Current tool screenshot
 * @param {object} section - Section definition (id, narration, navActions)
 * @param {object} context - { previousSections, toolCapabilities, lectureGoals }
 * @returns {object} Teaching verdict with action items
 */
export async function evaluateTeaching(framePath, section, context = {}) {
  const { previousSections = [], toolCapabilities = [], lectureGoals = {}, lectureTopic = '' } = context;

  // ── Step 1: Simulate classroom ──
  const classroomFeedback = await simulateClassroom(
    framePath,
    section.narration,
    section,
    previousSections.map(s => s.narration),
    lectureTopic
  );

  // ── Step 2: Master teacher evaluation ──
  const imageBuffer = await readFile(framePath);
  const base64Image = imageBuffer.toString('base64');

  const evaluation = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2048,
    systemPrompt: `You are a master teacher and curriculum designer with 20 years of experience
teaching algorithms to undergraduates. You are evaluating a single section
of a video lecture that uses an interactive tool as a visual aid.

Your job: determine whether this section effectively teaches its concept,
and if not, WHAT SPECIFICALLY needs to change.

You have three options:

1. PROCEED — The teaching is effective. Students at all levels can follow.
   The tool visualization supports the explanation. Move to recording.

2. REWRITE_NARRATION — The tool shows the right content, but the
   explanation doesn't connect to it well enough. The words need work.
   (Examples: explanation is too abstract, doesn't reference the visual,
    jumps too fast, assumes knowledge not yet covered)

3. EVOLVE_TOOL — The tool CANNOT adequately demonstrate this concept
   in its current state. It needs new features, views, or interactions.
   (Examples: need a slider to show how changing c affects the bound,
    need an animation that steps through the algorithm,
    need a comparison view showing two algorithms side by side,
    need to show the formula AND its graph simultaneously)

Pedagogical principles to apply:
- Concrete before abstract (show the example, then generalize)
- Visual-verbal alignment (what you see should match what you hear)
- Scaffolding (build on what was just taught, don't assume)
- Active learning (interactive elements > passive display)
- Dual coding (visual + verbal reinforcement)
- Worked examples before practice

Bloom's taxonomy for this course level:
- Section should operate at UNDERSTAND or APPLY level
- REMEMBER is too shallow (just showing definitions)
- ANALYZE is appropriate for proof sections
- CREATE is for challenge mode only`,

    userMessage: `Evaluate this teaching section:

Section: ${section.id}
Group: ${section.group || 'unknown'}

Narration the teacher will say:
"${section.narration}"

Classroom feedback from simulated students:
${JSON.stringify(classroomFeedback.aggregate, null, 2)}

Student questions that the tool CANNOT answer:
${JSON.stringify(classroomFeedback.aggregate.unansweredQuestions, null, 2)}

Student suggestions for tool improvements:
${JSON.stringify(classroomFeedback.aggregate.toolSuggestions, null, 2)}

Individual student reactions:
${classroomFeedback.personas.map(p =>
  `${p.emoji} ${p.persona}: confusion=${p.confusion}/10, lost at="${p.lostAt || 'nowhere'}"`
).join('\n')}

Previous sections covered: ${previousSections.map(s => s.id).join(', ') || 'none'}

Output JSON:
\`\`\`json
{
  "verdict": "proceed" | "rewrite_narration" | "evolve_tool",
  "confidence": 0-100,
  "reasoning": "why this verdict",
  "bloomLevel": "remember|understand|apply|analyze",
  "pedagogyScore": 0-100,
  "narrationFeedback": {
    "strengths": ["..."],
    "weaknesses": ["..."],
    "rewrite": "improved narration text" or null
  },
  "toolEvolution": {
    "needed": true/false,
    "priority": "critical|important|nice-to-have",
    "requirements": [
      {
        "type": "add_feature|modify_view|add_animation|add_interaction|fix_layout",
        "description": "what to add/change",
        "reason": "why this helps teaching",
        "studentNeed": "which student persona needs this most"
      }
    ]
  },
  "teachingSequence": {
    "prerequisitesMetBy": ["section_ids that should come before"],
    "shouldPrecede": ["section_ids that should come after"],
    "missingPrerequisite": "concept that should have been taught first" or null
  }
}
\`\`\``
  });

  const verdict = parseVerdict(evaluation.text) || {
    verdict: 'proceed',
    confidence: 50,
    pedagogyScore: 60,
    narrationFeedback: { strengths: [], weaknesses: [], rewrite: null },
    toolEvolution: { needed: false, requirements: [] },
    teachingSequence: {}
  };

  return {
    sectionId: section.id,
    classroomFeedback,
    teacherVerdict: verdict,
    action: verdict.verdict,
    summary: {
      avgStudentConfusion: classroomFeedback.aggregate.avgConfusion,
      pedagogyScore: verdict.pedagogyScore,
      unansweredQuestions: classroomFeedback.aggregate.unansweredQuestions.length,
      toolEvolutionNeeded: verdict.toolEvolution?.needed || false,
      narrationRewriteNeeded: verdict.verdict === 'rewrite_narration'
    }
  };
}

/**
 * Batch evaluation — run teaching eval on all sections before recording.
 * Returns a prioritized list of tool evolution requirements.
 */
export async function evaluateFullLecture(sections, framePaths, toolPath) {
  console.log('📚 Evaluating full lecture pedagogy...');

  const results = [];
  const allEvolutionRequirements = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const framePath = framePaths[i];

    if (!framePath) {
      console.log(`   ⏭️ Skipping ${section.id} (no frame captured yet)`);
      continue;
    }

    console.log(`   📖 Evaluating ${section.id} (${i + 1}/${sections.length})...`);

    const result = await evaluateTeaching(framePath, section, {
      previousSections: sections.slice(0, i)
    });

    results.push(result);

    const emoji = result.action === 'proceed' ? '✅' :
                  result.action === 'rewrite_narration' ? '📝' : '🛠️';
    console.log(`      ${emoji} ${result.action} (pedagogy: ${result.summary.pedagogyScore}, confusion: ${result.summary.avgStudentConfusion})`);

    if (result.teacherVerdict.toolEvolution?.needed) {
      allEvolutionRequirements.push({
        sectionId: section.id,
        priority: result.teacherVerdict.toolEvolution.priority,
        requirements: result.teacherVerdict.toolEvolution.requirements
      });
    }
  }

  // ── Prioritize tool evolution requirements ──
  const priorityOrder = { critical: 0, important: 1, 'nice-to-have': 2 };
  allEvolutionRequirements.sort((a, b) =>
    (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2)
  );

  const summary = {
    totalSections: results.length,
    proceed: results.filter(r => r.action === 'proceed').length,
    rewriteNarration: results.filter(r => r.action === 'rewrite_narration').length,
    evolveTool: results.filter(r => r.action === 'evolve_tool').length,
    avgPedagogyScore: Math.round(
      results.reduce((s, r) => s + (r.summary.pedagogyScore || 0), 0) / results.length
    ),
    avgStudentConfusion: Math.round(
      results.reduce((s, r) => s + (r.summary.avgStudentConfusion || 0), 0) / results.length * 10
    ) / 10,
    toolEvolutionRequirements: allEvolutionRequirements
  };

  console.log(`\n   📊 Lecture pedagogy summary:`);
  console.log(`      Sections ready:     ${summary.proceed}/${summary.totalSections}`);
  console.log(`      Need narration fix: ${summary.rewriteNarration}`);
  console.log(`      Need tool evolution: ${summary.evolveTool}`);
  console.log(`      Avg pedagogy score: ${summary.avgPedagogyScore}/100`);
  console.log(`      Avg confusion:      ${summary.avgStudentConfusion}/10`);

  return { results, summary, evolutionRequirements: allEvolutionRequirements };
}
