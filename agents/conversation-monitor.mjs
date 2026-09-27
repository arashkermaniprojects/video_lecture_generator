/**
 * Conversation Monitor Agent
 *
 * Watches REAL human interactions (not simulated students) and detects:
 *   - Confusion signals in human responses
 *   - Questions the human asks that reveal gaps in the tool
 *   - Misunderstandings that the current tool layout causes
 *   - When the human keeps retrying the same section (frustration signal)
 *
 * When confusion is detected, the monitor:
 *   1. Classifies the confusion type
 *   2. Determines if the TOOL can be improved to address it
 *   3. Generates a tool evolution requirement
 *   4. Can trigger immediate tool modification mid-pipeline
 *
 * This closes the ultimate loop:
 *
 *   Tool → Lecture → Human watches → Human confused →
 *   Monitor detects → Tool evolves → Lecture re-records that section
 *
 * Confusion signals (ranked by strength):
 *
 *   STRONG signals (high confidence the human is confused):
 *   - Human says "I don't understand", "what does X mean", "confused"
 *   - Human retries same section 3+ times
 *   - Human pauses pipeline and writes feedback about a concept
 *   - Human asks a question that the narration should have answered
 *
 *   MEDIUM signals:
 *   - Human skips a section (might mean it's too hard or too easy)
 *   - Human edits narration (the explanation wasn't clear enough)
 *   - Human approves but adds a note
 *
 *   WEAK signals (monitor but don't auto-trigger):
 *   - Long pause before responding (thinking or away?)
 *   - Human approves quickly without review (trusting or not checking?)
 */

import { runAgent, parseVerdict } from '../utils/claude-agent.mjs';

// ── Confusion classification ──
export const ConfusionType = {
  CONCEPT_UNCLEAR:       'concept_unclear',       // "what IS Big-O?"
  VISUAL_MISMATCH:       'visual_mismatch',       // "which line is which?"
  NOTATION_UNKNOWN:      'notation_unknown',       // "what does Ω mean?"
  PACE_TOO_FAST:         'pace_too_fast',          // "slow down, too much at once"
  MISSING_PREREQUISITE:  'missing_prerequisite',   // "you haven't explained X yet"
  EXAMPLE_NEEDED:        'example_needed',         // "can you show a concrete case?"
  CONNECTION_MISSING:    'connection_missing',      // "how does this relate to Y?"
  TOO_ABSTRACT:          'too_abstract',            // "this is too theoretical"
  TOOL_LIMITATION:       'tool_limitation',         // the tool simply can't show this
};

export const ConfusionStrength = {
  STRONG: 'strong',   // auto-trigger tool evolution
  MEDIUM: 'medium',   // suggest tool evolution, human confirms
  WEAK:   'weak',     // log for future improvement
};

/**
 * Analyze a human's response during review for confusion signals.
 *
 * @param {object} reviewAction - The human's review action { action, feedback, ... }
 * @param {object} section - The section being reviewed
 * @param {object} conversationHistory - Previous interactions for context
 * @returns {object} Confusion analysis
 */
export async function analyzeHumanResponse(reviewAction, section, conversationHistory = []) {
  // ── Pattern-based quick detection ──
  const quickSignals = detectQuickSignals(reviewAction, section, conversationHistory);

  if (quickSignals.length === 0 && reviewAction.action === 'approve' && !reviewAction.feedback) {
    // Clean approval, no confusion detected
    return { confused: false, signals: [], suggestions: [] };
  }

  // ── Deep analysis with Claude ──
  const analysis = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 1024,
    systemPrompt: `You are a teaching assistant monitoring a lecture production session.
A human instructor is reviewing sections of a video lecture about algorithms and
asymptotic notation. Your job: detect if the human is confused about the CONTENT
being taught, and if so, determine what change to the interactive tool would help.

Important distinctions:
- Production issues (bad audio, wrong screenshot) are NOT confusion — they're technical
- Content confusion (doesn't understand the concept) IS what we're looking for
- The human might be confused as a STUDENT would be, or they might be noting that
  the explanation wouldn't work for students — both count

Output JSON:
\`\`\`json
{
  "confused": true/false,
  "confusionType": "concept_unclear|visual_mismatch|notation_unknown|pace_too_fast|missing_prerequisite|example_needed|connection_missing|too_abstract|tool_limitation",
  "strength": "strong|medium|weak",
  "whatTheyDontUnderstand": "specific concept or element",
  "canToolHelp": true/false,
  "toolSuggestion": {
    "type": "add_feature|add_animation|add_interaction|modify_view|add_scaffold|add_label|add_example",
    "description": "what to add/change in the tool",
    "reason": "how this addresses the confusion"
  } or null,
  "narrationSuggestion": "how to rewrite the narration to be clearer" or null
}
\`\`\``,

    userMessage: `Analyze this human interaction during lecture review:

Section: ${section.id}
Narration: "${section.narration.substring(0, 300)}..."
Human action: ${reviewAction.action}
Human feedback: "${reviewAction.feedback || '(none)'}"

Quick signal detection found: ${JSON.stringify(quickSignals)}

Previous interactions in this session:
${conversationHistory.slice(-5).map(h =>
  `  Section ${h.sectionId}: action=${h.action}, feedback="${h.feedback || ''}"`
).join('\n') || '  (none)'}

Is the human confused about the CONTENT? Should we modify the tool?`
  });

  const result = parseVerdict(analysis.text) || {
    confused: quickSignals.length > 0,
    confusionType: quickSignals[0]?.type || null,
    strength: quickSignals[0]?.strength || 'weak',
    canToolHelp: false,
    toolSuggestion: null
  };

  return {
    ...result,
    quickSignals,
    sectionId: section.id,
    timestamp: new Date().toISOString()
  };
}

/**
 * Fast pattern-based confusion detection (no API call).
 */
function detectQuickSignals(reviewAction, section, history) {
  const signals = [];
  const feedback = (reviewAction.feedback || '').toLowerCase();

  // ── Strong signals ──

  // Explicit confusion language
  const confusionPhrases = [
    'don\'t understand', 'dont understand', 'confused', 'what does',
    'what is', 'makes no sense', 'unclear', 'lost', 'huh',
    'what do you mean', 'i don\'t get', 'explain', 'too fast',
    'wait', 'hold on', 'go back'
  ];
  for (const phrase of confusionPhrases) {
    if (feedback.includes(phrase)) {
      signals.push({
        type: ConfusionType.CONCEPT_UNCLEAR,
        strength: ConfusionStrength.STRONG,
        trigger: `Human said: "${phrase}"`
      });
      break;
    }
  }

  // Repeated retries on same section
  const sectionRetries = history.filter(h =>
    h.sectionId === section.id && h.action === 'retry'
  ).length;
  if (sectionRetries >= 2) {
    signals.push({
      type: ConfusionType.TOOL_LIMITATION,
      strength: ConfusionStrength.STRONG,
      trigger: `Section retried ${sectionRetries} times`
    });
  }

  // ── Medium signals ──

  // Human edits narration
  if (reviewAction.action === 'edit_narration') {
    signals.push({
      type: ConfusionType.CONCEPT_UNCLEAR,
      strength: ConfusionStrength.MEDIUM,
      trigger: 'Human chose to edit narration'
    });
  }

  // Human skips (might be too hard)
  if (reviewAction.action === 'skip' && feedback) {
    signals.push({
      type: ConfusionType.PACE_TOO_FAST,
      strength: ConfusionStrength.MEDIUM,
      trigger: 'Human skipped with feedback'
    });
  }

  // Questions about notation
  const notationPhrases = ['omega', 'theta', 'big-o', 'small-o', 'notation', 'symbol', 'Ω', 'Θ'];
  for (const phrase of notationPhrases) {
    if (feedback.includes(phrase) && (feedback.includes('what') || feedback.includes('?'))) {
      signals.push({
        type: ConfusionType.NOTATION_UNKNOWN,
        strength: ConfusionStrength.MEDIUM,
        trigger: `Question about notation: "${phrase}"`
      });
      break;
    }
  }

  // Asking for examples
  const examplePhrases = ['example', 'show me', 'what if', 'like what', 'such as', 'for instance'];
  for (const phrase of examplePhrases) {
    if (feedback.includes(phrase)) {
      signals.push({
        type: ConfusionType.EXAMPLE_NEEDED,
        strength: ConfusionStrength.MEDIUM,
        trigger: `Human asking for example: "${phrase}"`
      });
      break;
    }
  }

  return signals;
}

/**
 * Track conversation history and accumulate confusion patterns.
 * Detects systemic issues (e.g., "every proof section confuses the human").
 */
export class ConversationTracker {
  constructor() {
    this.history = [];
    this.confusionLog = [];
    this.sectionRetries = {};  // sectionId → count
  }

  recordInteraction(sectionId, action, feedback = '') {
    this.history.push({
      sectionId,
      action,
      feedback,
      timestamp: new Date().toISOString()
    });

    if (action === 'retry') {
      this.sectionRetries[sectionId] = (this.sectionRetries[sectionId] || 0) + 1;
    }
  }

  recordConfusion(analysis) {
    if (analysis.confused) {
      this.confusionLog.push(analysis);
    }
  }

  /**
   * Detect systemic patterns across multiple sections.
   * Returns grouped tool evolution requirements.
   */
  async detectSystemicIssues() {
    if (this.confusionLog.length < 2) return null;

    const result = await runAgent({
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1024,
      systemPrompt: `You analyze patterns in student confusion across a lecture.
Given a log of confusion events, identify SYSTEMIC issues — problems that
affect multiple sections and suggest a single tool change that would fix
several sections at once.

For example: if the human is confused about notation in sections 3, 6, 7, and 8,
the systemic fix might be "add a persistent notation reference sidebar."

Output JSON:
\`\`\`json
{
  "systemicIssues": [
    {
      "pattern": "description of the recurring problem",
      "affectedSections": ["section_ids"],
      "rootCause": "why this keeps happening",
      "toolFix": {
        "type": "add_feature|modify_view|add_scaffold",
        "description": "one change that fixes all affected sections",
        "priority": "critical|important|nice-to-have"
      }
    }
  ]
}
\`\`\``,

      userMessage: `Analyze these confusion events for systemic patterns:

${JSON.stringify(this.confusionLog, null, 2)}

Section retry counts: ${JSON.stringify(this.sectionRetries)}

Total interactions: ${this.history.length}
Total confusions: ${this.confusionLog.length}`
    });

    return parseVerdict(result.text);
  }

  getHistory() { return this.history; }
  getConfusionLog() { return this.confusionLog; }
}
