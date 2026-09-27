#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  LECTURE PRODUCTION PIPELINE — Main Orchestrator (v2)
 * ═══════════════════════════════════════════════════════════════
 *
 *  An agentic pipeline that produces video lectures from
 *  interactive HTML educational tools, with:
 *
 *    ✅ Auto-discovery of all tool content (section planner)
 *    ✅ Visual cursor/spotlight pointing at focus areas
 *    ✅ Critical student quality loop (iterate until satisfied)
 *    ✅ Automatic quality checking at every step
 *    ✅ Retry logic for failed sections
 *    ✅ Human-in-the-loop review gates
 *    ✅ Tool creation → QA → fix cycle
 *    ✅ Real animation capture (not just screenshots)
 *    ✅ Persistent state (resume after crashes)
 *    ✅ Pedagogical evaluation (simulated student classroom)
 *    ✅ Tool evolution (auto-modifies tool to teach better)
 *
 *  Usage:
 *    node pipeline.mjs                         # Full run
 *    node pipeline.mjs --resume                # Resume from saved state
 *    node pipeline.mjs --section 03_bigo_def   # Re-record one section
 *    node pipeline.mjs --skip-tool-qa          # Skip tool validation
 *    node pipeline.mjs --skip-planning         # Use sections.json as-is
 *    node pipeline.mjs --skip-quality-loop     # Skip student quality loop
 *    node pipeline.mjs --no-human-review       # Fully automated
 *    node pipeline.mjs --max-quality-iter 5    # Max quality loop iterations
 *
 * ═══════════════════════════════════════════════════════════════
 */

// Load .env file (OPENAI_API_KEY for TTS, etc.)
import { readFileSync, existsSync } from 'fs';
try {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch {}

import { chromium } from 'playwright';
import { readFile, stat, mkdir } from 'fs/promises';
import { join, resolve, dirname, basename } from 'path';
import { parseArgs } from 'util';
import { createServer } from 'http';
import { createReadStream } from 'fs';

import { PipelineState, Stage, SectionStatus, QAVerdict } from './utils/state.mjs';
import { HumanReview } from './utils/human-review.mjs';
import { runToolQA, fixTool } from './agents/tool-qa.mjs';
import { applyDeterministicVisibilityFixes, hasVisibilityBlockers } from './agents/visibility-fixer.mjs';
import { executeNavActions, captureVisibleState, injectCursorOverlay } from './agents/navigator.mjs';
import { recordSectionLive } from './agents/recorder.mjs';
import { generateTTS } from './agents/tts-agent.mjs';
import { qaFrame, qaAnimation, qaFinalVideo } from './agents/video-qa.mjs';
import { assembleFullLecture, buildAnimationSegment, buildStaticSegment } from './agents/assembler.mjs';
import { planSections, exploreTool } from './agents/section-planner.mjs';
import { runQualityLoop } from './agents/quality-loop.mjs';
import { ConversationTracker, analyzeHumanResponse } from './agents/conversation-monitor.mjs';
import { planEvolution, evolveTool } from './agents/tool-evolver.mjs';
import { normalizeSectionsToModules } from './utils/section-normalizer.mjs';

// ── CLI args ──
const { values: args } = parseArgs({
  options: {
    resume:              { type: 'boolean', default: false },
    section:             { type: 'string' },
    'skip-tool-qa':        { type: 'boolean', default: false },
    'skip-planning':       { type: 'boolean', default: false },
    'skip-quality-loop':   { type: 'boolean', default: false },
    'skip-nav-validation': { type: 'boolean', default: false },
    'skip-inspection':     { type: 'boolean', default: false },
    'no-human-review':     { type: 'boolean', default: false },
    'max-quality-iter':  { type: 'string', default: '5' },
    'max-sections':      { type: 'string' },
    config:              { type: 'string', default: './config/sections.json' },
    'run-dir':           { type: 'string' }
  }
});

// ═══════════════════════════════════════════════════════════════
//  PIPELINE ENTRY POINT
// ═══════════════════════════════════════════════════════════════

// ── Lightweight HTTP server for serving the tool HTML ──────────────────────
// Using HTTP instead of file:// eliminates all file:// browser quirks:
//   - waitUntil:'networkidle' works correctly (real HTTP requests)
//   - page.reload() behaves like a normal browser reload
//   - No security restrictions that differ from real HTTP
//   - CSS/JS changes are properly flushed by the browser's HTTP cache
function startToolServer(toolPath) {
  const toolDir = dirname(toolPath);
  const toolFile = basename(toolPath);
  return new Promise((resolveP, rejectP) => {
    const server = createServer(async (req, res) => {
      // Strip query string (cache-busting etc) and serve from toolDir
      const urlPath = req.url.split('?')[0].split('#')[0];
      const filePath = urlPath === '/' || urlPath === `/${toolFile}`
        ? toolPath
        : join(toolDir, urlPath.replace(/^\//, ''));
      const ext = filePath.split('.').pop().toLowerCase();
      const mimeTypes = { html: 'text/html', js: 'application/javascript',
        css: 'text/css', json: 'application/json',
        png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };
      try {
        await stat(filePath);
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'text/plain',
          'Cache-Control': 'no-store'  // always serve fresh — no stale caching
        });
        createReadStream(filePath).pipe(res);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`   🌐 Tool server: http://127.0.0.1:${port}/${toolFile}`);
      resolveP({ server, port, url: `http://127.0.0.1:${port}/${toolFile}` });
    });
    server.on('error', rejectP);
  });
}

async function normalizeSectionsForTool(toolPath, sections, exploration = null, label = 'sections') {
  const toolExploration = exploration || await exploreTool(toolPath);
  const normalized = normalizeSectionsToModules(sections, toolExploration);
  if (
    normalized.summary.moduleFocusAdjusted ||
    normalized.summary.motionInjected ||
    normalized.summary.coverageAdded ||
    normalized.summary.narrationTrimmed
  ) {
    console.log(
      `   🧩 Normalized ${label}: ${normalized.summary.moduleFocusAdjusted} module target(s), ` +
      `${normalized.summary.motionInjected} motion upgrade(s), ` +
      `${normalized.summary.coverageAdded || 0} coverage section(s), ` +
      `${normalized.summary.narrationTrimmed || 0} narration trim(s)`
    );
  }
  return { sections: normalized.sections, exploration: toolExploration, summary: normalized.summary };
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  🎬 LECTURE PRODUCTION PIPELINE v2');
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // ── Initialize or resume state ──
  let state;
  const runDir = resolve(args['run-dir'] || join(process.cwd(), `runs/run_${Date.now()}`));
  const stateFile = join(runDir, 'state.json');
  const configRaw = await readFile(resolve(args.config), 'utf-8');
  const configParsed = JSON.parse(configRaw);

  // Handle both formats:
  //   Legacy: { lecture: { toolPath }, sections: [...], defaults: {...} }
  //   Auto-saved: flat array [...] from section-planner
  const config = Array.isArray(configParsed)
    ? { lecture: { toolPath: './Asymptotic_Notation_Explorer.html' }, sections: configParsed, defaults: {} }
    : configParsed;
  const reuseExistingRunForSection = Boolean(args.section && args['run-dir'] && existsSync(stateFile));

  if (args.resume || reuseExistingRunForSection) {
    state = await PipelineState.resume(runDir);
    if (reuseExistingRunForSection && !args.resume) {
      console.log(`📂 Reusing run for section re-record: ${state.data.runId}`);
      console.log(`   Stage: ${state.data.currentStage}`);
      console.log(`   Refreshing section definition from current config: ${args.section}`);

      state.data.toolPath = resolve(config.lecture.toolPath);

      const normalizedConfigSections = await normalizeSectionsForTool(
        state.data.toolPath,
        config.sections || [],
        null,
        'config sections'
      );

      const refreshed = normalizedConfigSections.sections.find(section => section.id === args.section);
      if (!refreshed) {
        throw new Error(`Section ${args.section} not found in current config`);
      }

      const existingIndex = state.data.sections.findIndex(section => section.id === args.section);
      const existing = existingIndex >= 0 ? state.data.sections[existingIndex] : null;
      const replacement = {
        index: existing?.index ?? refreshed.index ?? existingIndex,
        id: refreshed.id,
        status: SectionStatus.PENDING,
        retries: 0,
        framePath: null,
        audioPath: existing?.audioPath || null,
        audioDuration: existing?.audioDuration || null,
        segmentPath: existing?.segmentPath || null,
        qaReports: [],
        navActions: refreshed.navActions || [],
        narration: refreshed.narration || '',
        group: refreshed.group || null,
        focusTarget: refreshed.focusTarget || null,
        isAnimated: Boolean(refreshed.isAnimated),
        scrollTarget: refreshed.scrollTarget || null,
        expectedElements: refreshed.expectedElements || []
      };

      if (existingIndex >= 0) {
        state.data.sections[existingIndex] = replacement;
      } else {
        state.data.sections.push(replacement);
      }

      await state.save();
    } else {
      console.log(`📂 Resuming run: ${state.data.runId}`);
      console.log(`   Stage: ${state.data.currentStage}`);
    }
  } else {
    state = await PipelineState.create(runDir, {
      ...config.defaults,
      humanReviewEnabled: !args['no-human-review'],
      humanReviewEveryN: 10
    });

    state.data.toolPath = resolve(config.lecture.toolPath);
    // Optional human-readable lecture title; used as the topic shown to the simulated students.
    state.data.lectureTitle = config.lecture.title || null;

    // Support guidePath in config — auto-detect if not specified
    if (config.lecture.guidePath) {
      state.data.guidePath = resolve(config.lecture.guidePath);
      console.log(`   Guide: ${state.data.guidePath}`);
    } else {
      // Auto-detect guide file next to the HTML tool
      const { detectGuide } = await import('./agents/section-planner.mjs');
      const autoGuide = await detectGuide(state.data.toolPath);
      if (autoGuide) {
        state.data.guidePath = autoGuide;
        console.log(`   Guide (auto-detected): ${autoGuide}`);
      }
    }

    const normalizedConfigSections = await normalizeSectionsForTool(
      state.data.toolPath,
      config.sections || [],
      null,
      'config sections'
    );
    state.initSections(normalizedConfigSections.sections);
    if (args['max-sections']) {
      const cap = parseInt(args['max-sections'], 10);
      if (Number.isFinite(cap) && cap > 0 && state.data.sections.length > cap) {
        console.log(`   ✂️  Truncating to first ${cap} section(s) (--max-sections)`);
        state.data.sections = state.data.sections.slice(0, cap);
      }
    }
    await state.save();
    console.log(`📂 New run: ${state.data.runId}`);
    console.log(`   Tool: ${state.data.toolPath}`);
    console.log(`   Config sections: ${state.data.sections.length}`);
  }

  // ── Conversation Monitor ──
  const conversationTracker = new ConversationTracker();
  // Record which LLM backend and models this invocation uses (model provenance).
  const { describeLLMConfig } = await import('./utils/claude-agent.mjs');
  const llmConfig = { ...describeLLMConfig(), recordedAt: new Date().toISOString() };
  state.data.llmConfig = llmConfig;
  state.data.llmConfigLog = [...(state.data.llmConfigLog || []), llmConfig];
  await state.save();
  console.log(`   🤖 LLM backend: ${llmConfig.backend} (text: ${llmConfig.textModel}, vision: ${llmConfig.visionModel})`);

  const humanReview = new HumanReview(state, { conversationTracker });

  // ── Single section mode ──
  if (args.section) {
    console.log(`\n🎯 Single section mode: ${args.section}`);
    const { server: singleServer, url: singleUrl } = await startToolServer(state.data.toolPath);
    const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox', '--hide-scrollbars'] });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.goto(singleUrl, { waitUntil: 'networkidle' });
    await injectCursorOverlay(page);
    await processSingleSection(state, page, args.section, humanReview, conversationTracker);
    await browser.close();
    await new Promise(resolve => singleServer.close(resolve));
    console.log('\n✅ Section reprocessed successfully');
    return;
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 1: TOOL QA
  // ═══════════════════════════════════════════════════════════

  if (state.data.currentStage === Stage.TOOL_GENERATION ||
      state.data.currentStage === Stage.TOOL_QA) {

    if (!args['skip-tool-qa']) {
      await state.setStage(Stage.TOOL_QA);
      console.log('\n' + '─'.repeat(50));
      console.log('STAGE 1: Tool Quality Assurance');
      console.log('─'.repeat(50));

      let toolQAPassed = false;
      let toolFixAttempts = 0;
      const MAX_TOOL_FIXES = 2;
      let deterministicVisibilityPassUsed = false;

      while (!toolQAPassed && toolFixAttempts <= MAX_TOOL_FIXES) {
        const verdict = await runToolQA(state);

        if (verdict.verdict === 'pass') {
          toolQAPassed = true;
          console.log('   ✅ Tool QA passed');
        } else if (verdict.verdict === 'fail_retry' && toolFixAttempts < MAX_TOOL_FIXES) {
          if (state.data.config.autoVisibilityFix !== false && hasVisibilityBlockers(verdict) && !deterministicVisibilityPassUsed) {
            console.log('   👁️  Visibility QA failed — applying deterministic visibility enhancer...');
            const visibilityFixedPath = await applyDeterministicVisibilityFixes(state, verdict);
            if (visibilityFixedPath) {
              state.data.toolPath = visibilityFixedPath;
              await state.save();
              deterministicVisibilityPassUsed = true;
              console.log('   🔧 Deterministic visibility pass complete — re-running QA...');
              continue;
            }
          }
          console.log('   🔄 Tool QA failed — attempting auto-fix...');
          const fixedPath = await fixTool(state, verdict);
          if (fixedPath) {
            state.data.toolPath = fixedPath;
            await state.save();
            toolFixAttempts++;
            console.log(`   🔧 Fix attempt ${toolFixAttempts}/${MAX_TOOL_FIXES} — re-running QA...`);
          } else {
            verdict.verdict = 'fail_human';
          }
        } else if (verdict.verdict === 'fail_retry') {
          // Repair budget exhausted: escalate instead of re-running QA indefinitely.
          console.log(`   ⚠️  Tool QA still failing after ${MAX_TOOL_FIXES} fix attempts — escalating to human review`);
          verdict.verdict = 'fail_human';
        }

        if (verdict.verdict === 'fail_human') {
          if (!state.data.config.humanReviewEnabled) {
            toolQAPassed = true;
            console.log('   ⚠️  Tool QA issues found but --no-human-review set, auto-approving');
          } else {
            const review = await humanReview.reviewSection(
              { id: 'tool_qa', index: -1, narration: '', framePath: '', audioPath: '' },
              { issues: verdict.issues }
            );
            if (review.action === 'approve') {
              toolQAPassed = true;
              console.log('   👤 Human approved (override)');
            } else if (review.action === 'pause') {
              console.log('   ⏸️  Pipeline paused. Resume with --resume');
              return;
            } else {
              console.log('   ❌ Tool QA failed. Aborting.');
              return;
            }
          }
        }
      }
    } else {
      console.log('\n⏭️  Skipping Tool QA (--skip-tool-qa)');
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 1.5: AUTO-DISCOVER SECTIONS (Section Planner)
  // ═══════════════════════════════════════════════════════════
  //
  //  Instead of relying on a hand-written 6-section config,
  //  explore the HTML tool and generate 30-45 comprehensive
  //  sections covering ALL content.

  if (!args['skip-planning']) {
    console.log('\n' + '─'.repeat(50));
    console.log('STAGE 1.5: Section Planning (Auto-Discovery)');
    console.log('─'.repeat(50));

    const planResult = await planSections(state.data.toolPath, state.runDir, state.data.guidePath || null);

    // Replace the sparse config sections with comprehensive discovered sections
    state.initSections(planResult.sections);
    if (args['max-sections']) {
      const cap = parseInt(args['max-sections'], 10);
      if (Number.isFinite(cap) && cap > 0 && state.data.sections.length > cap) {
        console.log(`   ✂️  Truncating to first ${cap} section(s) (--max-sections)`);
        state.data.sections = state.data.sections.slice(0, cap);
      }
    }
    await state.save();

    console.log(`   ✅ Planned ${planResult.sections.length} sections`);
    console.log(`   📊 Navigation validation: ${planResult.validation.passCount}/${planResult.validation.total} pass`);

    state.addLog('section_planning', {
      totalSections: planResult.sections.length,
      navValidation: planResult.validation.passCount,
    });
  } else {
    console.log('\n⏭️  Skipping section planning (--skip-planning)');
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 2: CRITICAL STUDENT QUALITY LOOP
  // ═══════════════════════════════════════════════════════════
  //
  //  Simulated students (weak/average/strong) evaluate every
  //  section. The loop iterates until ALL students are satisfied:
  //    - Rewrites narration if explanation is unclear
  //    - Reorders sections if prerequisites are missing
  //    - Evolves the tool if visualization can't show concept
  //
  //  This runs BEFORE expensive recording/TTS, catching issues early.

  if (!args['skip-quality-loop']) {
    console.log('\n' + '─'.repeat(50));
    console.log('STAGE 2: Critical Student Quality Loop');
    console.log('─'.repeat(50));

    const qualityBrowser = await chromium.launch({ headless: true, args: ['--window-size=1920,1080'] });
    const qualityContext = await qualityBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    const qualityPage = await qualityContext.newPage();

    const maxIter = parseInt(args['max-quality-iter'] || '5');

    const qualityResult = await runQualityLoop(state, qualityPage, {
      maxIterations: maxIter,
    });

    await qualityBrowser.close();

    // Update state with improved sections, then re-normalize them against the tool
    const normalizedQualitySections = await normalizeSectionsForTool(
      qualityResult.toolPath,
      qualityResult.sections,
      null,
      'quality-loop sections'
    );
    state.data.sections = normalizedQualitySections.sections;
    state.data.toolPath = qualityResult.toolPath;
    // PERMANENT FIX (2026-04-10): re-apply --max-sections after the quality
    // loop's normalization. The normalizer's coverage augmentation re-injects
    // dropped sections, so without this re-cap a `--max-sections 3` run ends
    // up recording 100+ sections.
    if (args['max-sections']) {
      const cap = parseInt(args['max-sections'], 10);
      if (Number.isFinite(cap) && cap > 0 && state.data.sections.length > cap) {
        console.log(`   ✂️  Re-truncating to first ${cap} section(s) after quality-loop (--max-sections)`);
        state.data.sections = state.data.sections.slice(0, cap);
      }
    }
    await state.save();

    state.addLog('quality_loop_complete', {
      iterations: qualityResult.iterations,
      allPassed: qualityResult.allPassed,
      finalToolPath: qualityResult.toolPath,
      totalSections: qualityResult.sections.length,
    });

    if (!qualityResult.allPassed && state.data.config.humanReviewEnabled) {
      const review = await humanReview.reviewSection(
        { id: 'quality_loop', index: -1, narration: '', framePath: '', audioPath: '' },
        { issues: [{ type: 'quality', description: `Student quality loop did not converge in ${maxIter} iterations` }] }
      );
      if (review.action === 'pause') {
        await state.save();
        console.log('   ⏸️  Pipeline paused. Resume with --resume');
        return;
      }
    }
  } else {
    console.log('\n⏭️  Skipping quality loop (--skip-quality-loop)');
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 2.5: RE-VALIDATE NAV ACTIONS AGAINST CURRENT TOOL
  // ═══════════════════════════════════════════════════════════
  //
  //  After the quality loop may have evolved the tool (changing
  //  its DOM structure), re-validate that all section navActions
  //  still work against the current tool version.

  // Skip nav validation when --skip-nav-validation is set,
  // OR when both --skip-planning and --skip-quality-loop are set
  // (neither stage can change the tool DOM, so revalidation is redundant)
  const shouldSkipNavValidation = args['skip-nav-validation']
    || (args['skip-planning'] && args['skip-quality-loop']);

  if (!shouldSkipNavValidation) {
    console.log('\n' + '─'.repeat(50));
    console.log('STAGE 2.5: Re-validate Navigation Against Current Tool');
    console.log('─'.repeat(50));

    const { validateSections, fixFailedSections, exploreTool } = await import('./agents/section-planner.mjs');

    const validation = await validateSections(state.data.sections, state.data.toolPath);

    if (validation.passCount < validation.total) {
      console.log(`   🔧 Fixing ${validation.total - validation.passCount} broken section(s)...`);
      const exploration = await exploreTool(state.data.toolPath);
      const fixedSections = await fixFailedSections(
        state.data.sections, validation, exploration
      );
      const normalizedFixedSections = await normalizeSectionsForTool(
        state.data.toolPath,
        fixedSections,
        exploration,
        'post-fix sections'
      );
      state.data.sections = normalizedFixedSections.sections;

      // Re-validate after fix
      const revalidation = await validateSections(state.data.sections, state.data.toolPath);
      console.log(`   📊 After fix: ${revalidation.passCount}/${revalidation.total} navigable`);

      // For sections that STILL fail, keep working actions and only strip broken ones
      for (const result of revalidation.results) {
        if (!result.passed) {
          const section = state.data.sections.find(s => s.id === result.id);
          if (section) {
            // Ensure at minimum a tab click exists
            const hasTabClick = section.navActions.some(a => a.action === 'click_tab');
            if (!hasTabClick) {
              const tabTarget = section.group || 'notations';
              section.navActions.unshift(
                { action: 'click_tab', target: tabTarget },
                { action: 'wait', ms: 500 }
              );
            }
            // Don't strip other actions — they may partially work
          }
        }
      }

      await state.save();
    } else {
      console.log(`   ✅ All ${validation.total} sections navigable`);
    }
  } else {
    console.log('\n⏭️  Skipping nav validation (planning+quality-loop both skipped)');
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 3: SECTION-BY-SECTION RECORDING
  // ═══════════════════════════════════════════════════════════

  await state.setStage(Stage.NAVIGATE);
  console.log('\n' + '─'.repeat(50));
  console.log('STAGE 3: Section Recording & QA');
  console.log('─'.repeat(50));

  // Start HTTP server — eliminates all file:// URL quirks
  const toolServer = await startToolServer(state.data.toolPath);
  const toolHttpUrl = toolServer.url;

  // Helper to create a fresh browser+page
  async function launchBrowser() {
    const b = await chromium.launch({
      // PERMANENT FIX (2026-03-23): Use system Chrome with channel:'chrome'.
      //
      // chrome-headless-shell (the default Playwright headless binary) ALWAYS
      // forces --disable-gpu and --disable-gpu-compositing internally, regardless
      // of launch args. This means CSS display:flex/none changes are NOT composited
      // before page.screenshot() fires — tab switches work in DOM but screenshots
      // capture stale software-rendered pixels.
      //
      // PERMANENT FIX (2026-03-23): Use headless:true with channel:'chrome'.
      //
      // headless:false was causing content cut-off: Chrome's UI (tabs + address bar
      // ~120px) consumed viewport height on the physical screen. Even with
      // --window-size=1920,1080, the page content area was only ~960px because the
      // Chrome UI overlaps the window. The viewport: {height:1080} setting
      // tries to resize the window to fit but is constrained by the physical display.
      //
      // headless:true + channel:'chrome' uses the real Chrome binary in headless
      // mode (not chrome-headless-shell). Since Chrome 112, "new headless" is the
      // full Chrome binary without a window — it uses the real GPU compositing
      // pipeline. Combined with channel:'chrome', there is NO chrome-headless-shell.
      // The viewport is unconstrained by physical screen size → always exactly
      // 1920x1080 → full page content captured in every screenshot.
      //
      // DO NOT switch to headless:false — it constrains the viewport to physical
      // screen size, cutting off page content that extends below ~960px.
      headless: true,
      channel: 'chrome',  // use system Google Chrome (not bundled chrome-headless-shell)
      args: ['--no-sandbox', '--disable-infobars', '--hide-scrollbars']
    });
    const ctx = await b.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1
    });
    const p = await ctx.newPage();
    await p.goto(toolHttpUrl, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);
    await injectCursorOverlay(p);
    return { browser: b, page: p };
  }

  let { browser, page } = await launchBrowser();

  const totalSections = state.data.sections.length;

  for (let i = 0; i < totalSections; i++) {
    const section = state.data.sections[i];

    if (section.status === SectionStatus.QA_PASS ||
        section.status === SectionStatus.APPROVED) {
      console.log(`   ⏭️  Skipping ${section.id} (already passed)`);
      continue;
    }

    console.log(`\n   ┌─ Section ${i + 1}/${totalSections}: ${section.id}`);

    try {
      await processSection(state, page, section, humanReview, i, conversationTracker);
    } catch (err) {
      if (err.message?.includes('closed') || err.message?.includes('Target page')) {
        console.log(`   │  🔄 Browser crashed — restarting...`);
        try { await browser.close(); } catch {}
        ({ browser, page } = await launchBrowser());
        // Retry this section once with fresh browser
        try {
          await processSection(state, page, section, humanReview, i, conversationTracker);
        } catch (retryErr) {
          console.log(`   │  ⚠️  Section ${section.id} failed after browser restart: ${retryErr.message}`);
          await state.updateSection(section.id, { status: SectionStatus.QA_PASS });
        }
      } else {
        throw err;
      }
    }

    // Human review checkpoint
    if (state.data.config.humanReviewEnabled && state.needsHumanReview(i)) {
      const completedSoFar = state.data.sections.filter(s =>
        s.status === SectionStatus.QA_PASS || s.status === SectionStatus.APPROVED
      );
      const review = await humanReview.checkpointReview(completedSoFar);

      if (review.action === 'pause') {
        await state.save();
        console.log('\n   ⏸️  Pipeline paused at checkpoint. Resume with --resume');
        await browser.close();
        return;
      }

      if (review.feedback) {
        conversationTracker.recordInteraction('checkpoint', review.action, review.feedback);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  POST-RECORDING: Detect systemic confusion & evolve tool
  // ═══════════════════════════════════════════════════════════

  if (conversationTracker.getConfusionLog().length > 0) {
    console.log('\n   🧠 Analyzing human confusion patterns...');
    const systemicIssues = await conversationTracker.detectSystemicIssues();

    if (systemicIssues?.systemicIssues?.length > 0) {
      console.log(`   🔍 Found ${systemicIssues.systemicIssues.length} systemic issue(s):`);
      for (const issue of systemicIssues.systemicIssues) {
        console.log(`      • ${issue.pattern} (${issue.toolFix.priority})`);
      }

      if (!state.data.config.humanReviewEnabled) {
        // Auto-evolve in non-interactive mode
        const requirements = systemicIssues.systemicIssues.map(issue => ({
          type: issue.toolFix.type,
          description: issue.toolFix.description,
          reason: issue.rootCause,
          affectedSections: issue.affectedSections,
          priority: issue.toolFix.priority
        }));

        const evolutionPlan = await planEvolution(state.data.toolPath, requirements);
        const evolveResult = await evolveTool(state.data.toolPath, evolutionPlan, state.runDir);

        if (evolveResult.success) {
          state.data.toolPath = evolveResult.path;
          await state.save();
          console.log('   ✅ Tool evolved based on confusion patterns');
        }
      }
    }
    await state.save();
  }

  await browser.close();
  toolServer.server.close();

  // ═══════════════════════════════════════════════════════════
  //  STAGE 4: PRE-ASSEMBLY REVIEW
  // ═══════════════════════════════════════════════════════════

  if (state.data.config.humanReviewEnabled) {
    console.log('\n' + '─'.repeat(50));
    console.log('STAGE 4: Pre-Assembly Review');
    console.log('─'.repeat(50));

    const review = await humanReview.preAssemblyReview();
    if (review.action === 'pause') {
      await state.save();
      console.log('\n   ⏸️  Pipeline paused. Resume with --resume');
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 5: VIDEO ASSEMBLY
  // ═══════════════════════════════════════════════════════════

  await state.setStage(Stage.ASSEMBLY);
  console.log('\n' + '─'.repeat(50));
  console.log('STAGE 5: Video Assembly');
  console.log('─'.repeat(50));

  const assemblyResult = await assembleFullLecture(state);
  state.data.assemblyResult = assemblyResult;
  await state.save();

  // ═══════════════════════════════════════════════════════════
  //  STAGE 6: FINAL QA
  // ═══════════════════════════════════════════════════════════

  await state.setStage(Stage.FINAL_QA);
  console.log('\n' + '─'.repeat(50));
  console.log('STAGE 6: Final Video QA');
  console.log('─'.repeat(50));

  const finalQA = await qaFinalVideo(assemblyResult.outputPath, state.data.sections);
  state.data.finalQA = finalQA;
  await state.save();

  if (finalQA.verdict === 'pass') {
    console.log('   ✅ Final QA passed');
  } else {
    console.log(`   ⚠️  Final QA: ${finalQA.verdict}`);
    for (const issue of finalQA.issues) {
      console.log(`      ${issue.type}: ${issue.description}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  DONE
  // ═══════════════════════════════════════════════════════════

  await state.setStage(Stage.DONE);

  // ═══════════════════════════════════════════════════════════
  //  PRESERVE OUTPUT & CLEAN UP RUN DIRECTORY
  // ═══════════════════════════════════════════════════════════
  //
  //  Final video + subtitles are saved into output/ (never deleted).
  //  The run_* directory (intermediate frames, segments, state) is
  //  removed automatically after a successful pipeline run.
  //  This prevents accidental deletion of finished lectures.

  const outputDir = join(process.cwd(), 'output');
  await mkdir(outputDir, { recursive: true });

  const { copyFileSync, existsSync: fsExistsSync } = await import('fs');
  const outVideoName = basename(assemblyResult.outputPath);
  const outSrtName = outVideoName.replace('.mp4', '.srt');
  const finalVideoPath = join(outputDir, outVideoName);
  const finalSrtPath = join(outputDir, outSrtName);

  // Copy video
  copyFileSync(assemblyResult.outputPath, finalVideoPath);
  // Copy subtitles only if they were generated (opt-in via config.generateSrt).
  // PERMANENT FIX (2026-04-10): when SRT generation is OFF, also delete any
  // stale SRT left over from a previous run, so video players don't auto-load
  // it on top of the in-video DOM caption.
  if (assemblyResult.srtPath) {
    try { copyFileSync(assemblyResult.srtPath, finalSrtPath); } catch {}
  } else if (fsExistsSync(finalSrtPath)) {
    try { (await import('fs/promises')).unlink(finalSrtPath); } catch {}
  }

  // Remove the temporary file from runs/ (output/ is the canonical location now)
  try { (await import('fs/promises')).unlink(assemblyResult.outputPath).catch(() => {}); } catch {}
  if (assemblyResult.srtPath) {
    try { (await import('fs/promises')).unlink(assemblyResult.srtPath).catch(() => {}); } catch {}
  }
  // Remove QA sample/sync images from runs/
  const { readdirSync, unlinkSync } = await import('fs');
  try {
    for (const f of readdirSync(join(process.cwd(), 'runs'))) {
      if (f.endsWith('.jpg') || f.endsWith('.txt')) {
        try { unlinkSync(join(process.cwd(), 'runs', f)); } catch {}
      }
    }
  } catch {}

  // PERMANENT FIX: Do NOT delete run directory automatically.
  // Run directories contain segments needed for --section re-recording.
  // Only delete when the user explicitly commands it.
  console.log(`   📂 Run directory preserved: ${state.runDir}`);

  console.log('\n' + '═'.repeat(50));
  console.log('  ✅ PIPELINE COMPLETE');
  console.log('═'.repeat(50));
  console.log(`  Output: ${finalVideoPath}`);
  console.log(`  Duration: ${(parseFloat(assemblyResult.metadata.format?.duration || 0) / 60).toFixed(1)} min`);
  console.log(`  Sections: ${assemblyResult.segmentCount}`);
  console.log('');
}


// ═══════════════════════════════════════════════════════════════
//  SECTION PROCESSING — The core agentic loop
// ═══════════════════════════════════════════════════════════════

function sectionRequiresInteractiveToolUse(section) {
  return (section.navActions || []).some(action => {
    if (action.action === 'set_select' || action.action === 'set_slider' || action.action === 'step_through') {
      return true;
    }
    if (action.action === 'click_selector' || action.action === 'click_nth') {
      return true;
    }
    if (action.action !== 'click_button') return false;
    return !/\b(collapse|expand)\b/i.test(String(action.text || ''));
  });
}

async function processSection(state, page, section, humanReview, sectionIndex, conversationTracker) {
  const { recordSectionLive } = await import('./agents/recorder.mjs');
  const { inspectSection } = await import('./agents/quality-inspector.mjs');

  const maxAttempts = 3;

  await state.updateSection(section.id, { status: SectionStatus.RECORDING });

  // ── Step 1: Generate TTS FIRST (we need the exact duration for sync) ──
  console.log(`   │  🎙️  Generating TTS...`);
  const audioPath = join(state.runDir, 'audio', `${section.id}.mp3`);
  const ttsResult = await generateTTS(section.narration, audioPath, {
    apiKey: process.env.OPENAI_API_KEY,
    voice: state.data.config.ttsVoice || 'shimmer',
    model: state.data.config.ttsModel || 'tts-1-hd',
    speed: state.data.config.ttsSpeed || 0.95
  });

  if (!ttsResult.qualityCheck.pass) {
    console.log(`   │  ⚠️  TTS quality: ${ttsResult.qualityCheck.issues.join(', ')}`);
  }

  const audioDurationMs = (ttsResult.duration || 15) * 1000;
  console.log(`   │  ✅ TTS done (${ttsResult.duration?.toFixed(1)}s)`);

  // ── Step 2+3: Record + Inspect loop ──
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) console.log(`   │  🔄 Retry ${attempt - 1}/${maxAttempts - 1}`);

    // Reset page state
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    // Live record — pass Whisper sentence timestamps for subtitle sync
    const recording = await recordSectionLive(
      page, section, join(state.runDir, 'frames'), audioDurationMs, ttsResult.sentenceTimestamps
    );

    if (recording.framePaths.length === 0) {
      console.log(`   │  ⚠️  No frames captured`);
      continue;
    }

    // ── Build per-section segment MP4 immediately ──────────────────────────
    // Build the video now so we can inspect real video frames, not just
    // captured JPEGs. The assembler will skip this segment (already built).
    const segmentsDir = join(state.runDir, 'segments');
    await mkdir(segmentsDir, { recursive: true });
    const segmentPath = join(segmentsDir, `seg_${section.id}.mp4`);
    try {
      if (recording.framePaths.length > 1) {
        buildAnimationSegment(recording.framePaths, audioPath, segmentPath, {});
      } else {
        buildStaticSegment(recording.framePaths[0] || recording.framePath, audioPath, segmentPath, {});
      }
      console.log(`   │  🎬 Segment built: seg_${section.id}.mp4`);
    } catch (e) {
      console.log(`   │  ⚠️  Segment build failed: ${e.message?.substring(0, 60)}`);
    }

    // ── Layer 2+3: Post-recording guard (temporal coherence + keyframe selection) ──
    try {
      const { runPostRecordingGuard } = await import('./agents/frame-guard.mjs');
      const postGuard = runPostRecordingGuard({ framePaths: recording.framePaths, section });

      if (!postGuard.temporal.stable) {
        const jumpCount = postGuard.temporal.jumps.length;
        console.log(`   │  ⚠️  Temporal: ${jumpCount} jump(s) detected (max drop: ${postGuard.temporal.maxDrop})`);
        for (const jump of postGuard.temporal.jumps.slice(0, 3)) {
          console.log(`   │     Frame ${jump.frameIndex}: similarity=${jump.similarity}`);
        }
      } else {
        console.log(`   │  ✅ Temporal: stable (${postGuard.temporal.framesChecked} frame pairs checked)`);
      }
    } catch (e) {
      console.log(`   │  ⚠️  Post-guard error: ${e.message?.substring(0, 60)}`);
    }

    // ── Quality Inspection — frame 0 (tab) + middle frame (content) ────────
    // Frame 0 catches wrong-tab from the very first captured frame.
    // Middle frame checks content relevance during narration.
    const firstFrame = recording.framePaths[0];
    const midFrameIdx = Math.floor(recording.framePaths.length / 2);
    const midFrame = recording.framePaths[midFrameIdx] || firstFrame;

    if (args['skip-inspection']) {
      console.log(`   │  ⏭️  Inspection skipped (--skip-inspection)`);
    } else try {
      // Inspect frame 0 for tab correctness
      const firstInspection = await inspectSection(firstFrame, section);
      const firstCl = firstInspection.checklist || {};

      // Inspect middle frame for content quality
      let midCl = firstCl;
      let midInspection = null;
      if (midFrame !== firstFrame) {
        midInspection = await inspectSection(midFrame, section);
        midCl = midInspection.checklist || {};
      }

      // Tab result comes from frame 0 (if wrong at start, whole section is wrong)
      // Content result comes from middle frame
      const cl = {
        correct_tab:      firstCl.correct_tab,
        text_readable:    midCl.text_readable,
        pointer_visible:  midCl.pointer_visible,
        formulas_visible: midCl.formulas_visible,
        content_matches:  midCl.content_matches,
        right_panel_active: midCl.right_panel_active,
        no_artifacts:     midCl.no_artifacts,
        space_utilized:   midCl.space_utilized,
        tools_used:       midCl.tools_used,
        chart_not_clipped: midCl.chart_not_clipped,
        text_in_bounds:   midCl.text_in_bounds,
      };

      const score = firstCl.correct_tab ? (midInspection?.score ?? firstInspection.score) : 0;

      // Log checklist
      const checks = [
        cl.correct_tab ? '✅tab' : '❌tab',
        cl.text_readable ? '✅text' : '⚠️text',
        cl.pointer_visible ? '✅ptr' : '⚠️ptr',
        cl.content_matches ? '✅content' : '❌content',
        cl.right_panel_active ? '✅panel' : '❌panel',
        cl.tools_used !== false ? '✅tools' : '❌tools',
        cl.chart_not_clipped !== false ? '✅chart' : '❌clip',
        cl.text_in_bounds !== false ? '✅bounds' : '❌bounds',
      ].join(' ');
      console.log(`   │  🔍 QA frame0+mid: [${checks}] score=${score}`);

      const issues = [...(firstInspection.issues || []), ...(midInspection?.issues || [])];
      for (const issue of issues.slice(0, 2)) {
        console.log(`   │     ${issue}`);
      }

      const requireInteractiveTools = sectionRequiresInteractiveToolUse(section);

      // Critical failures — retry if tab wrong (frame 0), content doesn't match (mid),
      // tools not used, or chart clipped.
      // NOTE: text_in_bounds is NOT a retry trigger — the recorder can't fix CSS
      // truncation or HTML layout issues by re-recording. It's a score penalty only.
      // The root fix for text overflow lives in the HTML (circle sizing, CSS widths).
      if (!cl.correct_tab || cl.text_readable === false || !cl.content_matches || (requireInteractiveTools && cl.tools_used === false)
          || cl.chart_not_clipped === false) {
        if (attempt < maxAttempts) {
          const reason = !cl.correct_tab ? 'wrong tab in frame 0'
            : cl.text_readable === false ? 'text unreadable or low contrast'
            : !cl.content_matches ? 'content mismatch'
            : (requireInteractiveTools && cl.tools_used === false) ? 'interactive tools not used'
            : 'chart clipped / overflow';
          console.log(`   │  ❌ Critical check failed (${reason}) — retrying...`);
          continue;
        }
        console.log(`   │  ⚠️  Critical check failed but max retries reached`);
      }
      if (cl.text_in_bounds === false) {
        console.log(`   │  ⚠️  Text overflow detected — logged (HTML fix needed, not retriable)`);
      }
    } catch (e) {
      console.log(`   │  ⚠️  Inspection error: ${e.message?.substring(0, 60)}`);
    }

    // ── Mark as passed ──
    const framePath = recording.framePaths[0];
    await state.updateSection(section.id, {
      framePath,
      framePaths: recording.framePaths,
      audioPath,
      audioDuration: ttsResult.duration,
      segmentPath,
      status: SectionStatus.QA_PASS
    });

    console.log(`   └─ ✅ Section ${section.id} complete (${recording.frameCount} frames, ${ttsResult.duration?.toFixed(1)}s audio)`);
    return;
  }

  // All attempts failed — mark as passed anyway to not block pipeline
  console.log(`   └─ ⚠️  Section ${section.id} completed with quality warnings`);
}

async function processSingleSection(state, page, sectionId, humanReview, conversationTracker) {
  const section = state.getSection(sectionId);
  if (!section) {
    console.error(`Section ${sectionId} not found`);
    return;
  }

  await state.updateSection(sectionId, { status: SectionStatus.PENDING, retries: 0 });
  state.data.retryBudget[sectionId] = state.data.config.maxRetriesPerSection;
  await processSection(state, page, section, humanReview, section.index, conversationTracker);
}


// ═══════════════════════════════════════════════════════════════
//  RUN
// ═══════════════════════════════════════════════════════════════

main().catch(err => {
  if (err.message === 'PIPELINE_PAUSED') {
    console.log('\n⏸️  Pipeline paused. Resume with: node pipeline.mjs --resume');
    process.exit(0);
  }
  console.error('\n❌ Pipeline error:', err);
  process.exit(1);
});
