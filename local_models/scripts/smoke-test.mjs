#!/usr/bin/env node
/**
 * Smoke test for the local vLLM endpoints.
 *
 * Hits the same code path that the lecture pipeline uses (utils/claude-agent.mjs)
 * with LECTURE_LLM_BACKEND=local, so any error here will reproduce in the
 * pipeline. Validates:
 *
 *   1. Text endpoint reachable, returns valid JSON-style output.
 *   2. parseVerdict() can extract a JSON object from the response.
 *   3. (Optional) Vision endpoint reachable + accepts a real screenshot.
 *
 * Usage:
 *   node local_models/scripts/smoke-test.mjs
 *   node local_models/scripts/smoke-test.mjs --skip-vision
 *
 * Exit code 0 = pass, 1 = fail.
 */

import { runAgent, claudeVision, parseVerdict } from '../../utils/claude-agent.mjs';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Force the local backend regardless of caller env
process.env.LECTURE_LLM_BACKEND = process.env.LECTURE_LLM_BACKEND || 'local';

const args = process.argv.slice(2);
const skipVision = args.includes('--skip-vision');

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, '..', '..');

let pass = 0;
let fail = 0;
function ok(label, detail = '') {
  pass++;
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
}
function bad(label, err) {
  fail++;
  console.log(`  ❌ ${label}`);
  if (err) console.log('     ' + (err.message || err).toString().split('\n').slice(0, 4).join('\n     '));
}

console.log('═══════════════════════════════════════════════');
console.log('  vLLM smoke test (LECTURE_LLM_BACKEND=local)');
console.log('═══════════════════════════════════════════════\n');

// ── Test 1: text endpoint, simple prompt ────────────────────────────────────
console.log('Test 1: text endpoint reachable');
try {
  const result = await runAgent({
    systemPrompt: 'You are a helpful assistant. Respond ONLY with the single word OK and nothing else.',
    userMessage: 'Say OK.',
    maxTokens: 10
  });
  if (result.text && /\bok\b/i.test(result.text)) {
    ok('text endpoint responding', `text="${result.text}"`);
  } else {
    bad('text endpoint responded but with unexpected content', { message: `got: "${result.text}"` });
  }
} catch (err) {
  bad('text endpoint unreachable', err);
  console.log('\n  → Is the text vLLM server running?');
  console.log('  → Start it with: ./local_models/scripts/serve-vllm-text.sh\n');
}

// ── Test 2: text endpoint, structured JSON output ───────────────────────────
console.log('\nTest 2: structured JSON output (the workhorse format)');
try {
  const result = await runAgent({
    systemPrompt: 'You output strict JSON only, wrapped in a ```json fenced block. No prose.',
    userMessage: 'Output a JSON object with keys "verdict" (one of "pass"|"fail") and "score" (integer 0-100). Make verdict=pass and score=87.',
    maxTokens: 200
  });
  const parsed = parseVerdict(result.text);
  if (parsed && parsed.verdict === 'pass' && typeof parsed.score === 'number') {
    ok('JSON parse succeeded', `verdict=${parsed.verdict} score=${parsed.score}`);
  } else {
    bad('JSON did not parse or fields missing', { message: `raw: ${result.text?.slice(0, 200)}` });
  }
} catch (err) {
  bad('text endpoint failed on structured prompt', err);
}

// ── Test 3: vision endpoint, real screenshot ────────────────────────────────
if (!skipVision) {
  console.log('\nTest 3: vision endpoint reachable');
  // Find any captured frame from a recent run
  const { readdirSync } = await import('fs');
  let testFrame = null;
  try {
    const runs = readdirSync(resolve(repoDir, 'runs')).filter(d => d.startsWith('run_')).sort().reverse();
    for (const run of runs) {
      const framesDir = resolve(repoDir, 'runs', run, 'frames');
      if (existsSync(framesDir)) {
        const frames = readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
        if (frames.length > 0) { testFrame = resolve(framesDir, frames[0]); break; }
      }
    }
  } catch {}
  if (!testFrame) {
    console.log('  ⚠️  No captured frames found in runs/ — skipping vision test');
  } else {
    try {
      const result = await claudeVision({
        imagePath: testFrame,
        textPrompt: 'In one short sentence, describe what is shown in this screenshot.'
      });
      if (result && result.length > 5) {
        ok('vision endpoint responding', `(${result.length} chars) "${result.slice(0, 80)}..."`);
      } else {
        bad('vision endpoint returned empty', { message: `got: "${result}"` });
      }
    } catch (err) {
      bad('vision endpoint unreachable', err);
      console.log('\n  → Is the vision vLLM server running?');
      console.log('  → Start it with: ./local_models/scripts/serve-vllm-vision.sh');
      console.log('  → Or skip this test with --skip-vision\n');
    }
  }
} else {
  console.log('\nTest 3: vision endpoint  (skipped via --skip-vision)');
}

console.log('\n───────────────────────────────────────────────');
console.log(`  Result: ${pass} passed, ${fail} failed`);
console.log('───────────────────────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
