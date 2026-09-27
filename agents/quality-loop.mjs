/**
 * Critical Student Quality Loop
 *
 * The core pedagogical iteration engine. Runs simulated "critical students"
 * who relentlessly question the teaching quality. The loop continues until
 * ALL student personas are satisfied (confusion < threshold, no unanswered
 * questions) or max iterations are exhausted.
 *
 * Each iteration can:
 *   1. Rewrite narration (if explanation is unclear)
 *   2. Reorder sections (if prerequisite is missing)
 *   3. Add new sections (if a concept gap is found)
 *   4. Evolve the tool (if visualization can't show the concept)
 *
 * This replaces the simple 3-cycle evolution with a student-driven loop
 * where the students themselves decide when quality is sufficient.
 */

import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import { simulateClassroom } from './student-simulator.mjs';
import { evaluateTeaching } from './teaching-evaluator.mjs';
import { planEvolution, evolveTool, updateSectionsForEvolution } from './tool-evolver.mjs';
import { executeNavActions, injectCursorOverlay } from './navigator.mjs';
import { runAgent, parseVerdict } from '../utils/claude-agent.mjs';

// Quality thresholds — students must meet ALL of these
const QUALITY_THRESHOLDS = {
  maxAvgConfusion: 3.5,        // Average confusion across all personas ≤ 3.5/10
  maxSingleConfusion: 6,       // No single student confused above 6/10
  maxUnansweredQuestions: 2,    // At most 2 unanswered questions per section
  minPedagogyScore: 65,        // Minimum pedagogy score from master teacher
  noStudentDropout: true,      // No student would "drop out"
};

/**
 * Evaluate a single section with the critical student panel.
 * Returns a detailed assessment with specific improvement actions.
 */
async function evaluateSectionQuality(framePath, section, previousSections, lectureTopic = '') {
  const evaluation = await evaluateTeaching(framePath, section, { previousSections, lectureTopic });

  const cf = evaluation.classroomFeedback;
  const tv = evaluation.teacherVerdict;

  const passes = (
    cf.aggregate.avgConfusion <= QUALITY_THRESHOLDS.maxAvgConfusion &&
    cf.aggregate.maxConfusion <= QUALITY_THRESHOLDS.maxSingleConfusion &&
    cf.aggregate.unansweredQuestions.length <= QUALITY_THRESHOLDS.maxUnansweredQuestions &&
    (tv.pedagogyScore || 0) >= QUALITY_THRESHOLDS.minPedagogyScore &&
    !cf.aggregate.anyoneDropping
  );

  return {
    sectionId: section.id,
    passes,
    metrics: {
      avgConfusion: cf.aggregate.avgConfusion,
      maxConfusion: cf.aggregate.maxConfusion,
      unansweredQuestions: cf.aggregate.unansweredQuestions.length,
      pedagogyScore: tv.pedagogyScore || 0,
      anyoneDropping: cf.aggregate.anyoneDropping,
    },
    action: tv.verdict,  // proceed | rewrite_narration | evolve_tool
    narrationRewrite: tv.narrationFeedback?.rewrite || null,
    toolRequirements: tv.toolEvolution?.requirements || [],
    toolSuggestions: cf.aggregate.toolSuggestions,
    unansweredQuestions: cf.aggregate.unansweredQuestions,
    studentReactions: cf.personas.map(p => ({
      name: p.persona, emoji: p.emoji,
      confusion: p.confusion, lostAt: p.lostAt,
      questions: p.questions
    })),
    sequenceFeedback: tv.teachingSequence || {}
  };
}

/**
 * Rewrite narration for sections that need it.
 * Uses student feedback to improve the explanation.
 */
async function rewriteNarration(section, qualityResult, previousSections) {
  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2048,
    systemPrompt: `You are an enthusiastic algorithms professor rewriting a narration.
Fix the specific issues identified by students.

CRITICAL RULES:
- TEACH THE CONCEPT, not the tool. Never say "click", "tab", "card", "tool", "slider", "graph on the right".
- Be enthusiastic and energetic — you LOVE this topic!
- Use concrete numbers: "if n is 1000, then n² is a million..."
- Explain WHY, not just WHAT.
- 3-5 sentences, conversational, engaging.
- The visual is on screen silently — don't describe it, teach through it.`,
    userMessage: `Rewrite this narration to fix student confusion:

CURRENT NARRATION:
"${section.narration}"

STUDENT FEEDBACK:
${qualityResult.studentReactions.map(s =>
  `${s.emoji} ${s.name}: confusion=${s.confusion}/10, lost at="${s.lostAt || 'nowhere'}"
   Questions: ${s.questions.join('; ')}`
).join('\n')}

UNANSWERED QUESTIONS:
${qualityResult.unansweredQuestions.map(q => `- ${q.student}: "${q.question}"`).join('\n')}

PREVIOUS SECTIONS (context already taught):
${previousSections.slice(-5).map(s => `- ${s.id}: ${s.narration.substring(0, 80)}...`).join('\n')}

Output JSON:
\`\`\`json
{
  "narration": "the improved narration text",
  "changes": ["what changed and why"]
}
\`\`\``
  });

  const parsed = parseVerdict(result.text);
  return parsed?.narration || section.narration;
}

/**
 * Reorder sections to fix prerequisite gaps.
 * May also insert new bridging sections.
 */
async function optimizeSequence(sections, qualityResults) {
  const sequenceIssues = qualityResults
    .filter(r => !r.passes && r.sequenceFeedback?.missingPrerequisite)
    .map(r => ({
      sectionId: r.sectionId,
      missingPrerequisite: r.sequenceFeedback.missingPrerequisite,
      shouldFollow: r.sequenceFeedback.prerequisitesMetBy
    }));

  if (sequenceIssues.length === 0) return { sections, changed: false };

  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
    systemPrompt: `You optimize lecture section ordering to fix prerequisite gaps.
You can reorder sections and insert brief bridging narrations.
Output the new ordering and any new sections to add.`,
    userMessage: `Fix the sequence issues in this lecture:

CURRENT SECTION ORDER:
${sections.map((s, i) => `${i + 1}. ${s.id} [group: ${s.group}]`).join('\n')}

PREREQUISITE ISSUES:
${JSON.stringify(sequenceIssues, null, 2)}

Output JSON:
\`\`\`json
{
  "reorderedIds": ["id1", "id2", ...],
  "newSections": [
    {
      "id": "bridge_xyz",
      "insertBefore": "existing_section_id",
      "group": "...",
      "narration": "brief bridging narration",
      "navActions": []
    }
  ],
  "changes": ["what changed and why"]
}
\`\`\``
  });

  const parsed = parseVerdict(result.text);
  if (!parsed?.reorderedIds) return { sections, changed: false };

  // Apply reordering
  const idToSection = new Map(sections.map(s => [s.id, s]));

  // Insert new bridging sections
  if (parsed.newSections) {
    for (const ns of parsed.newSections) {
      idToSection.set(ns.id, {
        ...ns,
        expectedElements: [],
        scrollTarget: null,
        focusTarget: null,
        isAnimated: false
      });
    }
  }

  const reordered = parsed.reorderedIds
    .map(id => idToSection.get(id))
    .filter(Boolean);

  // Add any sections that weren't in the reordered list
  for (const s of sections) {
    if (!reordered.find(r => r.id === s.id)) {
      reordered.push(s);
    }
  }

  return { sections: reordered, changed: true, changes: parsed.changes };
}

/**
 * Main quality loop — iterate until students are satisfied.
 *
 * @param {object} state - Pipeline state
 * @param {object} page - Playwright page
 * @param {object} options - { maxIterations, captureFrame }
 * @returns {object} { sections, toolPath, iterations, allPassed }
 */
export async function runQualityLoop(state, page, options = {}) {
  const {
    maxIterations = 5,
    captureFrame = defaultCaptureFrame,
  } = options;

  // Topic shown to the simulated students: explicit lecture title from the config,
  // otherwise derived from the tool's file name (e.g. Recurrence_Relations_Explorer.html).
  const lectureTopic = state.data.lectureTitle
    || basename(state.data.toolPath || '', '.html').replace(/[_-]+/g, ' ').trim();
  let sections = [...state.data.sections];
  let toolPath = state.data.toolPath;
  let iteration = 0;
  let allPassed = false;

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  🎓 CRITICAL STUDENT QUALITY LOOP`);
  console.log(`  Thresholds: confusion ≤ ${QUALITY_THRESHOLDS.maxAvgConfusion}, pedagogy ≥ ${QUALITY_THRESHOLDS.minPedagogyScore}`);
  console.log(`${'═'.repeat(50)}`);

  while (iteration < maxIterations && !allPassed) {
    iteration++;
    console.log(`\n── Iteration ${iteration}/${maxIterations} ──`);

    // Reload tool if it was evolved
    await page.goto(`file://${toolPath}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await injectCursorOverlay(page);

    // Evaluate each section
    const qualityResults = [];
    const toolEvolutionNeeds = [];
    let passedCount = 0;

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];

      // Capture current frame
      const framePath = await captureFrame(page, section, state.runDir, i);
      if (!framePath) {
        console.log(`   ⏭️  Skip ${section.id} (no frame)`);
        qualityResults.push({ sectionId: section.id, passes: true, metrics: {} });
        passedCount++;
        continue;
      }

      const result = await evaluateSectionQuality(
        framePath, section, sections.slice(0, i), lectureTopic
      );
      qualityResults.push(result);

      const emoji = result.passes ? '✅' : '❌';
      console.log(`   ${emoji} ${section.id}: confusion=${result.metrics.avgConfusion}, pedagogy=${result.metrics.pedagogyScore}, unanswered=${result.metrics.unansweredQuestions}`);

      if (result.passes) {
        passedCount++;
      } else {
        // Log student reactions for failing sections
        for (const s of result.studentReactions) {
          if (s.confusion >= 5) {
            console.log(`      ${s.emoji} ${s.name}: "${s.lostAt || 'confused'}" (${s.confusion}/10)`);
          }
        }

        // Collect improvement actions
        if (result.action === 'rewrite_narration' && result.narrationRewrite) {
          sections[i] = { ...sections[i], narration: result.narrationRewrite };
          console.log(`      📝 Auto-rewrote narration`);
        } else if (result.action === 'rewrite_narration') {
          const newNarration = await rewriteNarration(section, result, sections.slice(0, i));
          sections[i] = { ...sections[i], narration: newNarration };
          console.log(`      📝 Rewrote narration based on student feedback`);
        }

        if (result.action === 'evolve_tool' || result.toolRequirements.length > 0) {
          toolEvolutionNeeds.push(...result.toolRequirements.map(r => ({
            ...r,
            sectionId: section.id,
          })));
        }
      }
    }

    console.log(`\n   📊 Score: ${passedCount}/${sections.length} sections pass`);

    if (passedCount === sections.length) {
      allPassed = true;
      break;
    }

    // ── Fix sequence issues ──
    const sequenceResult = await optimizeSequence(sections, qualityResults);
    if (sequenceResult.changed) {
      sections = sequenceResult.sections;
      console.log(`   🔀 Reordered sections: ${sequenceResult.changes?.join(', ')}`);
    }

    // ── Evolve tool if needed ──
    if (toolEvolutionNeeds.length > 0) {
      console.log(`   🧬 ${toolEvolutionNeeds.length} tool evolution requirement(s)`);

      try {
        const plan = await planEvolution(toolPath, toolEvolutionNeeds);
        const evolveResult = await evolveTool(toolPath, plan, state.runDir);

        if (evolveResult.success) {
          toolPath = evolveResult.path;
          state.data.toolPath = toolPath;
          await state.save();
          console.log(`   ✅ Tool evolved → ${toolPath}`);

          // Update sections with new nav actions if needed
          sections = await updateSectionsForEvolution(sections, plan);
        }
      } catch (e) {
        console.log(`   ⚠️  Tool evolution failed: ${e.message}`);
      }
    }

    // Update state
    state.data.sections = sections;
    await state.save();

    state.addLog(`quality_loop_iteration_${iteration}`, {
      passed: passedCount,
      total: sections.length,
      toolEvolutions: toolEvolutionNeeds.length,
      narrationRewrites: qualityResults.filter(r => r.action === 'rewrite_narration').length,
    });
  }

  console.log(`\n${'═'.repeat(50)}`);
  if (allPassed) {
    console.log(`  ✅ ALL STUDENTS SATISFIED after ${iteration} iteration(s)`);
  } else {
    console.log(`  ⚠️  Quality loop stopped after ${iteration} iterations`);
    console.log(`     Some sections still below threshold`);
  }
  console.log(`${'═'.repeat(50)}\n`);

  return {
    sections,
    toolPath,
    iterations: iteration,
    allPassed,
  };
}

/**
 * Default frame capture function — navigates to section and screenshots.
 */
async function defaultCaptureFrame(page, section, runDir, index) {
  try {
    // Filter out move_cursor_to for navigation (cursor is handled separately)
    const navActions = (section.navActions || []);
    await executeNavActions(page, navActions);
    await page.waitForTimeout(400);

    const framePath = join(runDir, 'frames', `quality_${section.id}.jpg`);
    await page.screenshot({ path: framePath, type: 'jpeg', quality: 85 });
    return framePath;
  } catch (e) {
    return null;
  }
}
