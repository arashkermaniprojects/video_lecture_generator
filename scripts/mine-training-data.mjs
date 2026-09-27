#!/usr/bin/env node
//
// mine-training-data.mjs
//
// Walks every runs/run_*/state.json plus the curated golden configs in
// config/, and emits JSONL training files for each task category the
// lecture pipeline uses. Output goes to data/train/. Holds out 10%
// of each split as validation under data/train/_validation/.
//
// Each output line is OpenAI chat-completions format with system, user,
// assistant messages.
//
// Output files:
//   data/train/section_planning.jsonl
//   data/train/narration_rewrite.jsonl
//   data/train/frame_qa_verdict.jsonl
//   data/train/tool_qa_fix.jsonl
//   data/train/_validation/<same names>
//   data/stats.txt
//
// Run: node scripts/mine-training-data.mjs

import { readFile, readdir, writeFile, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ── paths ────────────────────────────────────────────────────────────────
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = join(REPO, 'runs');
const CONFIG_DIR = join(REPO, 'config');
const OUT_DIR = join(REPO, 'data', 'train');
const VAL_DIR = join(OUT_DIR, '_validation');
const STATS_FILE = join(REPO, 'data', 'stats.txt');

await mkdir(OUT_DIR, { recursive: true });
await mkdir(VAL_DIR, { recursive: true });

// ── helpers ──────────────────────────────────────────────────────────────

function safeJSONParse(buf) {
  try { return JSON.parse(buf); } catch { return null; }
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function listRunStateFiles() {
  const out = [];
  if (!existsSync(RUNS_DIR)) return out;
  for (const name of await readdir(RUNS_DIR)) {
    const sj = join(RUNS_DIR, name, 'state.json');
    if (existsSync(sj)) out.push(sj);
  }
  return out;
}

async function listCuratedConfigs() {
  const out = [];
  if (!existsSync(CONFIG_DIR)) return out;
  for (const name of await readdir(CONFIG_DIR)) {
    if (!name.endsWith('.json')) continue;
    if (name === 'sections.json') continue;        // generated, not curated
    if (name === 'test-1min-recurrence.json') continue; // our test
    out.push(join(CONFIG_DIR, name));
  }
  return out;
}

function dedupeSections(sections) {
  const seen = new Set();
  const out = [];
  for (const s of sections) {
    if (!s || !s.id) continue;
    const k = s.id + '|' + (s.narration || '').slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function makeChatExample(systemPrompt, userMessage, assistantMessage) {
  return JSON.stringify({
    messages: [
      { role: 'system',    content: systemPrompt },
      { role: 'user',      content: userMessage },
      { role: 'assistant', content: assistantMessage }
    ]
  });
}

async function writeSplit(name, lines) {
  if (lines.length === 0) return { train: 0, val: 0 };
  // Deterministic shuffle by hashing line content (so re-runs are stable)
  const indexed = lines.map((line, i) => ({ line, hash: hashString(line + ':' + i) }));
  indexed.sort((a, b) => a.hash - b.hash);
  const split = Math.max(1, Math.floor(indexed.length * 0.10));
  const valLines = indexed.slice(0, split).map(x => x.line);
  const trainLines = indexed.slice(split).map(x => x.line);
  await writeFile(join(OUT_DIR, name), trainLines.join('\n') + (trainLines.length ? '\n' : ''));
  await writeFile(join(VAL_DIR, name), valLines.join('\n') + (valLines.length ? '\n' : ''));
  return { train: trainLines.length, val: valLines.length };
}

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// ── system prompts (must mirror what the live agents send) ───────────────

const SECTION_PLANNING_SYSTEM = `You are the section planner for a video lecture pipeline. Given a description of an interactive HTML educational tool — its tabs, buttons, sliders, and identifiable elements — produce a JSON array of teaching sections that walk a viewer through the tool. Each section has: id, group, narration (3-5 spoken sentences), navActions (clicks, scrolls, cursor moves on the page), and expectedElements (CSS selectors that must be visible during this section). Output strict JSON inside a \`\`\`json fenced block.`;

const NARRATION_REWRITE_SYSTEM = `You rewrite narration for a section of a video lecture so a confused student can understand it. You will be given the current narration plus specific student feedback (what confused them, what questions they had). Output ONLY the new narration as plain text — no preamble, no quotes, no list. Match the original speaking length within ±20%.`;

const FRAME_QA_SYSTEM = `You are a visual QA inspector for a video lecture frame. Given a section's metadata (expected tab, narration topic, expected elements) and a screenshot, produce a JSON checklist with 9 boolean fields: correct_tab, text_readable, pointer_visible, formulas_visible, content_matches, right_panel_active, no_artifacts, space_utilized, tools_used. Output strict JSON inside a \`\`\`json fenced block.`;

const TOOL_QA_FIX_SYSTEM = `You fix issues in an interactive HTML educational tool. Given the current HTML and a list of QA issues, output the COMPLETE corrected HTML file. Preserve all existing functionality and CSS class names — they're referenced by external scripts.`;

// ── source 1: curated golden configs ─────────────────────────────────────

async function mineCuratedConfigs() {
  const examples = [];
  const configs = await listCuratedConfigs();

  for (const path of configs) {
    const data = await readJsonOrNull(path);
    if (!data) continue;
    const sections = Array.isArray(data) ? data : data.sections;
    if (!Array.isArray(sections) || sections.length === 0) continue;

    // Synthesize a "tool description" from the unique nav targets in these sections
    const toolPath = data.lecture?.toolPath || basename(path).replace('.json', '.html');
    const tabs = new Set();
    const buttons = new Set();
    const ids = new Set();
    for (const s of sections) {
      for (const a of s.navActions || []) {
        if (a.action === 'click_tab') tabs.add(a.target || a.text);
        if (a.action === 'click_button' && a.text) buttons.add(a.text);
        if (a.target && a.target.startsWith('#')) ids.add(a.target);
      }
    }

    const toolDesc = JSON.stringify({
      toolPath,
      tabs: Array.from(tabs).filter(Boolean),
      buttons: Array.from(buttons),
      ids: Array.from(ids).slice(0, 40),
    }, null, 2);

    // Build the assistant output: the sections array trimmed to the fields the planner produces
    const cleanSections = sections.map(s => ({
      id: s.id,
      group: s.group,
      narration: s.narration,
      navActions: s.navActions,
      expectedElements: s.expectedElements,
      focusTarget: s.focusTarget,
      isAnimated: s.isAnimated || false,
    })).filter(s => s.id && s.narration);

    const userMessage = `Plan a video lecture for this interactive HTML tool. Walk a viewer through every important feature in pedagogical order.\n\nTOOL DESCRIPTION:\n${toolDesc}`;
    const assistantMessage = '```json\n' + JSON.stringify({ sections: cleanSections }, null, 2) + '\n```';

    examples.push(makeChatExample(SECTION_PLANNING_SYSTEM, userMessage, assistantMessage));
  }

  return examples;
}

// ── source 2: passed sections from runs/ ─────────────────────────────────

async function mineRunSections() {
  const all = [];
  const stateFiles = await listRunStateFiles();

  for (const sf of stateFiles) {
    const state = await readJsonOrNull(sf);
    if (!state) continue;
    const sections = state.sections || [];
    for (const s of sections) {
      if (s.status !== 'qa_pass' && s.status !== 'approved') continue;
      if (!s.narration || !s.navActions) continue;
      all.push({ section: s, run: dirname(sf) });
    }
  }

  return all;
}

// ── output 1: section_planning examples ─────────────────────────────────
// Two flavors:
//   (a) whole-config: input = tool description, output = full sections array.
//       Few examples (one per config) but they teach overall structure.
//   (b) autoregressive: input = tool description + first N sections,
//       output = section N+1. Many examples per config; teaches narration
//       style, navAction conventions, and pacing.

async function buildSectionPlanning() {
  const wholeConfig = await mineCuratedConfigs();
  const autoregressive = await mineCuratedConfigsAutoregressive();
  return [...wholeConfig, ...autoregressive];
}

async function mineCuratedConfigsAutoregressive() {
  const examples = [];
  const configs = await listCuratedConfigs();

  for (const path of configs) {
    const data = await readJsonOrNull(path);
    if (!data) continue;
    const sections = Array.isArray(data) ? data : data.sections;
    if (!Array.isArray(sections) || sections.length < 2) continue;

    const toolPath = data.lecture?.toolPath || basename(path).replace('.json', '.html');
    const tabs = new Set();
    const buttons = new Set();
    const ids = new Set();
    for (const s of sections) {
      for (const a of s.navActions || []) {
        if (a.action === 'click_tab') tabs.add(a.target || a.text);
        if (a.action === 'click_button' && a.text) buttons.add(a.text);
        if (a.target && a.target.startsWith('#')) ids.add(a.target);
      }
    }
    const toolDescription = JSON.stringify({
      toolPath,
      tabs: Array.from(tabs).filter(Boolean),
      buttons: Array.from(buttons),
      ids: Array.from(ids).slice(0, 40),
    }, null, 2);

    // For each section past the first, build a "given the previous N, predict the next" example.
    for (let i = 1; i < sections.length; i++) {
      const prev = sections.slice(0, i).map(s => ({
        id: s.id,
        narration: s.narration,
        focusTarget: s.focusTarget,
      }));
      const next = sections[i];
      if (!next.narration || !next.navActions) continue;

      const userMessage = `Continue planning a video lecture for this interactive HTML tool. You have already planned ${i} section(s); produce the next section in the sequence.\n\nTOOL DESCRIPTION:\n${toolDescription}\n\nPREVIOUS SECTIONS (id + narration + focus only):\n${JSON.stringify(prev, null, 2)}`;

      const cleanNext = {
        id: next.id,
        group: next.group,
        narration: next.narration,
        navActions: next.navActions,
        expectedElements: next.expectedElements,
        focusTarget: next.focusTarget,
        isAnimated: next.isAnimated || false,
      };
      const assistantMessage = '```json\n' + JSON.stringify(cleanNext, null, 2) + '\n```';
      examples.push(makeChatExample(SECTION_PLANNING_SYSTEM, userMessage, assistantMessage));
    }
  }
  return examples;
}

// ── output 2: frame_qa_verdict examples ─────────────────────────────────

async function buildFrameQaVerdict(passedSections) {
  const examples = [];
  for (const { section, run } of passedSections) {
    if (!section.qaReports || section.qaReports.length === 0) continue;
    // Find a representative frame for this section
    const framesDir = join(run, 'frames');
    if (!existsSync(framesDir)) continue;

    let frameFile = null;
    try {
      const files = (await readdir(framesDir)).filter(f =>
        f.startsWith(section.id) && f.endsWith('.jpg')
      );
      if (files.length === 0) continue;
      frameFile = join(framesDir, files[Math.floor(files.length / 2)]);  // mid-frame
    } catch { continue; }

    // The QA report is the assistant output
    const lastReport = section.qaReports[section.qaReports.length - 1];
    if (!lastReport || !lastReport.checklist) continue;

    const userMessage = `Inspect this frame from a video lecture section.\n\nSECTION: ${section.id}\nNARRATION (first 200 chars): ${(section.narration || '').slice(0, 200)}\nEXPECTED ELEMENTS: ${JSON.stringify(section.expectedElements || [])}\nFOCUS: ${section.focusTarget || 'unspecified'}\n\n[Frame at ${frameFile} — image content not embedded in text JSONL; for vision fine-tuning, see the multimodal version]`;

    const assistantMessage = '```json\n' + JSON.stringify(lastReport.checklist, null, 2) + '\n```';
    examples.push(makeChatExample(FRAME_QA_SYSTEM, userMessage, assistantMessage));
  }
  return examples;
}

// ── output 3: narration_rewrite examples (mined from quality-loop log) ──

async function buildNarrationRewrite() {
  const examples = [];
  const stateFiles = await listRunStateFiles();

  for (const sf of stateFiles) {
    const state = await readJsonOrNull(sf);
    if (!state) continue;

    // Walk the log entries for narration_rewrite events
    const logEntries = state.log || [];
    for (const entry of logEntries) {
      if (entry?.event !== 'narration_rewrite' && entry?.type !== 'narration_rewrite') continue;
      const before = entry.before || entry.oldNarration || entry.original;
      const after  = entry.after  || entry.newNarration || entry.improved;
      const feedback = entry.feedback || entry.studentFeedback || '';
      if (!before || !after) continue;
      const userMessage = `Original narration:\n${before}\n\nStudent feedback:\n${typeof feedback === 'string' ? feedback : JSON.stringify(feedback)}\n\nRewrite the narration to address the confusion. Keep the same approximate length.`;
      examples.push(makeChatExample(NARRATION_REWRITE_SYSTEM, userMessage, after));
    }

    // Also: if a section has multiple narration values across qaReports, derive
    // a synthetic before→after pair (final narration is the "after").
    const sections = state.sections || [];
    for (const s of sections) {
      if (s.status !== 'qa_pass' && s.status !== 'approved') continue;
      const reports = s.qaReports || [];
      if (reports.length < 2) continue;
      const earlyNar = reports[0].narration;
      const lateNar = s.narration;
      if (!earlyNar || !lateNar || earlyNar === lateNar) continue;
      const issuesText = (reports[0].issues || []).map(i => i.description || JSON.stringify(i)).join('\n');
      if (!issuesText) continue;
      const userMessage = `Original narration:\n${earlyNar}\n\nStudent feedback:\n${issuesText}\n\nRewrite the narration to address the confusion. Keep the same approximate length.`;
      examples.push(makeChatExample(NARRATION_REWRITE_SYSTEM, userMessage, lateNar));
    }
  }

  return examples;
}

// ── output 4: tool_qa_fix examples (mined from tool_v* backups) ─────────

async function buildToolQaFix() {
  const examples = [];
  const stateFiles = await listRunStateFiles();

  for (const sf of stateFiles) {
    const runDir = dirname(sf);
    let toolVersions;
    try {
      toolVersions = (await readdir(runDir)).filter(f => /^tool_v\d+\.html$/.test(f));
    } catch { continue; }
    if (toolVersions.length === 0) continue;

    toolVersions.sort();
    // Pair v1 → v2, v2 → v3, ...
    for (let i = 0; i < toolVersions.length - 1; i++) {
      const beforePath = join(runDir, toolVersions[i]);
      const afterPath  = join(runDir, toolVersions[i + 1]);
      try {
        const before = await readFile(beforePath, 'utf-8');
        const after  = await readFile(afterPath,  'utf-8');
        if (before === after) continue;
        if (before.length > 100000 || after.length > 100000) continue; // skip huge ones

        const userMessage = `Fix this interactive HTML educational tool. Issues to address: based on student feedback the tool needs to better expose the concepts being taught. Output the complete corrected HTML.\n\nCURRENT HTML:\n${before}`;
        examples.push(makeChatExample(TOOL_QA_FIX_SYSTEM, userMessage, after));
      } catch { /* skip on error */ }
    }
  }

  return examples;
}

// ── main ────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════');
console.log('  Mining training data from runs/ + config/');
console.log('═══════════════════════════════════════════════\n');

const stateFiles = await listRunStateFiles();
const curated = await listCuratedConfigs();
console.log(`Found ${stateFiles.length} run state.json files`);
console.log(`Found ${curated.length} curated config files`);
console.log();

const passedSections = await mineRunSections();
console.log(`Passed sections across all runs: ${passedSections.length}`);
console.log();

console.log('Building section_planning.jsonl from curated configs...');
const planningExamples = dedupeByContent(await buildSectionPlanning());
const planningStats = await writeSplit('section_planning.jsonl', planningExamples);

console.log('Building frame_qa_verdict.jsonl from run sections...');
const frameQaExamples = dedupeByContent(await buildFrameQaVerdict(passedSections));
const frameQaStats = await writeSplit('frame_qa_verdict.jsonl', frameQaExamples);

console.log('Building narration_rewrite.jsonl from quality-loop logs...');
const narrationExamples = dedupeByContent(await buildNarrationRewrite());
const narrationStats = await writeSplit('narration_rewrite.jsonl', narrationExamples);

console.log('Building tool_qa_fix.jsonl from tool_v* backups...');
const toolFixExamples = dedupeByContent(await buildToolQaFix());
const toolFixStats = await writeSplit('tool_qa_fix.jsonl', toolFixExamples);

// ── stats report ────────────────────────────────────────────────────────

const lines = [];
lines.push('═══════════════════════════════════════════════');
lines.push('  Training data mining report');
lines.push(`  ${new Date().toISOString()}`);
lines.push('═══════════════════════════════════════════════\n');
lines.push(`Inputs:\n  - ${stateFiles.length} run state.json files\n  - ${curated.length} curated config files\n  - ${passedSections.length} passed sections across all runs\n`);
lines.push('Output files:');
function statLine(name, s) {
  const total = s.train + s.val;
  const usable = total >= 200;
  const tag = usable ? '✓ usable for fine-tuning' : '✗ too few examples — base model only';
  lines.push(`  data/train/${name}`);
  lines.push(`    train: ${s.train}  validation: ${s.val}  total: ${total}  ${tag}`);
}
statLine('section_planning.jsonl', planningStats);
statLine('frame_qa_verdict.jsonl', frameQaStats);
statLine('narration_rewrite.jsonl', narrationStats);
statLine('tool_qa_fix.jsonl',     toolFixStats);
lines.push('');
lines.push('═══════════════════════════════════════════════');
lines.push('  How to grow each dataset');
lines.push('═══════════════════════════════════════════════');
lines.push('');
lines.push('section_planning:');
lines.push('  - Already mineable from curated config/*.json files (~150-200 examples).');
lines.push('  - To grow: hand-curate more lecture configs in config/, OR run');
lines.push('    `node pipeline.mjs --skip-quality-loop` (lets section-planner produce');
lines.push('    real plans we can validate and add to the corpus).');
lines.push('');
lines.push('frame_qa_verdict:');
lines.push('  - Empty because all current runs use --skip-inspection.');
lines.push('  - To grow: run pipelines WITHOUT --skip-inspection. Each section');
lines.push('    will produce a vision QA report saved into qaReports[].checklist.');
lines.push('  - 5-10 full pipeline runs should yield ~150-300 examples.');
lines.push('');
lines.push('narration_rewrite:');
lines.push('  - Empty because the quality loop only logs aggregate counts, not the');
lines.push('    actual narration before/after pairs.');
lines.push('  - To grow: patch agents/quality-loop.mjs to call');
lines.push('    state.addLog("narration_rewrite", { sectionId, before, after, feedback })');
lines.push('    before saving the rewritten narration. Then re-run with quality loop.');
lines.push('');
lines.push('tool_qa_fix:');
lines.push('  - Empty because tool evolution is currently failing on the local backend');
lines.push('    (max_tokens issue, now clamped) and produces no v2 backups.');
lines.push('  - To grow: enable tool evolution in real lecture runs. The pipeline already');
lines.push('    saves tool_v1.html backups before each evolution; we just need successful');
lines.push('    evolutions to land tool_v2.html, tool_v3.html, etc.');
lines.push('');
lines.push('Practical first move: run 3-5 full lectures locally, tool evolution enabled,');
lines.push('inspection enabled. That single set of runs will populate every category at');
lines.push('once with high-quality validated data.');
lines.push('');
lines.push('Recommendation: any task with <200 examples should NOT be fine-tuned.');
lines.push('Use the base model with strong prompts for those, then collect more data');
lines.push('by running the pipeline a few more times to grow the training set.');
lines.push('');

const report = lines.join('\n');
console.log('\n' + report);
await writeFile(STATS_FILE, report);
console.log(`Stats written to ${STATS_FILE}`);

// Final dedupe helper used above
function dedupeByContent(examples) {
  const seen = new Set();
  const out = [];
  for (const ex of examples) {
    const k = hashString(ex);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ex);
  }
  return out;
}
