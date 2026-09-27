/**
 * Student Simulator Agent
 *
 * Simulates a classroom of students with different ability levels
 * watching the lecture. Each student persona:
 *   - "Sees" the current tool screenshot
 *   - "Hears" the narration text
 *   - Reacts based on their knowledge level
 *   - Asks questions that a real student would ask
 *   - Reports confusion points
 *
 * Student personas:
 *
 *   🟢 STRONG (CS major, took Discrete Math, reads ahead)
 *       - Catches subtle errors in explanations
 *       - Asks "what about edge cases?" questions
 *       - Wants formal rigor, not just intuition
 *       - Might ask: "Is this tight? Can we prove a matching lower bound?"
 *
 *   🟡 AVERAGE (following along, did the readings)
 *       - Needs clear visual connection between formula and graph
 *       - Gets lost if too many concepts introduced at once
 *       - Might ask: "Can you show me what happens when n = 100?"
 *       - Needs the animation to SEE the pattern
 *
 *   🔴 STRUGGLING (weak math background, first algorithms course)
 *       - Confused by notation itself (what does ∈ mean?)
 *       - Needs concrete examples before abstractions
 *       - Lost if the visual doesn't match the words
 *       - Might ask: "Wait, which line is f(n) and which is g(n)?"
 *       - Needs step-by-step, not leaps of logic
 *
 * The simulator outputs:
 *   - Questions each persona would ask
 *   - Confusion score per persona (0-10)
 *   - Whether the current tool visualization ANSWERS the questions
 *   - Suggested tool modifications if it doesn't
 */

import { claudeVision } from '../utils/claude-agent.mjs';

const STUDENT_PERSONAS = {
  strong: {
    name: 'Alex (Strong Student)',
    emoji: '🟢',
    prompt: `You are Alex, a strong CS student. You took Discrete Math and got an A.
You read the textbook chapter before lecture. You understand formal definitions
but want to make sure the lecture is precise. You catch errors, ask about edge
cases, and want to see formal proofs. You're not confused easily, but you notice
when explanations are hand-wavy or imprecise. You also notice when the visual
tool could show something more rigorously.

When something seems oversimplified, you ask a probing question.
When the tool could demonstrate a deeper concept, you suggest it.`
  },

  average: {
    name: 'Jordan (Average Student)',
    emoji: '🟡',
    prompt: `You are Jordan, an average CS student. You're following the course and
doing the homework, but you need things explained clearly. You understand basic
math but struggle with formal notation at first. You NEED to see the visual to
understand — abstract definitions alone don't click. You learn by watching
examples and animations. If the narration says "look at the graph" but the graph
doesn't clearly show what's being described, you're lost.

When you're confused, you ask "can you show me an example?"
When the visual doesn't match the explanation, you point it out.
You need the animation to actually see the algorithm working.`
  },

  struggling: {
    name: 'Sam (Struggling Student)',
    emoji: '🔴',
    prompt: `You are Sam, a struggling student. This is your first course on this subject
and your math background is weak. You don't know the notation of this topic yet — that's
what you're here to learn. Greek letters confuse you. You need everything spelled
out step by step. You learn by concrete examples: "if we have 5 elements..."
not "for arbitrary n." If the explanation jumps from definition to application
without showing the connection, you're completely lost.

You get confused by:
- Notation you haven't seen before
- Jumps in logic ("therefore..." without showing why)
- When the picture has too many elements and you don't know where to look
- When the narration moves faster than you can follow the visual

Ask basic questions. Point out where you got lost.
Be honest about what you don't understand.

IMPORTANT: If the narration talks about the tool, UI, buttons, clicking,
or describes HOW to use software instead of TEACHING the algorithm concept,
give confusion score 10/10 and say "This sounds like a software tutorial,
not a lecture. Teach me the concept, not how to use a tool."`
  }
};

/**
 * Simulate a classroom watching one section of the lecture.
 * Each student persona reacts to the screenshot + narration.
 *
 * @param {string} framePath - Screenshot of the tool at this point
 * @param {string} narration - What the teacher is saying
 * @param {object} section - Section metadata
 * @param {string[]} previousNarrations - Context from earlier sections
 * @returns {object} Classroom feedback
 */
export async function simulateClassroom(framePath, narration, section, previousNarrations = [], lectureTopic = '') {
  const context = previousNarrations.length > 0
    ? `\n\nPrevious topics covered:\n${previousNarrations.slice(-5).map((n, i) => `${i + 1}. ${n.substring(0, 100)}...`).join('\n')}`
    : '';

  // Run personas sequentially via claude CLI
  const personaResults = [];
  for (const [level, persona] of Object.entries(STUDENT_PERSONAS)) {
    const text = await claudeVision({
      imagePath: framePath,
      textPrompt: `${persona.prompt}

You are watching a lecture on ${lectureTopic || 'the topic shown on screen'}.
The teacher just showed this visualization and said:

"${narration}"
${context}

As ${persona.name}, respond with EXACTLY this JSON format:
\`\`\`json
{
  "confusion": 0-10,
  "understanding": "one sentence about what you understood",
  "questions": ["question 1", "question 2"],
  "canToolAnswer": [true/false for each question - can the CURRENT visualization answer it?],
  "toolSuggestion": "what would help you understand better (new feature, different view, animation, example...)" or null,
  "lostAt": "the specific phrase or concept where you got confused" or null,
  "wouldDropOut": false,
  "mayerViolations": ["principle_name: description"]
}
\`\`\`

Mayer violations to check — tag any that apply:
- "pretraining: <term> used before it was defined" — a term/symbol appears that hasn't been explained yet
- "temporal_contiguity: narration about X but screen shows Y" — visual doesn't match narration
- "coherence: too many things on screen" — extraneous modules/content distracting from the point
- "signaling: don't know where to look" — no visual cue pointing to the relevant element
- "segmenting: too many concepts at once" — section tries to cover multiple ideas
- "redundancy: narration just reads the screen" — narration doesn't add insight beyond visible text
- "spatial_contiguity: related items too far apart" — formula in one corner, explanation in another
- "modality: too much text, not enough visuals" — wall of text instead of interactive demonstration
- "personalization: too formal/robotic" — language feels like a textbook, not a professor

Be authentic to your persona. If you genuinely understand, say so (low confusion).
If you're lost, be specific about why.`,
    });

    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    let result = {
      confusion: 5,
      understanding: 'unclear',
      questions: [],
      canToolAnswer: [],
      toolSuggestion: null,
      lostAt: null,
      wouldDropOut: false
    };

    if (jsonMatch) {
      try { result = JSON.parse(jsonMatch[1].trim()); } catch {}
    }

    personaResults.push({ level, persona: persona.name, emoji: persona.emoji, ...result });
  }

  // ── Aggregate classroom feedback ──
  const avgConfusion = personaResults.reduce((s, r) => s + (r.confusion || 0), 0) / personaResults.length;

  const unansweredQuestions = personaResults.flatMap(r =>
    (r.questions || []).filter((q, i) => !(r.canToolAnswer || [])[i])
      .map(q => ({ student: r.persona, question: q }))
  );

  // Optional SVGGPT enrichment: ask the local pipeline for a candidate
  // diagram per unanswered question. Gated on env var SVGGPT_ENABLED=1
  // so no behaviour changes unless you opt in.
  if (unansweredQuestions.length) {
    try {
      const { renderFor, svggptEnabled } = await import('./svggpt-client.mjs');
      if (svggptEnabled()) {
        await Promise.all(unansweredQuestions.map(async (uq) => {
          const result = await renderFor(uq.question, { sessionId: section.id });
          if (result) uq.svggpt = { svg: result.svg, ir: result.ir };
        }));
      }
    } catch (err) {
      console.warn(`[svggpt] enrichment skipped: ${err.message}`);
    }
  }

  const toolSuggestions = personaResults
    .filter(r => r.toolSuggestion)
    .map(r => ({ student: r.persona, level: r.level, suggestion: r.toolSuggestion }));

  const anyoneDropping = personaResults.some(r => r.wouldDropOut);
  const anyoneLost = personaResults.some(r => (r.confusion || 0) >= 7);

  // Aggregate Mayer violations across all personas
  const allMayerViolations = personaResults.flatMap(r =>
    (r.mayerViolations || []).map(v => ({ student: r.persona, level: r.level, violation: v }))
  );
  // Count violations by principle
  const mayerCounts = {};
  for (const v of allMayerViolations) {
    const principle = v.violation.split(':')[0].trim();
    mayerCounts[principle] = (mayerCounts[principle] || 0) + 1;
  }

  return {
    sectionId: section.id,
    personas: personaResults,
    aggregate: {
      avgConfusion: Math.round(avgConfusion * 10) / 10,
      maxConfusion: Math.max(...personaResults.map(r => r.confusion || 0)),
      unansweredQuestions,
      toolSuggestions,
      anyoneDropping,
      anyoneLost,
      needsToolUpdate: unansweredQuestions.length > 0 || anyoneLost,
      needsNarrationRewrite: anyoneDropping || avgConfusion > 7,
      mayerViolations: allMayerViolations,
      mayerViolationCounts: mayerCounts
    }
  };
}

/**
 * Quick check — is a section pedagogically sound?
 * Returns true if all students are following along.
 */
export async function quickPedagogyCheck(framePath, narration, section) {
  const result = await simulateClassroom(framePath, narration, section);
  return {
    pass: !result.aggregate.needsToolUpdate && !result.aggregate.needsNarrationRewrite,
    avgConfusion: result.aggregate.avgConfusion,
    unansweredCount: result.aggregate.unansweredQuestions.length,
    feedback: result
  };
}
