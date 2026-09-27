/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  PERMANENT FIXES — do not revert these without understanding why ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  1. Score=0 on wrong tab (correct_tab=false). Old inspector      ║
 * ║     allowed wrong-tab sections to pass, producing a lecture      ║
 * ║     that showed only the notations tab throughout.               ║
 * ║                                                                  ║
 * ║  2. text_readable is a hard-fail (triggers retry). Old code      ║
 * ║     only used it as a warning. Axis labels were unreadably small ║
 * ║     and the inspector passed them anyway.                        ║
 * ║                                                                  ║
 * ║  3. Pass condition: correct_tab AND text_readable AND            ║
 * ║     content_matches AND right_panel_active must ALL be true.     ║
 * ║                                                                  ║
 * ║  4. space_utilized check (2026-03-23): Flags large empty areas   ║
 * ║     and text below ~15px in the right panel. Deducts 15 pts      ║
 * ║     but does NOT hard-fail — it's a quality signal, not a gate.  ║
 * ║                                                                  ║
 * ║  5. narration_ui_match (2026-03-24): Hard-fail if the narration  ║
 * ║     says "worst case" but the UI shows "Best Case" highlighted,  ║
 * ║     or if SVG text labels overflow their containing circles.     ║
 * ║     This catches case-button mismatch + text-outside-boundary.   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

/**
 * Unified Quality Inspector
 *
 * A single inspector that checks ALL quality requirements together.
 * Runs after each section is recorded to ensure nothing is missing.
 *
 * Checklist (ALL must pass):
 *   1. Correct tab is active (matches section's group)
 *   2. Text is readable (not too small)
 *   3. Pointer/cursor is visible
 *   4. Formulas/legends below charts are visible
 *   5. Content matches narration topic
 *   6. Right panel is not empty
 *   7. No rendering artifacts
 */

import { claudeVision } from '../utils/claude-agent.mjs';

/**
 * Run unified quality inspection on a recorded section.
 *
 * @param {string} framePath - Path to captured frame (use middle frame for live recordings)
 * @param {object} section - Section definition
 * @returns {object} { pass, score, issues[], checklist }
 */
export async function inspectSection(framePath, section) {
  // Determine expected tab from navActions
  const tabAction = (section.navActions || []).find(a => a.action === 'click_tab');
  const _TAB_TEXT_TO_MOD = {
    // Asymptotic Notation Explorer
    'notation guide': 'notations', 'notations': 'notations',
    'iterative analysis': 'iterative', 'iterative': 'iterative',
    'recursive analysis': 'recursive', 'recursive': 'recursive',
    'proof builder': 'prover', 'prover': 'prover',
    'challenge mode': 'challenge', 'challenge': 'challenge',
    // RLHF Interactive Lecture
    'pipeline': '0', 'reward model': '1', 'ppo': '2',
    'kl divergence': '3', 'dpo vs rlhf': '4',
    // Recurrence Relations Explorer
    'recursion tree': 'tree', 'master theorem': 'master', 'substitution': 'sub',
  };
  const _EL_TO_TAB = {
    // Asymptotic Notation Explorer
    '#challenge-content': 'challenge', '.quiz-option': 'challenge',
    '#svg-iterative': 'iterative', '#svg-recursive': 'recursive',
    '#proof-content': 'prover',
    // RLHF Interactive Lecture
    '#pipelineSvg': '0', '#rmSvg': '1', '#ppoSvg': '2',
    '#ppoFrontierSvg': '2', '#klOverlaySvg': '3', '#dpoSvg': '4',
    // Recurrence Relations Explorer
    '#treeSVG': 'tree', '#masterViz': 'master', '#subViz': 'sub',
    '#simSVG': 'tree', '#treeSummary': 'tree',
  };
  const _GROUP_TO_MOD = {
    pipeline: '0', 'reward-model': '1', reward_model: '1', reward: '1',
    ppo: '2', 'kl-divergence': '3', kl: '3', 'dpo-vs-rlhf': '4', dpo: '4',
    prologue: '0', epilogue: '0', theory: '0', comparison: '4',
    // Recurrence Relations Explorer
    tree: 'tree', 'recursion-tree': 'tree', 'recursion_tree': 'tree',
    master: 'master', 'master-theorem': 'master',
    sub: 'sub', substitution: 'sub',
  };
  const _inferredFromEl = !tabAction
    ? Object.entries(_EL_TO_TAB).find(([el]) =>
        (section.expectedElements || []).includes(el) ||
        (section.navActions || []).some(a => a.target === el)
      )?.[1] ?? null
    : null;
  const expectedTab = tabAction?.target
    || (tabAction?.text ? _TAB_TEXT_TO_MOD[tabAction.text.toLowerCase()] : null)
    || _inferredFromEl
    || _GROUP_TO_MOD[section.group]
    || section.group
    || 'notations';

  const tabNameMap = {
    // Asymptotic Notation Explorer
    notations: 'Notation Guide',
    iterative: 'Iterative Analysis',
    recursive: 'Recursive Analysis',
    prover: 'Proof Builder',
    challenge: 'Challenge Mode',
    // RLHF Interactive Lecture
    '0': 'Pipeline',
    '1': 'Reward Model',
    '2': 'PPO',
    '3': 'KL Divergence',
    '4': 'DPO vs RLHF',
    // Recurrence Relations Explorer
    'tree': 'Recursion Tree',
    'master': 'Master Theorem',
    'sub': 'Substitution',
  };

  // Infer expected case from section ID (NOT narration — narration mentions other
  // cases tangentially, e.g. "best case" section says "the worst case is different",
  // causing false matches). Only the section ID reliably indicates the section's topic.
  const INSPECTOR_CASE_MAP = {
    'linear_search_best':         'Best Case',
    'linear_search_worst':        'Worst Case',
    'binary_search_power':        'Best Case',
    'logarithmic_beauty':         'Best Case',
    'bubble_sort_tragedy':        'Worst Case',
    'quadratic_scaling':          'Worst Case',
    'insertion_sort_adaptive':    'Best Case',
    'selection_sort_consistency': 'Sorted',
  };
  let expectedCase = null;
  if (expectedTab === 'iterative') {
    const sectionId = section.id || '';
    for (const [key, caseName] of Object.entries(INSPECTOR_CASE_MAP)) {
      if (sectionId.includes(key)) { expectedCase = caseName; break; }
    }
    // Fallback: section ID keywords
    if (!expectedCase) {
      if (sectionId.includes('_worst'))        expectedCase = 'Worst Case';
      else if (sectionId.includes('_best'))    expectedCase = 'Best Case';
      else if (sectionId.includes('_average')) expectedCase = 'Average Case';
    }
  }

  const text = await claudeVision({
    imagePath: framePath,
    textPrompt: `You are a STRICT quality inspector for a lecture video. Reject anything that would confuse students.

SECTION: ${section.id}
EXPECTED TAB: "${tabNameMap[expectedTab] || expectedTab}" (data-mod="${expectedTab}")
NARRATION TOPIC: "${section.narration?.substring(0, 200)}"
${expectedCase ? `EXPECTED CASE BUTTON: "${expectedCase}" must be highlighted/active on screen` : ''}

CHECK EACH ITEM carefully (true/false):

1. CORRECT_TAB: Is the "${tabNameMap[expectedTab] || expectedTab}" tab highlighted/active in the top tab bar?
   - The tab bar may have 3-5 tabs. Common layouts:
     "Notation Guide" | "Iterative Analysis" | "Recursive Analysis" | "Proof Builder" | "Challenge Mode"
     OR: "Pipeline" | "Reward Model" | "PPO" | "KL Divergence" | "DPO vs RLHF"
     OR: "Recursion Tree" | "Master Theorem" | "Substitution"
   - For the Recurrence Relations tool: if the INTRO section is expanded (the "Welcome — Start Here" section at the top), the section may be showing intro text ABOVE the tab bar. In this case, the tab is still "Recursion Tree" (default active). Intro sections showing text about "What is a Recurrence Relation", "Why Do We Care", learning path, or complexity table are valid even though the tab area may be partially scrolled out of view.
   - A tab is active when it has a visually distinct highlighted/selected background.
   - If the Theory/Background section is shown expanded (full page of text), check if that's what the section expects. If the section expects an interactive tab but the theory page is showing, this is FALSE.
   - If ANY other tab in the top bar is highlighted instead of the expected one, this is FALSE.

2. TEXT_READABLE: Can students read the axis numbers, tick labels, and chart legends without squinting?
   - Axis numbers (like 0, 5, 10, 100) must be clearly legible, not tiny specks.
   - If axis tick labels are smaller than 12px equivalent or hard to read at normal viewing distance, this is FALSE.
   - If the text color is too close to the background and the words visually blend in, this is FALSE even if the font size is acceptable.

3. POINTER_VISIBLE: Is there a red cursor/pointer dot visible on screen?

4. FORMULAS_VISIBLE: Are formulas, equations, or chart legends fully visible (not cut off at edges)?

5. CONTENT_MATCHES: Does the visual content shown relate to what the narration topic discusses?
   ${expectedCase && expectedCase !== 'any active' ? `- CRITICAL: The narration discusses "${expectedCase}". If a DIFFERENT case button is highlighted (e.g. narration says "worst case" but "Best Case" button is active), this is FALSE.
   - A case mismatch directly misleads students — they hear about one scenario while seeing another.` : ''}

6. RIGHT_PANEL_ACTIVE: Is the right panel showing a graph, chart, or substantive content (not empty/blank)?

7. NO_ARTIFACTS: Is the rendering clean with no broken layouts or overlapping elements?

8. SPACE_UTILIZED: Is the available screen space used effectively?
   - If the bottom 30%+ of the right panel is blank/empty white space with no text or chart content, this is FALSE.
   - Explanation text (formal definition, intuition sentences) should be large enough to read comfortably from 60cm viewing distance — roughly 15px+ equivalent. Tiny 10-12px text in a large panel is FALSE.
   - A chart that occupies less than 30% of the panel height while leaving large empty areas is also FALSE.
   - If text fills the space but is just appropriately sized, this is TRUE.

9. TOOLS_USED: Were ALL interactive tool features actually engaged? Check per tab:
   - Iterative Analysis tab: ALL of these must be true:
     (a) A case button (Best Case / Worst Case / Average Case / Sorted / Reversed / Random etc.) must be visually highlighted with a blue border AND colored text — the active case is clearly selected.
     ${expectedCase ? `IMPORTANT: The highlighted case button MUST be "${expectedCase}". If a different case is highlighted, this is FALSE even if a case IS selected.` : ''}
     (b) The array visualization must show actual colored bars/elements (not a grey empty placeholder).
     (c) The growth curve/chart must be populated (not "Select an algorithm to begin").
     If the case selector shows NO highlighted button, or the WRONG case is highlighted, or the chart is empty, this is FALSE.
   - Recursive Analysis tab: ALL of these must be true:
     (a) The recursion tree MUST show the FULLY EXPANDED tree with ALL levels visible — at least 3-4 levels of nodes (root + children + grandchildren + deeper). A tree showing only the root node, or only 1-2 levels, means the "Animate All" button was NOT clicked or the animation was reset. This is a CRITICAL failure.
     (b) The tree nodes must be colored/styled circles with labels inside them (like "fib(5)", "T(n)", numbers). Plain text without circles means broken rendering.
     (c) The level/nodes/work summary table on the right must show data rows with numbers (not empty, not "Select an algorithm").
     (d) For fibonacci specifically: the tree should show the characteristic double-branching pattern where each node has two children (fib(n-1) and fib(n-2)).
     If only the root is visible, or only 1-2 levels are shown, or the SVG area is mostly empty, this is FALSE — the animation did NOT play.
   - Proof Builder tab: ALL of these must be true:
     (a) The proof dropdown ("Choose a Proof") must show a selected proof name (NOT "— select —").
     (b) The right panel must show a populated graph/chart for the selected proof (not "← Select a proof to see the graph").
     (c) At least one proof step with actual mathematical notation (inequalities, asymptotic bounds) must be visible in the left panel below the dropdown.
     If the dropdown still says "— select —" or the right panel is empty/dark, this is FALSE.
   - Challenge Mode tab: The challenge question area must show at least one question with multiple-choice options. If only a blank or "loading" state is shown, this is FALSE.
   - Notation Guide tab: A notation card must be selected/highlighted. Always TRUE if a card is visible.
   - Recursion Tree tab (Recurrence Relations Explorer): Check these:
     (a) An algorithm preset must be selected (shown in the algorithm info card with name and complexity badge).
     (b) If the section involves animation: the recursion tree SVG must show a FULLY EXPANDED tree with multiple levels visible (not just "Click Play or Step to build the tree"). At least 3+ levels of nodes must be visible.
     (c) The stats area should show populated values for Levels, Total Nodes, Branching, Complexity (not all dashes "—").
     (d) EXCEPTION: For INTRO/PROLOGUE sections (sections about "What is a Recurrence", "Why Do We Care", "How to Use", "Learning Path", "Complexity Table"), the intro text section is the focus — tools_used is TRUE if the intro text content is visible and readable, even if no tree animation is shown.
   - Master Theorem tab (Recurrence Relations Explorer): Check these:
     (a) The parameters a, b, k must be set to non-default values OR a quick example button must have been clicked.
     (b) The comparison bar must show log_b(a) vs k with actual numeric values (not "—").
     (c) One of the three case cards (Case 1, 2, or 3) must be highlighted/active with a green border.
     (d) The result badge at the bottom must show a Theta(...) result.
   - Substitution tab (Recurrence Relations Explorer): Check these:
     (a) An example must be selected from the dropdown (shown by the title above the steps).
     (b) At least one step card must be revealed/expanded (showing mathematical content, not all collapsed).
     (c) The progress indicator should show advancement (not "0 / 6").

10. CHART_NOT_CLIPPED: Is the chart/graph fully visible without being clipped at the edges?
    - In Iterative Analysis: the growth curve and bars must fit within the chart container. If bars or curve points are visibly cut off at the right or bottom edge, this is FALSE.
    - In Recursive Analysis: the recursion tree nodes must not be cut off. If nodes are partially hidden or extend beyond the visible SVG boundary, this is FALSE.
    - In Proof Builder: the proof graph must fully show the function curves without clipping.
    - In Recursion Tree: tree nodes must not be cut off at edges of the SVG area.
    - In Master Theorem: the comparison bar, case cards, and result badge must be fully visible.
    - In Substitution: the step cards and math blocks must be fully visible.
    - Other tabs: TRUE by default.

11. MODULE_COMPLETE: Is the focused module/subsection shown COMPLETELY and READABLY within the viewport?
    - If the content being discussed is partially cut off at the bottom or top, this is FALSE.
    - If the screen shows multiple unrelated subsections crammed together with tiny text, this is FALSE.
    - If there is excessive empty space around a small module (module doesn't fill viewport), this is FALSE.
    - If text appears too small to read comfortably (body text smaller than ~14px apparent), this is FALSE.
    - If a single focused module fills the viewport at readable size, this is TRUE.
    - For theory/text sections: only ONE subsection heading and its content should be visible, not the entire theory page.
    - For interactive tabs: the visualization should fill most of the viewport, not be tiny with empty space around it.

12. NO_SCREEN_JUMP: Is the view stable throughout the section? If the zoom level, scroll position,
    or visible module changes abruptly mid-section (causing a visible jump), this is FALSE.
    A section should show ONE stable view from start to finish. Animations within the module
    (charts updating, bars moving) are fine — but the viewport framing itself must not jump.

INTERACTION_VISIBLE: For interactive tab sections, has something actually CHANGED from the default state?
    - If the screen shows the exact default/initial state of the tab (empty charts, default slider values,
      no selections made), this is FALSE — the section failed to demonstrate anything.
    - If a chart has data, a selection is highlighted, a slider has moved from default, or an animation
      has played, this is TRUE.
    - For theory sections: N/A (default TRUE).

TOOL_COMPLETENESS: For interactive tab sections (not theory), is the ENTIRE tool visible?
    - Both the left control panel AND the right visualization panel must be fully visible.
    - If the view is zoomed into only one panel (e.g., just stat pills, or just the SVG), FALSE.
    - If any part of the tool is cut off at the edges (buttons clipped, chart truncated), FALSE.
    - The tool should be shown at 1x scale with both panels complete.
    - For theory sections: this check is N/A (theory modules are isolated by design).

13. TEXT_IN_BOUNDS: Are ALL text labels fully contained within their visual boundaries?
    - In Recursive Analysis: every label inside a tree node circle (like "fib(5)", "T(8)", "n=4") must fit INSIDE the circle boundary. If text visibly extends past the circle's edge, this is FALSE.
    - In Iterative Analysis: array bar labels must fit within or directly above their bars.
    - In all tabs: subtitle text at the bottom must not be cut off at the left/right edges.
    - If any text is partially hidden, clipped, or overflows its container, this is FALSE.
    - If all text is properly contained, this is TRUE.

## MAYER'S MULTIMEDIA LEARNING PRINCIPLES (evaluate each)

M1. COHERENCE: Is the screen free of extraneous content?
    - Only the module being discussed should be visible. No unrelated subsections, tabs, or UI elements competing for attention.
    - If more than one conceptual unit is visible (e.g., multiple theory subsections), FALSE.
    - A clean focused view of one module = TRUE.

M2. SIGNALING: Is there a clear visual cue pointing to what the narration discusses?
    - A cursor/pointer, highlight, active state, or color emphasis on the relevant element.
    - If the narration discusses "the reward gap" but nothing on screen indicates WHERE the gap is, FALSE.

M3. SPATIAL_CONTIGUITY: Are related text and visuals near each other?
    - If a formula is discussed, both the formula and its explanation should be visible together.
    - If labels are far from their charts, or the relevant content is split across distant screen areas, FALSE.

M4. TEMPORAL_CONTIGUITY: Does the visual match the narration topic RIGHT NOW?
    - Compare the narration text with what's currently shown on screen.
    - If narration says "watch the reward climb" but the chart is empty/not yet running, FALSE.
    - If narration discusses one stage but the screen shows a different stage, FALSE.
    - This is the most critical Mayer principle — mismatch here directly confuses students.

M5. SEGMENTING: Is this section focused on ONE concept/demonstration?
    - Each section should cover one idea, one experiment, or one formula — not multiple topics crammed together.
    - If the narration jumps between unrelated topics within this single frame, FALSE.

M6. PRETRAINING: Are all terms visible on screen already defined?
    - Check formulas and labels for undefined abbreviations (SFT, PPO, KL, DPO, etc.).
    - If a formula uses symbols that haven't been explained by this point in the lecture, FALSE.
    - Early sections (first 5) should define terms; later sections can assume them.

M7. MODALITY: Is information presented as narration + visuals (not text-heavy slides)?
    - The visual should show diagrams, charts, formulas, or interactive elements — not walls of paragraph text.
    - If the screen is mostly dense paragraph text that the narration reads aloud, FALSE.
    - Interactive tool visuals + spoken explanation = TRUE.

M8. MULTIMEDIA: Are both words (narration) and pictures (visuals) present?
    - A blank/empty screen with only narration = FALSE.
    - Narration over a relevant visual = TRUE.

M9. PERSONALIZATION: Is the narration conversational, not robotic or overly formal?
    - Based on the subtitle text visible: does it sound like a professor talking to students?
    - Jargon-heavy sentences with no plain-language explanation = FALSE.
    - "Here's the beautiful thing..." or "Think about it this way..." = TRUE.

M10. VOICE: Is the voice natural? (Cannot judge from screenshot — default TRUE unless subtitle text suggests robotic phrasing.)

M11. REDUNDANCY: Is the narration ADDING to the visual, not just reading on-screen text verbatim?
     - If the subtitle is a word-for-word copy of text visible on screen, FALSE.
     - Narration should explain WHY or give examples; the visual shows WHAT.
     - Brief label references are OK; paragraph-length verbatim reads are not.

M12. IMAGE: N/A for this format (no talking head). Default TRUE.

SCORING RULES (be strict):
- If correct_tab is FALSE: score = 0. Full stop. Wrong tab is an automatic zero.
- If text_readable is FALSE: score cannot exceed 40.
- If right_panel_active is FALSE: score cannot exceed 50.
- If tools_used is FALSE: score cannot exceed 55.${expectedCase ? `\n- If the narration says "${expectedCase}" but a DIFFERENT case is highlighted: score cannot exceed 30.` : ''}
- If module_complete is FALSE: score cannot exceed 50.
- If TEMPORAL_CONTIGUITY is FALSE: score cannot exceed 40. Visual-narration mismatch is critical.
- If COHERENCE is FALSE: score cannot exceed 55. Extraneous content distracts.
- If SIGNALING is FALSE: deduct 15 points.
- If SPATIAL_CONTIGUITY is FALSE: deduct 10 points.
- If PRETRAINING is FALSE: deduct 15 points.
- If REDUNDANCY is FALSE: deduct 5 points.
- If SEGMENTING is FALSE: deduct 10 points.
- If MODALITY is FALSE: deduct 10 points.
- If chart_not_clipped is FALSE: score cannot exceed 65.
- If text_in_bounds is FALSE: deduct 20 points.
- If space_utilized is FALSE: deduct 15 points.
- Otherwise score 0-100 based on overall quality.

Output JSON:
\`\`\`json
{
  "checklist": {
    "correct_tab": true/false,
    "text_readable": true/false,
    "pointer_visible": true/false,
    "formulas_visible": true/false,
    "content_matches": true/false,
    "right_panel_active": true/false,
    "no_artifacts": true/false,
    "space_utilized": true/false,
    "tools_used": true/false,
    "module_complete": true/false,
    "no_screen_jump": true/false,
    "chart_not_clipped": true/false,
    "text_in_bounds": true/false
  },
  "mayer": {
    "coherence": true/false,
    "signaling": true/false,
    "spatial_contiguity": true/false,
    "temporal_contiguity": true/false,
    "segmenting": true/false,
    "pretraining": true/false,
    "modality": true/false,
    "multimedia": true/false,
    "personalization": true/false,
    "voice": true,
    "redundancy": true/false,
    "image": true
  },
  "score": 0-100,
  "issues": ["description of each failed check"],
  "mayer_violations": ["principle: description"],
  "pass": true/false
}
\`\`\`

A section PASSES only if ALL of these are true: correct_tab AND text_readable AND content_matches AND right_panel_active AND tools_used AND chart_not_clipped AND text_in_bounds AND temporal_contiguity.
If correct_tab is false, ALWAYS set pass=false and score=0.`,
  });

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);

  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {}
  }

  // Fallback
  return {
    checklist: {},
    score: 50,
    issues: ['Could not parse inspection result'],
    pass: false
  };
}

/**
 * Quick check — is the correct tab showing?
 * Faster than full inspection, used for pre-recording validation.
 */
export async function checkTab(page, expectedTab) {
  const activeTab = await page.evaluate(() => {
    const active = document.querySelector('.tab.active');
    return active?.getAttribute('data-mod') || 'unknown';
  });
  return activeTab === expectedTab;
}
