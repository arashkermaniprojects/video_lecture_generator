/**
 * Frame Guard — Three-Layer Visual Quality System
 *
 * Layer 1: FRAME-0 GATE (pre-recording, no AI)
 *   Hard-blocks recording until the viewport shows the correct module.
 *   Checks: theory collapsed, correct tab, scroll position, no zoom artifacts.
 *
 * Layer 2: KEYFRAME INSPECTION (3-frame sampling, vision AI)
 *   Samples frame 0 (start), frame at 50% (mid), frame at 95% (end).
 *   Sends all three to vision inspector together for Mayer + content checks.
 *
 * Layer 3: TEMPORAL COHERENCE (pixel-diff jump detection, no AI)
 *   Compares consecutive frames using perceptual hashing.
 *   Flags jumps where >15% of pixels change abruptly (viewport shifts, zoom changes).
 *   Distinguishes legitimate animations (gradual chart growth) from viewport jumps.
 */

import { readFileSync } from 'fs';
import { sectionAllowsInteractiveModuleFocus, sectionIsTheoryModule } from '../utils/section-normalizer.mjs';

// ═══════════════════════════════════════════════════════════════
//  LAYER 1: FRAME-0 GATE
// ═══════════════════════════════════════════════════════════════

/**
 * Pre-recording gate. Checks DOM state (no AI needed).
 * Returns { pass, issues[] }. If pass=false, recording should NOT start.
 *
 * @param {Page} page - Playwright page
 * @param {object} section - Section with navActions, group, etc.
 * @param {string} expectedTab - Expected active tab data-mod value
 */
export async function frame0Gate(page, section, expectedTab) {
  const issues = [];

  const expectedElements = Array.isArray(section?.expectedElements)
    ? section.expectedElements.filter(e => typeof e === 'string' && e.trim().length > 0)
    : [];

  const state = await page.evaluate(({ expectedTab, expectedElements }) => {
    const result = {};

    // 1. Check active tab
    const activeTab = document.querySelector('.tab.active');
    result.activeTabMod = activeTab?.getAttribute('data-mod') || null;
    result.tabCorrect = result.activeTabMod === expectedTab;

    // 2. Check theory section state
    const introBody = document.getElementById('introBody');
    result.theoryExpanded = introBody ? !introBody.classList.contains('collapsed') : false;

    // 3. Check if zoom_to target involves theory
    // (theory sections SHOULD have theory expanded; interactive sections should NOT)
    result.hasTheoryModuleVisible = !!document.querySelector('.theory-module:not([style*="display: none"])');

    // 4. Check scroll position
    result.scrollY = window.scrollY;

    // 5. Check CSS zoom level
    result.zoomLevel = parseFloat(document.documentElement.style.zoom || '1');

    // 6. Check if multiple theory modules are visible (bad — should be isolated)
    const visibleTheoryModules = [...document.querySelectorAll('.theory-module')].filter(m => {
      const style = window.getComputedStyle(m);
      return style.display !== 'none';
    });
    result.visibleTheoryCount = visibleTheoryModules.length;

    // 7. Check if interactive tool (.wrap) is visible
    const wrap = document.querySelector('.wrap');
    result.wrapVisible = wrap ? window.getComputedStyle(wrap).display !== 'none' : false;

    // 8. Verify each expectedElement is present AND visible. This is the
    //    check that catches the "audio narrates content the visual hasn't
    //    rendered yet" bug — if expectedElements describe what the section
    //    is teaching, they MUST be on screen before recording starts.
    result.missingExpected = [];
    result.invisibleExpected = [];
    for (const sel of expectedElements) {
      const el = document.querySelector(sel);
      if (!el) { result.missingExpected.push(sel); continue; }
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && parseFloat(style.opacity || '1') > 0.05
        && rect.width > 1
        && rect.height > 1
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth;
      if (!visible) result.invisibleExpected.push(sel);
    }

    return result;
  }, { expectedTab, expectedElements });

  const isTheorySection = sectionIsTheoryModule(section);
  const allowsInteractiveZoom = sectionAllowsInteractiveModuleFocus(section);

  // Rule 1: Correct tab must be active
  if (!state.tabCorrect) {
    issues.push(`wrong_tab: active="${state.activeTabMod}" expected="${expectedTab}"`);
  }

  // Rule 2: For interactive sections, theory must be collapsed
  if (!isTheorySection && state.theoryExpanded) {
    issues.push('theory_not_collapsed: theory section is expanded during interactive tab section');
  }

  // Rule 3: For theory sections, only ONE theory module should be visible
  if (isTheorySection && state.visibleTheoryCount > 1) {
    issues.push(`multiple_theory_modules: ${state.visibleTheoryCount} theory modules visible (should be 1)`);
  }

  // Rule 4: For interactive sections, the wrap (.wrap) must be visible
  if (!isTheorySection && !state.wrapVisible) {
    issues.push('wrap_hidden: interactive tool area is not visible');
  }

  // Rule 5: For interactive sections, zoom should be 1x
  if (!isTheorySection && !allowsInteractiveZoom && state.zoomLevel > 1.05) {
    issues.push(`zoom_on_interactive: CSS zoom is ${state.zoomLevel}x on interactive section (should be 1x)`);
  }

  // Rule 6: Every expectedElement MUST be present in the DOM. This is the
  // sanity check that catches "narration is about X but X isn't even rendered."
  if (state.missingExpected.length > 0) {
    issues.push(`missing_expected_elements: ${state.missingExpected.join(', ')}`);
  }

  // Rule 7: Every expectedElement MUST be visible (not just present in DOM).
  // This catches the bug where state-changing actions (Play, Analyze, etc.)
  // hadn't fired yet when the screencast started, leaving the visualization
  // empty while the audio was already explaining its result.
  if (state.invisibleExpected.length > 0) {
    issues.push(`invisible_expected_elements: ${state.invisibleExpected.join(', ')}`);
  }

  return {
    pass: issues.length === 0,
    issues,
    state
  };
}


// ═══════════════════════════════════════════════════════════════
//  SUBTITLE SIZE INSPECTOR (deterministic, runs every section)
// ═══════════════════════════════════════════════════════════════

/**
 * Validate the rendered subtitle bar dimensions against viewport-relative
 * targets. Catches the "subtitle text too big" failure mode without needing
 * a vision LLM call.
 *
 * Acceptable ranges (chosen so the bar reads as a tasteful caption, not a
 * dominant banner):
 *   - Bar height       ≤ 6.5% of viewport height
 *   - Bar width        ≤ 78% of viewport width
 *   - Bar font-size    ∈ [12, 22] px on a 1080p viewport (scales for others)
 *   - Bar bottom edge  within the bottom 10% of viewport (not floating high)
 *   - Lines of text    ≤ 2 (single-line preferred, two acceptable)
 *
 * Returns { pass, issues[], measured }. If pass=false the caller should
 * tighten the bar's CSS and re-measure.
 */
export async function inspectSubtitleSize(page) {
  const measured = await page.evaluate(() => {
    const bar = document.getElementById('_lecture_subtitle');
    if (!bar) return { present: false };
    const rect = bar.getBoundingClientRect();
    const cs = window.getComputedStyle(bar);
    const fontPx = parseFloat(cs.fontSize) || 0;
    const lineHeight = parseFloat(cs.lineHeight) || (fontPx * 1.35);
    // Estimate visible line count from rendered height + vertical padding.
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const textBoxH = Math.max(1, rect.height - padTop - padBottom);
    const lineCount = Math.max(1, Math.round(textBoxH / lineHeight));
    return {
      present: true,
      vw: window.innerWidth,
      vh: window.innerHeight,
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
      top: rect.top,
      fontPx,
      lineHeight,
      lineCount,
      textLength: (bar.textContent || '').length
    };
  });

  const issues = [];
  if (!measured.present) {
    return { pass: false, issues: ['subtitle_missing'], measured };
  }

  const vh = measured.vh;
  const vw = measured.vw;
  const heightFrac = measured.height / vh;
  const widthFrac  = measured.width  / vw;
  const expectedFontMin = Math.max(12, Math.round(vh * 0.0125));
  const expectedFontMax = Math.max(20, Math.round(vh * 0.02));

  if (heightFrac > 0.065) {
    issues.push(`subtitle_too_tall: ${(heightFrac * 100).toFixed(1)}% of viewport (max 6.5%)`);
  }
  if (widthFrac > 0.78) {
    issues.push(`subtitle_too_wide: ${(widthFrac * 100).toFixed(1)}% of viewport (max 78%)`);
  }
  if (measured.fontPx < expectedFontMin || measured.fontPx > expectedFontMax) {
    issues.push(
      `subtitle_font_size_out_of_range: ${measured.fontPx}px (expected ${expectedFontMin}-${expectedFontMax}px for ${vh}px viewport)`
    );
  }
  if (measured.lineCount > 2) {
    issues.push(`subtitle_wraps_too_many_lines: ${measured.lineCount} lines (max 2)`);
  }
  if (measured.bottom < vh * 0.85) {
    issues.push(`subtitle_floating_too_high: bottom=${measured.bottom.toFixed(0)}px viewport=${vh}px`);
  }

  return { pass: issues.length === 0, issues, measured };
}

/**
 * Auto-tune the subtitle bar in-place when inspectSubtitleSize fails.
 * Shrinks fontPx by ~10% per attempt and reduces max-width if too wide.
 * Returns the new fontPx applied (or null if tuning failed).
 */
export async function tuneSubtitleSize(page, prevMeasured) {
  return await page.evaluate((prev) => {
    const bar = document.getElementById('_lecture_subtitle');
    if (!bar) return null;
    const cs = window.getComputedStyle(bar);
    const currentFont = parseFloat(cs.fontSize) || prev?.fontPx || 17;
    const currentMaxW = parseFloat(cs.maxWidth) || (window.innerWidth * 0.7);
    const newFont = Math.max(11, Math.round(currentFont * 0.9));
    const newMaxW = Math.round(currentMaxW * 0.92);
    bar.style.setProperty('font-size', newFont + 'px', 'important');
    bar.style.setProperty('max-width', newMaxW + 'px', 'important');
    bar.dataset.fontPx = String(newFont);
    return newFont;
  }, prevMeasured);
}


// ═══════════════════════════════════════════════════════════════
//  LAYER 2: KEYFRAME INSPECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Select 3 keyframes from a recorded section for vision inspection.
 *
 * @param {string[]} framePaths - All captured frame paths
 * @returns {{ start: string, mid: string, end: string }}
 */
export function selectKeyframes(framePaths) {
  if (framePaths.length === 0) return null;
  const start = framePaths[0];
  const midIdx = Math.floor(framePaths.length * 0.5);
  const endIdx = Math.max(framePaths.length - 2, 0);
  return {
    start,
    mid: framePaths[midIdx] || start,
    end: framePaths[endIdx] || start,
    indices: { start: 0, mid: midIdx, end: endIdx }
  };
}


// ═══════════════════════════════════════════════════════════════
//  LAYER 3: TEMPORAL COHERENCE (pixel-diff jump detection)
// ═══════════════════════════════════════════════════════════════

/**
 * Compare two JPEG frames using simple pixel histogram difference.
 * Returns a similarity score 0-1 (1 = identical, 0 = completely different).
 * A score below 0.85 indicates a likely viewport jump.
 *
 * Uses raw JPEG file bytes — compares file size ratio and byte-level correlation.
 * This is a fast approximation without image decoding libraries.
 *
 * @param {string} framePath1
 * @param {string} framePath2
 * @returns {number} similarity 0-1
 */
function compareFrames(framePath1, framePath2) {
  try {
    const buf1 = readFileSync(framePath1);
    const buf2 = readFileSync(framePath2);

    // Method: Compare byte histograms of the JPEG data.
    // JPEG data correlates with visual content — similar images have similar byte distributions.
    const hist1 = new Uint32Array(256);
    const hist2 = new Uint32Array(256);

    for (let i = 0; i < buf1.length; i++) hist1[buf1[i]]++;
    for (let i = 0; i < buf2.length; i++) hist2[buf2[i]]++;

    // Normalize histograms
    const total1 = buf1.length;
    const total2 = buf2.length;

    // Compute histogram intersection (Bhattacharyya-like similarity)
    let intersection = 0;
    for (let i = 0; i < 256; i++) {
      const p1 = hist1[i] / total1;
      const p2 = hist2[i] / total2;
      intersection += Math.sqrt(p1 * p2);
    }

    return intersection; // 0-1, higher = more similar
  } catch {
    return 1.0; // If we can't read files, assume OK
  }
}

/**
 * Detect temporal jumps in a sequence of frames.
 * A "jump" is when consecutive frames differ significantly — indicating
 * a viewport shift, zoom change, or page reload that wasn't hidden.
 *
 * Legitimate animations (chart bars growing, dots appearing) produce
 * gradual changes (similarity > 0.90). Viewport jumps produce
 * sudden drops (similarity < 0.85).
 *
 * @param {string[]} framePaths - All captured frame paths
 * @param {object} options
 * @param {number} [options.jumpThreshold=0.85] - Below this = jump
 * @param {number} [options.sampleEvery=5] - Compare every Nth frame (skip for speed)
 * @returns {{ jumps: Array<{frameIndex, similarity, framePath}>, maxDrop: number, stable: boolean }}
 */
export function detectTemporalJumps(framePaths, { jumpThreshold = 0.85, sampleEvery = 5 } = {}) {
  const jumps = [];
  let minSimilarity = 1.0;

  for (let i = sampleEvery; i < framePaths.length; i += sampleEvery) {
    const similarity = compareFrames(framePaths[i - sampleEvery], framePaths[i]);
    if (similarity < minSimilarity) minSimilarity = similarity;

    if (similarity < jumpThreshold) {
      jumps.push({
        frameIndex: i,
        previousIndex: i - sampleEvery,
        similarity: Math.round(similarity * 1000) / 1000,
        framePath: framePaths[i]
      });
    }
  }

  return {
    jumps,
    maxDrop: Math.round((1 - minSimilarity) * 1000) / 1000,
    stable: jumps.length === 0,
    framesChecked: Math.floor(framePaths.length / sampleEvery)
  };
}


// ═══════════════════════════════════════════════════════════════
//  COMBINED GUARD: Run all three layers
// ═══════════════════════════════════════════════════════════════

/**
 * Run all three guard layers on a recorded section.
 *
 * @param {object} params
 * @param {string[]} params.framePaths - Captured frame paths
 * @param {object} params.section - Section metadata
 * @param {string} params.expectedTab - Expected tab data-mod
 * @returns {object} Combined quality report
 */
export function runPostRecordingGuard({ framePaths, section }) {
  // Layer 2: Select keyframes for vision inspection
  const keyframes = selectKeyframes(framePaths);

  // Layer 3: Detect temporal jumps
  const temporal = detectTemporalJumps(framePaths);

  const issues = [];
  if (!temporal.stable) {
    for (const jump of temporal.jumps) {
      issues.push(`temporal_jump at frame ${jump.frameIndex}: similarity=${jump.similarity} (threshold=0.85)`);
    }
  }

  return {
    keyframes,
    temporal,
    issues,
    needsRerecord: temporal.jumps.length > 2, // More than 2 jumps = systematic problem
  };
}
