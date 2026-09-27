/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  PERMANENT FIXES — do not revert these without understanding why ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  1. GROUP_TO_MOD (line ~22): Maps section.group semantic names   ║
 * ║     to HTML data-mod values. Without this, "proofs" → "prover"  ║
 * ║     lookup fails and the page stays on the notations tab.        ║
 * ║                                                                  ║
 * ║  2. planTimedActions ALWAYS injects click_tab at t=0 (2026-03): ║
 * ║     Many sections in sections.json have no click_tab navAction.  ║
 * ║     Without this, the page silently stays on the previous tab.   ║
 * ║     NEVER remove this — sections.json will always be incomplete. ║
 * ║                                                                  ║
 * ║  3. Force full reload via page.reload() (2026-03-23):            ║
 * ║     waitUntil:'networkidle' for file:// resolves IMMEDIATELY     ║
 * ║     (no network = always idle), so page.evaluate fired before    ║
 * ║     page scripts ran. btn was null → if(btn) guard → silent noop.║
 * ║     ALSO: file:// URLs IGNORE query params (?r=Date.now()) —     ║
 * ║     browser sees same URL, so no reload actually happens.        ║
 * ║     ONLY page.reload() guarantees a full reload for file:// URLs.║
 * ║     waitForSelector('.tab') confirms DOM is ready before click.  ║
 * ║     DO NOT revert to page.goto or 'networkidle' for file:// URLs.║
 * ║                                                                  ║
 * ║  4. planTimedActions always injects click_tab at t=0: belt-and-  ║
 * ║     suspenders for fix 3. Also uses page.click() (real events).  ║
 * ║                                                                  ║
 * ║  5. display:none on inactive viz divs (2026-03-23):              ║
 * ║     Space-utilization fix added display:flex to ALL viz div      ║
 * ║     inline styles. Inline style beats CSS .module{display:none}, ║
 * ║     so ALL viz panels were visible simultaneously — the notations ║
 * ║     panel was always on top, tab switch had no visible effect.   ║
 * ║     Fix: Asymptotic_Notation_Explorer.html — set display:none    ║
 * ║     on viz-iterative/recursive/prover/challenge inline styles.   ║
 * ║     DO NOT add display:flex to any inactive viz div inline style.║
 * ║                                                                  ║
 * ║  6. DOM panel verification (2026-03-23): After tab click, check  ║
 * ║     BOTH the button (.tab.active) AND the panel (computed style  ║
 * ║     display !== 'none'). Button-only check gave false positives. ║
 * ║                                                                  ║
 * ║  7. Pre-select algorithm before recording (2026-03-23): For      ║
 * ║     iterative/recursive sections, call selectIterAlgo/RecAlgo()  ║
 * ║     before recording starts so the chart renders from frame 0.  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

/**
 * Recording Agent — Live Synchronized Capture
 *
 * Records the browser screen IN REAL TIME while executing timed
 * navigation actions. This ensures audio-visual sync:
 *
 *   1. TTS audio is generated FIRST → we know exact duration
 *   2. Nav actions are spread across that duration with timestamps
 *   3. CDP screencast captures frames while actions execute
 *   4. Result: frames that progress in sync with narration
 *
 * This replaces the old static-screenshot approach which showed
 * one frozen image for the entire narration duration.
 */

import { join } from 'path';
import { writeFile } from 'fs/promises';
import { executeNavActions, moveCursorTo, hideCursor } from './navigator.mjs';
import { sectionAllowsInteractiveModuleFocus, sectionIsTheoryModule } from '../utils/section-normalizer.mjs';

// ─── General-purpose interactive control discovery ───────────────────────────
//
// Instead of hardcoding button names ("Auto Play", "Animate All"), the recorder
// discovers which buttons are available on the current page and categorizes them.
// This works for ANY HTML tool, regardless of button labels.
//
// Categories:
//   fullAnimation — buttons that run the complete animation/visualization
//   singleStep   — buttons that advance one step at a time
//   reset        — buttons that reset state
//
// When the recorder encounters a single-step navAction, it automatically replaces
// it with the discovered full-animation button (if available).

// Priority order matters: play/animate/run verbs are strongest indicators of
// "run the full animation". Exclude "compare" (runs all cases, not animation).
const FULL_ANIM_PATTERNS = /auto\s*play|animate\s*all|play\s*all|run\s*all|play\s*through|run\s*animation|step\s*through\s*all|expand\s*all|reveal\s*all/i;
const SINGLE_STEP_PATTERNS = /next\s*step|next\s*level|step\s*forward|advance\b/i;
const RESET_PATTERNS = /\breset\b|\brestart\b|\bclear\b|start\s*over/i;
// Buttons to NEVER use as animation replacements (they change mode, not animate):
const EXCLUDE_PATTERNS = /compare\s*all|show\s*all\s*cases|run\s*all\s*cases/i;

/**
 * Discover interactive buttons on the current page and categorize them.
 * Returns: { fullAnimation: string|null, singleStep: string|null, reset: string|null, all: string[] }
 */
async function discoverButtons(page) {
  return page.evaluate((patterns) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    // Only look at VISIBLE buttons (display !== none, not in hidden parent)
    const visible = buttons.filter(b => {
      const style = window.getComputedStyle(b);
      return style.display !== 'none' && style.visibility !== 'hidden' && b.offsetParent !== null;
    });

    const result = { fullAnimation: null, singleStep: null, reset: null, all: [] };
    for (const b of visible) {
      const text = b.textContent.trim();
      if (!text) continue;
      result.all.push(text);
      // Skip excluded buttons (e.g. "Compare All Cases" changes mode, not animation)
      if (new RegExp(patterns.exclude, 'i').test(text)) continue;
      if (new RegExp(patterns.full, 'i').test(text) && !result.fullAnimation) {
        result.fullAnimation = text;
      } else if (new RegExp(patterns.single, 'i').test(text) && !result.singleStep) {
        result.singleStep = text;
      } else if (new RegExp(patterns.reset, 'i').test(text) && !result.reset) {
        result.reset = text;
      }
    }
    return result;
  }, {
    full: FULL_ANIM_PATTERNS.source,
    single: SINGLE_STEP_PATTERNS.source,
    reset: RESET_PATTERNS.source,
    exclude: EXCLUDE_PATTERNS.source,
  }).catch(() => ({ fullAnimation: null, singleStep: null, reset: null, all: [] }));
}

/**
 * Check if a button text matches single-step patterns (should be replaced with full animation).
 */
function isSingleStepButton(text) {
  return SINGLE_STEP_PATTERNS.test(text || '');
}

// Maps semantic section group names to the HTML tab's data-mod attribute value.
// section.group is a high-level category; data-mod is what the DOM actually uses.
// Includes mappings for multiple tools — unknown groups fall through to the
// group name itself (which is often the data-mod value when sections are auto-generated).
const GROUP_TO_MOD = {
  // Asymptotic Notation Explorer
  notations:          'notations',
  introduction:       'notations',
  intro:              'notations',
  overview:           'notations',
  iterative:          'iterative',
  'iterative-analysis': 'iterative',
  analysis:           'iterative',
  recursive:          'recursive',
  'recursive-analysis': 'recursive',
  recursion:          'recursive',
  prover:             'prover',
  proofs:             'prover',
  proof:              'prover',
  'proof-builder':    'prover',
  challenge:          'challenge',
  'challenge-mode':   'challenge',
  // RLHF Interactive Lecture
  pipeline:           '0',
  'reward-model':     '1',
  'reward_model':     '1',
  reward:             '1',
  ppo:                '2',
  'ppo-optimisation':  '2',
  'kl-divergence':    '3',
  kl:                 '3',
  'dpo-vs-rlhf':      '4',
  dpo:                '4',
  comparison:         '4',
  prologue:           '0',
  epilogue:           '0',
  theory:             '0',
  // Recurrence Relations Explorer
  tree:               'tree',
  'recursion-tree':   'tree',
  'recursion_tree':   'tree',
  master:             'master',
  'master-theorem':   'master',
  'master_theorem':   'master',
  sub:                'sub',
  substitution:       'sub',
  'substitution-method': 'sub',
};

// ─── DOM subtitle overlay ────────────────────────────────────────────────────

/**
 * Inject a fixed subtitle bar at the bottom of the page.
 * It's part of the DOM so it appears in every screenshot automatically.
 */
async function injectSubtitleOverlay(page) {
  await page.evaluate(() => {
    const readZoom = () => {
      const computed = window.getComputedStyle(document.documentElement).zoom;
      const raw = parseFloat(document.documentElement.style.zoom || computed || '1');
      return Number.isFinite(raw) && raw > 0 ? raw : 1;
    };

    const existing = document.getElementById('_lecture_subtitle');
    if (existing) {
      if (typeof window.__lectureSetSubtitleScale === 'function') {
        window.__lectureSetSubtitleScale(readZoom());
      }
      return;
    }
    // PERMANENT FIX (2026-04-10): Subtitle sizing.
    //
    // Old bar: full-viewport width, font-size:17px hard, padding:8/9px,
    //          min-height:40px → ~50px tall (~5% of 1080p) and spanned
    //          the whole 1920px width. Visually too dominant relative to
    //          the actual lecture content, especially for sections where
    //          the focused module is itself zoomed/narrow.
    //
    // New bar: width capped at 70% of viewport, centered with rounded
    //          corners, font sized to 1.55% of viewport height (~17px on
    //          1080p but scales sensibly for other viewports), tighter
    //          padding. Actual rendered dimensions are validated by
    //          checkSubtitleDimensions() below — if the result falls
    //          outside the safe range, the size is auto-tuned.
    const vw = Math.max(640, window.innerWidth || 1920);
    const vh = Math.max(360, window.innerHeight || 1080);
    const fontPx = Math.max(13, Math.min(20, Math.round(vh * 0.0155)));
    const padY = Math.max(4, Math.round(vh * 0.006));
    const padX = Math.max(14, Math.round(vw * 0.018));
    const maxW = Math.round(vw * 0.70);
    const bar = document.createElement('div');
    bar.id = '_lecture_subtitle';
    bar.dataset.fontPx = String(fontPx);
    bar.style.cssText = [
      'position:fixed',
      `bottom:${Math.round(vh * 0.025)}px`,
      'left:50%',
      'transform:translateX(-50%)',
      `max-width:${maxW}px`,
      `width:max-content`,
      'background:rgba(0,0,0,0.78)',
      'color:#fff',
      `font-size:${fontPx}px`,
      'font-family:system-ui,-apple-system,Helvetica,sans-serif',
      `padding:${padY}px ${padX}px`,
      'text-align:center',
      'z-index:2000000',
      'line-height:1.35',
      'letter-spacing:0.01em',
      'border-radius:8px',
      'border:1px solid rgba(255,255,255,0.10)',
      'opacity:1',
      'transition:opacity 0.25s',
      'box-shadow:0 4px 14px rgba(0,0,0,0.35)',
    ].join(';');
    document.body.appendChild(bar);

    window.__lectureSetSubtitleScale = (scaleValue) => {
      const safeScale = Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 1;
      // Compose translateX(-50%) (centering) with the inverse-zoom scale.
      // Without composing, setting bar.style.transform = scale(...) would
      // wipe the centering and the bar would jump to the left edge.
      if (Math.abs(safeScale - 1) < 0.02) {
        bar.style.transformOrigin = '';
        bar.style.transform = 'translateX(-50%)';
        return;
      }
      bar.style.transformOrigin = 'center bottom';
      bar.style.transform = `translateX(-50%) scale(${1 / safeScale})`;
    };

    // Dynamically measure the space above .wrap and set panel heights so
    // nothing overflows the viewport or gets hidden behind the subtitle bar.
    //
    // Why dynamic measurement (not static calc)?
    //   The page layout is: header(~39px) + tabs-with-margin(~60px) + wrap.
    //   wrap has padding: 14px top + 18px bottom = 32px.
    //   vizPanel's natural height (calc(100vh-70px)=1010px) overflows the wrap
    //   content box, pushing the body to 1141px (61px > 1080px viewport).
    //   A static CSS calc cannot know the actual rendered header+tabs height
    //   (font rendering, zoom, OS DPI). JS measurement is exact.
    //
    // The subtitle bar floats above the bottom edge with a small margin.
    // We want: vizPanel bottom ≤ viewport.bottom - subtitleReserved
    // (so the bar doesn't cover chart content). subtitleReserved is measured
    // dynamically from the bar itself once it's been laid out.
    const subtitleRect = bar.getBoundingClientRect();
    const subtitleReserved = Math.max(38, Math.round(
      (vh - subtitleRect.top) + 8  // bottom edge of bar + a little breathing room
    ));
    const wrapEl = document.querySelector('.wrap');
    const vizEl  = document.querySelector('.vizPanel');
    const panEl  = document.querySelector('.panel');
    if (wrapEl && vizEl) {
      const wrapRect    = wrapEl.getBoundingClientRect();
      const padTop      = parseInt(getComputedStyle(wrapEl).paddingTop)    || 14;
      const padBottom   = parseInt(getComputedStyle(wrapEl).paddingBottom) || 18;
      const subtitleH   = subtitleReserved;
      const available   = window.innerHeight - wrapRect.top - padTop - padBottom - subtitleH;
      const panelHeight = Math.max(200, Math.floor(available));
      vizEl.style.setProperty('height',     panelHeight + 'px', 'important');
      vizEl.style.setProperty('overflow',   'hidden',           'important');
      if (panEl) {
        panEl.style.setProperty('max-height', panelHeight + 'px', 'important');
      }
      // Remove .wrap's min-height: it was calc(100vh-52px)=1028px, which forces
      // the body taller than the viewport even after we shrink the vizPanel.
      wrapEl.style.setProperty('min-height', '0', 'important');
    }

    const style = document.createElement('style');
    style.id = '_lecture_subtitle_css';
    style.textContent = '';
    document.head.appendChild(style);

    window.__lectureSetSubtitleScale(readZoom());
  });
}

/**
 * Convert verbal math narration to proper symbolic notation for display.
 * The TTS audio uses verbal forms; subtitles should show real math.
 */
function toMathNotation(text) {
  return text
    // Greek letters first (standalone words, case-insensitive)
    .replace(/\bTheta\b/g, 'Θ').replace(/\btheta\b/g, 'Θ')
    .replace(/\bOmega\b/g, 'Ω').replace(/\bomega\b/g, 'Ω')
    .replace(/\bEpsilon\b/g, 'ε').replace(/\bepsilon\b/g, 'ε')
    .replace(/\bDelta\b/g, 'Δ').replace(/\bdelta\b/g, 'Δ')
    .replace(/\bAlpha\b/g, 'α').replace(/\balpha\b/g, 'α')
    .replace(/\bBeta\b/g, 'β').replace(/\bbeta\b/g, 'β')
    // Exponents: "n squared" → "n²", "n cubed" → "n³", "n to the k" → "nᵏ"
    .replace(/\bn squared\b/gi, 'n²')
    .replace(/\bn cubed\b/gi, 'n³')
    .replace(/\bn to the (\w+)\b/gi, (_, e) => {
      const sup = { '2':'²','3':'³','4':'⁴','k':'ᵏ','i':'ⁱ','j':'ʲ' };
      return 'n' + (sup[e] || `^${e}`);
    })
    .replace(/\b2 to the n\b/gi, '2ⁿ')
    .replace(/\b2 to the power of n\b/gi, '2ⁿ')
    // "f of n" → "f(n)", "T of n" → "T(n)", etc.
    .replace(/\b([fgThT])\s+of\s+n\b/g, '$1(n)')
    .replace(/\b([fgThT])\s+of\s+([a-z])\b/g, '$1($2)')
    // Asymptotic forms: "O of n squared" → "O(n²)", etc.
    .replace(/\bO\s+of\s+n squared\b/gi, 'O(n²)')
    .replace(/\bO\s+of\s+n cubed\b/gi, 'O(n³)')
    .replace(/\bO\s+of\s+n log n\b/gi, 'O(n log n)')
    .replace(/\bO\s+of\s+log n\b/gi, 'O(log n)')
    .replace(/\bO\s+of\s+one\b/gi, 'O(1)')
    .replace(/\bO\s+of\s+n\b/gi, 'O(n)')
    .replace(/\bΘ\s+of\s+n squared\b/gi, 'Θ(n²)')
    .replace(/\bΘ\s+of\s+n cubed\b/gi, 'Θ(n³)')
    .replace(/\bΘ\s+of\s+n log n\b/gi, 'Θ(n log n)')
    .replace(/\bΘ\s+of\s+log n\b/gi, 'Θ(log n)')
    .replace(/\bΘ\s+of\s+one\b/gi, 'Θ(1)')
    .replace(/\bΘ\s+of\s+n\b/gi, 'Θ(n)')
    .replace(/\bΩ\s+of\s+n squared\b/gi, 'Ω(n²)')
    .replace(/\bΩ\s+of\s+n cubed\b/gi, 'Ω(n³)')
    .replace(/\bΩ\s+of\s+n log n\b/gi, 'Ω(n log n)')
    .replace(/\bΩ\s+of\s+log n\b/gi, 'Ω(log n)')
    .replace(/\bΩ\s+of\s+one\b/gi, 'Ω(1)')
    .replace(/\bΩ\s+of\s+n\b/gi, 'Ω(n)')
    // "big O" / "big-O" → just use O (already in context)
    .replace(/\bbig[-\s]?O\b/g, 'O')
    .replace(/\bbig[-\s]?Θ\b/g, 'Θ')
    .replace(/\bbig[-\s]?Ω\b/g, 'Ω')
    // Multiplication: "n times log n" → "n·log n"
    .replace(/\bn times log n\b/gi, 'n·log n')
    .replace(/\bn times n\b/gi, 'n²');
}

/** Fade out → swap text → fade in. */
async function updateSubtitle(page, text) {
  const displayText = toMathNotation(text);
  await page.evaluate((t) => {
    const bar = document.getElementById('_lecture_subtitle');
    if (!bar) return;
    bar.style.opacity = '0';
    setTimeout(() => { bar.textContent = t; bar.style.opacity = '1'; }, 200);
  }, displayText);
}

/**
 * Split narration into individual sentences for live cycling.
 * Keeps short fragments attached to the previous sentence.
 */
function splitSentences(text) {
  const raw = text.match(/[^.!?]*[.!?]+["']?/g) || [text];
  const result = [];
  for (const s of raw) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    // Attach very short fragments (< 25 chars) to previous sentence
    if (trimmed.length < 25 && result.length > 0) {
      result[result.length - 1] += ' ' + trimmed;
    } else {
      result.push(trimmed);
    }
  }
  return result.length ? result : [text];
}

/**
 * Build a schedule of { atMs, text } subtitle updates synchronized with speech.
 *
 * Three strategies, in order of accuracy:
 *   1. Whisper timestamps (exact) — provided by tts-agent after transcribing the
 *      generated audio. Each sentence start is derived from actual word timings.
 *   2. Word-proportional (good) — distributes time proportional to word count,
 *      matching TTS's roughly constant words-per-minute rate.
 *   3. Equal intervals (legacy, no longer used) — was the old approach that
 *      caused subtitle drift; kept only as documentation of what changed.
 */
function planSubtitleSchedule(narration, durationMs, sentenceTimestamps = null) {
  if (!narration) return [];

  // ── Strategy 1: Whisper-aligned timestamps (best) ──
  if (sentenceTimestamps && sentenceTimestamps.length > 0) {
    return sentenceTimestamps.map(st => ({ atMs: st.atMs, text: st.text }));
  }

  // ── Strategy 2: Word-proportional timing (fallback) ──
  const sentences = splitSentences(narration);
  const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);

  if (totalWords === 0) {
    return sentences.map((text, i) => ({
      atMs: Math.round(i * (durationMs / sentences.length)), text
    }));
  }

  let cumulativeWords = 0;
  return sentences.map((text, i) => {
    const atMs = Math.round((cumulativeWords / totalWords) * durationMs);
    cumulativeWords += wordCounts[i];
    return { atMs, text };
  });
}

/**
 * Start a periodic screenshot capture session.
 *
 * Replaces CDP Page.startScreencast which silently emits 0 frames in
 * headless Chromium when the page has no DOM changes (static content).
 * Periodic page.screenshot() works unconditionally — it forces a capture
 * on a timer regardless of whether the browser is actively repainting.
 */
export async function startScreencast(page, options = {}) {
  const { fps = 5, quality = 85 } = options;
  const intervalMs = Math.round(1000 / fps);

  const frames = [];
  let frameCount = 0;
  let active = true;
  let busy = false;  // prevent overlapping captures

  const tick = async () => {
    if (!active || busy) return;
    busy = true;
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality });
      if (active) {
        frames.push({ data: buffer, timestamp: Date.now() / 1000, index: frameCount++ });
      }
    } catch { /* page may be navigating — skip frame */ }
    busy = false;
  };

  const timer = setInterval(tick, intervalMs);
  // Capture first frame immediately so we don't miss the opening state
  tick();

  return {
    frames,
    stop: async () => {
      active = false;
      clearInterval(timer);
      // Wait for any in-flight capture to finish
      await new Promise(r => setTimeout(r, intervalMs + 50));
      return frames;
    }
  };
}

/**
 * Capture a single high-quality screenshot.
 */
export async function captureStaticFrame(page, outputPath) {
  await page.screenshot({
    path: outputPath,
    type: 'jpeg',
    quality: 95,
    fullPage: false
  });
  return outputPath;
}

/**
 * Plan timed actions across the audio duration.
 * Spreads nav actions evenly, with cursor moves at key moments.
 *
 * Returns: [{ atMs: 0, actions: [...] }, { atMs: 5000, actions: [...] }, ...]
 */
/**
 * Simplified timed action planning for presentation-mode (goto_module) sections.
 * No tab injection needed — the module URL handles all setup.
 * Interactions fire early (5-30%), display actions fire at 50-80%.
 */
function planTimedActionsForModule(actions, audioDurationMs) {
  const interactions = [];
  const display = [];
  for (const a of actions) {
    if (['click_selector','click_button','click_nth','set_select','set_slider',
         'wait_for_animation','wait','step_through','set_play_speed'].includes(a.action)) {
      interactions.push(a);
    } else {
      display.push(a);
    }
  }
  const timed = [];
  // Interactions: 5% to 30% of duration
  interactions.forEach((a, i) => {
    const t = Math.round(audioDurationMs * (0.05 + 0.25 * i / Math.max(interactions.length, 1)));
    timed.push({ timeMs: t, action: a });
  });
  // Display actions: 50% to 80%
  display.forEach((a, i) => {
    const t = Math.round(audioDurationMs * (0.50 + 0.30 * i / Math.max(display.length, 1)));
    timed.push({ timeMs: t, action: a });
  });
  timed.sort((a, b) => a.timeMs - b.timeMs);
  return timed;
}

function planTimedActions(section, audioDurationMs) {
  const navActions = section.navActions || [];

  // Determine the section's target tab.
  // Prefer the explicit click_tab action target (uses exact data-mod values) over
  // section.group which is a semantic category that may not match data-mod directly.
  const targetTab = navActions.find(a => a.action === 'click_tab')?.target
    ?? GROUP_TO_MOD[section.group]
    ?? null;

  // PERMANENT FIX (2026-03-23): ALWAYS inject click_tab at t=0.
  // Many sections in sections.json have no click_tab in navActions.
  // Without this explicit click, a section with no click_tab silently stays on
  // whatever tab was last active — causing entire tab groups to show the wrong tab.
  // page.goto hash changes do NOT reload the page in Playwright, so the HTML hash
  // IIFE never fires. This explicit click is the ONLY reliable mechanism.
  // DO NOT remove this or make it conditional on navActions having click_tab.
  const setupActions = [];
  if (targetTab) {
    setupActions.push({ action: 'click_tab', target: targetTab });
    setupActions.push({ action: 'wait', ms: 600 });
  }

  // PERMANENT FIX (2026-04-10): Classify nav actions into TWO buckets only.
  //
  //   setupActions   — EVERYTHING that changes visible state must finish BEFORE
  //                    the screencast starts. This guarantees frame 0 already
  //                    shows the post-action result (animation playing, button
  //                    pressed, dropdown chosen). Includes click_button,
  //                    click_selector, click_nth, set_select, set_slider,
  //                    wait_for_animation, plus the existing zoom_to / waits.
  //
  //   displayActions — Pure-visual actions that don't change page content:
  //                    move_cursor_to, scroll_to. These stay timed during the
  //                    recording so the cursor sweeps in sync with narration.
  //
  // ROOT CAUSE BEING FIXED: Previously click_button et al. fired at 10–30% of
  // audio duration, AFTER startScreencast had already captured frame 0. So the
  // first 10–30% of every section showed the page in its *pre-click* state
  // while the audio narrated the *post-click* content. The frame-0 gate didn't
  // catch this because it only inspected tab/zoom/scroll, not whether the
  // expectedElements actually rendered. The user's complaint — "narrator
  // explains a bit of each section while the picture is showing the first
  // slide" — is exactly this race.
  //
  // ALL click_tab actions from navActions are still dropped — tab is handled
  // by the forced inject above.
  const displayActions = [];

  for (const a of navActions) {
    if (a.action === 'click_tab') {
      // Dropped — always handled by forced inject above
    } else if (a.action === 'zoom_to' || a.action === 'reset_zoom') {
      // zoom_to/reset_zoom MUST execute at t=0 (before recording starts)
      // so the first captured frame already shows the zoomed/isolated module.
      // ONLY the FIRST zoom_to goes to setup — subsequent zoom_to in the same
      // section would cause visible jumps during recording. Drop them.
      const alreadyHasZoom = setupActions.some(x => x.action === 'zoom_to');
      if (a.action === 'reset_zoom' || !alreadyHasZoom) {
        setupActions.push(a);
      }
    } else if (a.action === 'wait') {
      // All waits go to setup — they're page-state stabilization, never visual.
      setupActions.push(a);
    } else if (['set_select', 'set_slider', 'click_button', 'click_selector',
                'click_nth', 'wait_for_animation'].includes(a.action)) {
      // STATE-CHANGING actions → setup (must complete before screencast).
      // A short settle wait follows each so the DOM/animation has time to
      // commit to the GPU compositor before the next action or before the
      // screencast captures frame 0.
      setupActions.push(a);
      setupActions.push({ action: 'wait', ms: 350 });
    } else {
      // move_cursor_to, scroll_to, scroll_top, scroll_bottom, wait_for_selector
      displayActions.push(a);
    }
  }

  const timedPlan = [];

  // Setup actions always execute immediately (t=0) — BEFORE screencast starts.
  if (setupActions.length > 0) {
    timedPlan.push({ atMs: 0, actions: setupActions });
  }

  // Display actions (cursor sweeps, scrolls): spread across 25–85% of audio
  // duration so they happen mid-narration when the relevant words are spoken.
  if (displayActions.length > 0) {
    const startMs = Math.round(audioDurationMs * 0.25);
    const endMs   = Math.round(audioDurationMs * 0.85);
    const spanMs  = endMs - startMs;
    const gap = displayActions.length > 1
      ? spanMs / (displayActions.length - 1)
      : 0;
    for (let i = 0; i < displayActions.length; i++) {
      const atMs = startMs + Math.round(gap * i);
      timedPlan.push({ atMs, actions: [displayActions[i]] });
    }
  }

  return timedPlan;
}

function splitPreStepActions(navActions = []) {
  const pre = [];
  const post = [];
  let seenStepThrough = false;

  for (const action of navActions) {
    if (action.action === 'step_through') {
      seenStepThrough = true;
      post.push(action);
      continue;
    }

    if (!seenStepThrough) {
      if (action.action === 'move_cursor_to') continue;
      if (action.action === 'wait' && Number(action.ms || 0) > 900) continue;
      pre.push(action);
    } else {
      post.push(action);
    }
  }

  return { pre, post, hasStepThrough: seenStepThrough };
}

/**
 * Record a section with LIVE synchronized capture.
 *
 * @param {Page} page - Playwright page (already navigated to tool)
 * @param {object} section - Section definition with navActions
 * @param {string} outputDir - Directory for frame files
 * @param {number} audioDurationMs - Duration of TTS audio in milliseconds
 * @returns {object} { type, framePaths, frameCount }
 */
export async function recordSectionLive(page, section, outputDir, audioDurationMs, sentenceTimestamps = null) {
  const durationMs = audioDurationMs || 15000; // fallback 15s
  const sectionId = section.id;

  console.log(`   🎬 Live recording ${sectionId} (${(durationMs/1000).toFixed(1)}s)...`);

  // ── PRESENTATION MODE: goto_module bypasses all tab/reload logic ──────────
  const gotoModuleAction = (section.navActions || []).find(a => a.action === 'goto_module');
  if (gotoModuleAction) {
    // Navigate to the module URL — presentation mode handles isolation + zoom
    const currentUrl = new URL(page.url());
    currentUrl.searchParams.set('module', gotoModuleAction.target);
    await page.goto(currentUrl.toString(), { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const { injectCursorOverlay } = await import('./navigator.mjs');
    await injectCursorOverlay(page);
    await injectSubtitleOverlay(page);

    // Separate step_through from other actions — it must be handled inline with frame capture
    const remainingActions = section.navActions.filter(a => a.action !== 'goto_module');
    const stepThroughAction = remainingActions.find(a => a.action === 'step_through');
    const otherActions = remainingActions.filter(a => a.action !== 'step_through');

    // Execute non-step actions first (build, set_play_speed, etc.) immediately
    for (const a of otherActions) {
      await executeNavActions(page, [a]);
    }

    // Capture frames
    const framesDir = join(outputDir, sectionId);
    await writeFile(join(framesDir, '.keep'), '', 'utf-8').catch(() => {});
    const { mkdir: mkdirAsync } = await import('fs/promises');
    await mkdirAsync(framesDir, { recursive: true });

    const framePaths = [];
    const sentences = sentenceTimestamps || [];
    let sentenceIdx = 0;
    const frameInterval = 200; // ~5 fps

    // Helper: capture one frame + update subtitles
    const captureFrame = async () => {
      const elapsed = Date.now() - recordingStart;
      while (sentenceIdx < sentences.length && sentences[sentenceIdx].start * 1000 <= elapsed) {
        const sent = sentences[sentenceIdx];
        await page.evaluate((text) => {
          const bar = document.getElementById('_lecture_subtitle');
          if (bar) bar.textContent = text;
        }, toMathNotation(sent.text || ''));
        sentenceIdx++;
      }
      const framePath = join(framesDir, `frame_${String(framePaths.length).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: framePath, type: 'jpeg', quality: 85 });
      framePaths.push(framePath);
    };

    const recordingStart = Date.now();

    if (stepThroughAction) {
      // ── STEP-THROUGH MODE: click step, capture frames between each step ──
      // This ensures every intermediate step is visible as an animation.
      const stepSel = stepThroughAction.target || '#step';
      const readStepState = async () => page.evaluate(() => {
        const statusText = document.getElementById('status')?.textContent?.trim() || '';
        const stepText = document.getElementById('stepCount')?.textContent?.trim() || '';
        const match = stepText.match(/(\d+)\s*\/\s*(\d+)/);
        const current = match ? Number.parseInt(match[1], 10) : null;
        const total = match ? Number.parseInt(match[2], 10) : null;
        const normalizedStatus = statusText.toLowerCase();
        const done = normalizedStatus.includes('done')
          || normalizedStatus.includes('complete')
          || normalizedStatus.includes('finished')
          || (Number.isFinite(current) && Number.isFinite(total) && total > 0 && current >= total);
        return {
          status: statusText,
          stepText,
          current,
          total,
          done
        };
      });

      // First, get total number of steps to calculate timing
      const initialStepState = await readStepState();
      const totalSteps = Number.isFinite(initialStepState.total) && initialStepState.total > 0
        ? initialStepState.total
        : 10;
      const hardCap = Math.max(
        stepThroughAction.maxClicks || 0,
        totalSteps + 3,
        40
      );

      // Spread steps evenly across audio duration, leaving 10% at start and 10% at end
      const stepStartMs = durationMs * 0.08;
      const stepEndMs = durationMs * 0.88;
      const msPerStep = (stepEndMs - stepStartMs) / Math.max(totalSteps, 1);

      // Capture frames before first step (show initial state)
      while (Date.now() - recordingStart < stepStartMs) {
        await captureFrame();
        await page.waitForTimeout(frameInterval);
      }

      // Click step and capture frames between each
      let executedSteps = 0;
      let stalled = 0;
      for (let i = 0; i < hardCap; i++) {
        const beforeState = await readStepState();
        if (beforeState.done) break;

        // Click step
        await page.click(stepSel).catch(() => {});
        await page.waitForTimeout(300); // let rendering finish

        // Verify step advanced
        let afterState = await readStepState();
        let advanced = afterState.stepText !== beforeState.stepText
          || (
            Number.isFinite(beforeState.current)
            && Number.isFinite(afterState.current)
            && afterState.current > beforeState.current
          );

        // If step didn't advance, try Build first
        if (!advanced && !afterState.done) {
          console.log(`   ⚠️  Step stuck at ${beforeState.stepText || 'unknown'}. Clicking Build...`);
          await page.click('#build').catch(() => {});
          await page.waitForTimeout(500);
          await page.click(stepSel).catch(() => {});
          await page.waitForTimeout(300);
          afterState = await readStepState();
          advanced = afterState.stepText !== beforeState.stepText
            || (
              Number.isFinite(beforeState.current)
              && Number.isFinite(afterState.current)
              && afterState.current > beforeState.current
            )
            || afterState.done;
        }

        if (!advanced && !afterState.done) {
          stalled++;
          if (stalled > 3) {
            console.log(`   ❌ Step remained stuck after ${stalled} retries. Aborting step capture.`);
            break;
          }
        } else {
          executedSteps++;
          stalled = 0;
        }

        // Capture frames for this step's duration (show the change)
        const stepDeadline = recordingStart + stepStartMs + executedSteps * msPerStep;
        while (Date.now() < stepDeadline && Date.now() - recordingStart < durationMs) {
          await captureFrame();
          await page.waitForTimeout(frameInterval);
        }

        if (afterState.done) break;
      }

      // Capture remaining frames after all steps (show final result)
      while (Date.now() - recordingStart < durationMs) {
        await captureFrame();
        await page.waitForTimeout(frameInterval);
      }

    } else {
      // ── NORMAL MODE: timed actions with parallel frame capture ──
      const timedActions = planTimedActionsForModule(otherActions, durationMs);
      let actionIdx = 0;
      // Re-execute other actions as timed (they were already run above for setup,
      // but for play/wait_for_animation sections the timing matters)
      // Actually, other actions were already executed above. Just capture frames.
      while (Date.now() - recordingStart < durationMs) {
        await captureFrame();
        await page.waitForTimeout(frameInterval);
      }
    }

    // ── Breathing pause: fade out content, capture ~1s of dark frames ──
    // This creates a natural pause between modules like a teacher taking a breath.
    const breathMs = 1000;
    const fadeSteps = 5;
    for (let i = 1; i <= fadeSteps; i++) {
      const opacity = 1 - (i / fadeSteps);
      await page.evaluate((op) => {
        const mod = document.querySelector('.active-mod');
        if (mod) mod.style.opacity = String(op);
        const sub = document.getElementById('_lecture_subtitle');
        if (sub) sub.style.opacity = '0';
      }, opacity);
      await page.waitForTimeout(breathMs / fadeSteps / 2);
      const framePath = join(framesDir, `frame_${String(framePaths.length).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: framePath, type: 'jpeg', quality: 85 });
      framePaths.push(framePath);
    }
    // Hold dark for remaining breath
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(breathMs / 5);
      const framePath = join(framesDir, `frame_${String(framePaths.length).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: framePath, type: 'jpeg', quality: 85 });
      framePaths.push(framePath);
    }

    console.log(`   🎬 Captured ${framePaths.length} live frames over ${((durationMs + breathMs)/1000).toFixed(1)}s`);
    return { type: 'live', framePaths, frameCount: framePaths.length, durationMs: durationMs + breathMs };
  }

  // Determine the section's target tab FIRST — needed for URL hash below.
  // navActions' click_tab target is authoritative (uses actual data-mod value).
  // Fallback: if click_tab has only a text label (no target), map via TAB_TEXT_TO_MOD.
  const TAB_TEXT_TO_MOD = {
    // Asymptotic Notation Explorer
    'notation guide': 'notations',
    'notations': 'notations',
    'iterative analysis': 'iterative',
    'iterative': 'iterative',
    'recursive analysis': 'recursive',
    'recursive': 'recursive',
    'proof builder': 'prover',
    'prover': 'prover',
    'challenge mode': 'challenge',
    'challenge': 'challenge',
    // RLHF Interactive Lecture
    'pipeline': '0',
    'reward model': '1',
    'ppo': '2',
    'kl divergence': '3',
    'dpo vs rlhf': '4',
  };
  const clickTabAction = (section.navActions || []).find(a => a.action === 'click_tab');
  // Also infer tab from expectedElements when no click_tab is present
  const EL_TO_TAB = {
    // Asymptotic Notation Explorer
    '#challenge-content': 'challenge',
    '.quiz-option': 'challenge',
    '#svg-iterative': 'iterative',
    '#svg-recursive': 'recursive',
    '#proof-content': 'prover',
    // RLHF Interactive Lecture
    '#pipelineSvg': '0',
    '#rmSvg': '1',
    '#ppoSvg': '2',
    '#ppoFrontierSvg': '2',
    '#klOverlaySvg': '3',
    '#klContribSvg': '3',
    '#dpoSvg': '4',
  };
  const inferredFromEl = !clickTabAction
    ? Object.entries(EL_TO_TAB).find(([el]) =>
        (section.expectedElements || []).includes(el) ||
        (section.navActions || []).some(a => a.target === el)
      )?.[1] ?? null
    : null;
  const sectionTargetTab = clickTabAction?.target
    || (clickTabAction?.text ? TAB_TEXT_TO_MOD[clickTabAction.text.toLowerCase()] : null)
    || inferredFromEl
    || GROUP_TO_MOD[section.group]
    || section.group || null;

  // PERMANENT FIX (2026-04-10): compute the theory-section flag UPFRONT,
  // before any of the pre-recording reset blocks run. The reset blocks below
  // collapse #introBody unconditionally, which made theory sections (whose
  // content lives INSIDE introBody) fail the frame-0 gate with
  // "invisible_expected_elements: #sec1". For RSA-style single-page tools
  // where every theory section is sec1..sec10 inside introBody, this caused
  // every theory section past the first to fail.
  const sectionWantsTheoryView = sectionIsTheoryModule(section);

  // Reload the page before every section to guarantee clean state.
  // Skip reload if the page is already showing the correct target tab —
  // reloading resets to Notation Guide, destroying tab state that the
  // previous section left in place. Within a tab group (e.g. all iterative
  // sections), keep the tab active and only reset scroll + cursor.
  // Default to the first tab's data-mod only when the tool actually has tabs.
  // Single-page tools should preserve state across sections instead of being
  // forced through a fake fallback tab like "notations".
  const firstTabMod = await page.evaluate(() =>
    document.querySelector('.tab')?.getAttribute('data-mod') || null
  ).catch(() => null);
  const effectiveTarget = sectionTargetTab || firstTabMod || null;
  const currentActiveTab = await page.evaluate(() =>
    document.querySelector('.tab.active')?.getAttribute('data-mod') || null
  ).catch(() => null);

  if (currentActiveTab !== effectiveTarget) {
    // Different tab needed (or fresh/unknown page) — full reload for clean state
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.tab', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    // CRITICAL: After reload, collapse the theory section IMMEDIATELY.
    // The theory section is expanded by default in the HTML source.
    // If left expanded, it fills the viewport above the tab content,
    // causing the "multiple modules visible" problem in frame 0.
    await page.evaluate((wantsTheory) => {
      document.documentElement.style.zoom = '1';
      if (typeof window.__lectureSetSubtitleScale === 'function') {
        window.__lectureSetSubtitleScale(1);
      }
      document.querySelectorAll('[data-zoom-hidden]').forEach(h => { h.style.display = ''; h.removeAttribute('data-zoom-hidden'); });
      document.querySelectorAll('[data-zoom-scaled]').forEach(s => { s.style.transform = ''; s.style.transformOrigin = ''; s.removeAttribute('data-zoom-scaled'); });
      // Collapse theory section ONLY for non-theory sections — theory sections
      // need it expanded to be visible.
      const introBody = document.getElementById('introBody');
      if (introBody) {
        if (wantsTheory) {
          introBody.classList.remove('collapsed');
        } else if (!introBody.classList.contains('collapsed')) {
          introBody.classList.add('collapsed');
        }
      }
      window.scrollTo(0, 0);
    }, sectionWantsTheoryView);
    await page.waitForTimeout(300);
  } else {
    // Already on the correct tab — just reset scroll, zoom, transforms, and collapse theory
    await page.evaluate((wantsTheory) => {
      window.scrollTo(0, 0);
      document.documentElement.style.zoom = '1';
      if (typeof window.__lectureSetSubtitleScale === 'function') {
        window.__lectureSetSubtitleScale(1);
      }
      document.querySelectorAll('[data-zoom-hidden]').forEach(h => { h.style.display = ''; h.removeAttribute('data-zoom-hidden'); });
      document.querySelectorAll('[data-zoom-scaled]').forEach(s => { s.style.transform = ''; s.style.transformOrigin = ''; s.removeAttribute('data-zoom-scaled'); });
      const introBody = document.getElementById('introBody');
      if (introBody) {
        if (wantsTheory) {
          introBody.classList.remove('collapsed');
        } else if (!introBody.classList.contains('collapsed')) {
          introBody.classList.add('collapsed');
        }
      }
    }, sectionWantsTheoryView);
    await page.waitForTimeout(200);
    console.log(`   ♻️  Skipping reload (tab already on "${effectiveTarget}")`);
  }
  // ═══ UNCONDITIONAL HARD RESET (2026-03-30) ═══════════════════════════════
  // Guarantee a perfectly clean page state before EVERY section, regardless
  // of what the previous section did. This is the single source of truth for
  // page state — no other code path should be trusted to clean up after itself.
  // This fixes the persistent bug where intro/theory zoom state leaked into
  // interactive sections (wrap hidden, intro expanded, fonts boosted).
  //
  // PERMANENT FIX (2026-04-10): the introBody collapse below is now CONDITIONAL.
  // For theory sections (which live INSIDE introBody), we EXPAND it instead.
  // Without this, every theory section past the first one fails the frame-0
  // gate with "invisible_expected_elements: #secN".
  await page.evaluate((wantsTheory) => {
    // 1. Reset CSS zoom
    document.documentElement.style.zoom = '1';
    if (typeof window.__lectureSetSubtitleScale === 'function') {
      window.__lectureSetSubtitleScale(1);
    }
    // 2. Restore ALL elements hidden by theory zoom
    document.querySelectorAll('[data-zoom-hidden]').forEach(h => {
      h.style.display = '';
      h.removeAttribute('data-zoom-hidden');
    });
    // 3. Restore ALL elements scaled/styled by theory zoom
    document.querySelectorAll('[data-zoom-scaled]').forEach(s => {
      s.style.transform = '';
      s.style.transformOrigin = '';
      s.style.display = '';
      s.style.flexDirection = '';
      s.style.justifyContent = '';
      s.style.alignItems = '';
      s.style.minHeight = '';
      s.style.padding = '';
      s.style.width = '';
      s.style.maxWidth = '';
      s.style.margin = '';
      s.removeAttribute('data-zoom-scaled');
    });
    // 4. Reset ALL theory-module font boosts from intro zoom
    document.querySelectorAll('.theory-module').forEach(m => {
      m.style.display = '';
      m.style.fontSize = '';
      m.style.lineHeight = '';
      m.querySelectorAll('p,h3,.math-inline,.tip,.lp-step').forEach(el => {
        el.style.fontSize = '';
        el.style.lineHeight = '';
        el.style.marginBottom = '';
      });
    });
    // 5. Ensure .wrap is visible
    const wrap = document.querySelector('.wrap');
    if (wrap) wrap.style.display = '';
    // 6. Ensure h1, subtitle, intro-header are visible
    const h1 = document.querySelector('h1');
    const subtitle = document.querySelector('.subtitle');
    const footer = document.querySelector('.tut-footer');
    const introHeader = document.querySelector('.intro-header');
    if (h1) h1.style.display = '';
    if (subtitle) subtitle.style.display = '';
    if (footer) footer.style.display = '';
    if (introHeader) introHeader.style.display = '';
    // 7. introBody: collapse for non-theory sections, EXPAND for theory sections
    const introBody = document.getElementById('introBody');
    if (introBody) {
      if (wantsTheory) {
        introBody.classList.remove('collapsed');
      } else if (!introBody.classList.contains('collapsed')) {
        introBody.classList.add('collapsed');
      }
    }
    // 8. Reset scroll
    window.scrollTo(0, 0);
  }, sectionWantsTheoryView);
  await page.waitForTimeout(300);
  // ═══ END HARD RESET ═══════════════════════════════════════════════════════

  const { injectCursorOverlay } = await import('./navigator.mjs');
  await injectCursorOverlay(page);

  // ── ENGINEERING FIX: DOM-verified tab switch (not AI-verified) ─────────────
  //
  // We check TWO things after each tab click attempt:
  //   1. The tab BUTTON has data-mod matching our target (class=active)
  //   2. The viz PANEL (#viz-{tab}) has computed display !== 'none'
  //
  // Previously only (1) was checked — the button was active but the panel
  // was still showing because inactive viz divs had display:flex in their
  // inline style, overriding the CSS .module{display:none} rule.
  //
  // Root cause of the "display:flex overrides display:none" bug (2026-03-23):
  //   Space-utilization fix added display:flex to ALL viz div inline styles.
  //   Since inline style > CSS class, .module{display:none} was silently ignored.
  //   Fix: Set display:none explicitly on inactive viz divs in the HTML source.
  //   This is now done in Asymptotic_Notation_Explorer.html.

  async function verifyPanelVisible(targetTab) {
    return await page.evaluate((tab) => {
      const btn = document.querySelector(`.tab[data-mod="${tab}"]`);
      // Try multiple panel selectors — different tools use different naming
      const panel = document.querySelector(`#viz-${tab}`)
        || document.querySelector(`.moduleViz[data-mod="${tab}"]`)
        || document.querySelector(`.modulePanel[data-mod="${tab}"]`);
      const btnActive = btn?.classList.contains('active') || false;
      const panelVisible = panel ? window.getComputedStyle(panel).display !== 'none' : true;  // default true if no panel found
      return { btnActive, panelVisible, ok: btnActive && (panelVisible || !panel) };
    }, targetTab);
  }

  if (sectionTargetTab) {
    for (let attempt = 0; attempt < 5; attempt++) {
      // Use page.evaluate btn.click() — directly calls DOM click() in page JS context.
      // More reliable than Playwright's CDP-based page.click() for file:// URLs.
      await page.evaluate((tab) => {
        const btn = document.querySelector(`.tab[data-mod="${tab}"]`);
        if (btn) btn.click();
      }, sectionTargetTab).catch(() => {});
      // Force a synchronous layout pass — flushes CSS display changes to render pipeline.
      // CRITICAL: Without this, --no-gpu headless Chromium may not composite the new
      // CSS state before page.screenshot() runs, causing stale frames.
      await page.evaluate((tab) => {
        const panel = document.querySelector(`#viz-${tab}`);
        if (panel) panel.getBoundingClientRect();
        document.body.getBoundingClientRect();
      }, sectionTargetTab).catch(() => {});
      await page.waitForTimeout(800);
      const state = await verifyPanelVisible(sectionTargetTab);
      if (state.ok) break;
      console.log(`   ⚠️  Tab attempt ${attempt + 1}: btn=${state.btnActive} panel=${state.panelVisible} — retrying`);
      if (attempt === 4) {
        console.log(`   ❌  Panel still not visible after 5 attempts — forcing via JS evaluate`);
        await page.evaluate((tab) => {
          // Force the tab switch directly in the page JS context
          const btn = document.querySelector(`.tab[data-mod="${tab}"]`);
          if (btn) btn.click();
        }, sectionTargetTab);
        await page.waitForTimeout(800);
      }
    }
  }

  // Hoisted state flags — needed in algo pre-selection, case pre-selection,
  // pre-recording guard, AND the recording loop. Must be declared before all of those.
  let preSelectedCaseId = null;    // iterative: case was pre-selected
  let preAnimatedRecursive = false; // recursive: full animation was pre-played

  // ── Pre-select algorithm for iterative/recursive sections ─────────────────
  //
  // When the iterative or recursive tab is active, the right panel shows an
  // empty SVG until an algorithm card is clicked (selectIterAlgo/selectRecAlgo).
  // The first navAction is usually click_nth to select the algo card, but it
  // runs DURING the recording — so the first several seconds show a blank chart.
  //
  // Fix: derive the algo ID from the section ID and call selectIterAlgo() or
  // selectRecAlgo() BEFORE the recording starts so the chart renders from frame 0.
  const SECTION_ALGO_SETUP = {
    // iterative tab algos
    linear_search:   { tab: 'iterative', fn: 'selectIterAlgo', arg: 'linear_search' },
    binary_search:   { tab: 'iterative', fn: 'selectIterAlgo', arg: 'binary_search' },
    bubble_sort:     { tab: 'iterative', fn: 'selectIterAlgo', arg: 'bubble_sort' },
    insertion_sort:  { tab: 'iterative', fn: 'selectIterAlgo', arg: 'insertion_sort' },
    selection_sort:  { tab: 'iterative', fn: 'selectIterAlgo', arg: 'selection_sort' },
    // recursive tab algos
    merge_sort:        { tab: 'recursive', fn: 'selectRecAlgo',  arg: 'merge_sort' },
    binary_search_rec: { tab: 'recursive', fn: 'selectRecAlgo',  arg: 'binary_search_rec' },
    quick_sort_best:   { tab: 'recursive', fn: 'selectRecAlgo',  arg: 'quick_sort_best' },
    quick_sort_worst:  { tab: 'recursive', fn: 'selectRecAlgo',  arg: 'quick_sort_worst' },
    fibonacci:         { tab: 'recursive', fn: 'selectRecAlgo',  arg: 'fibonacci' },
    tower_hanoi:       { tab: 'recursive', fn: 'selectRecAlgo',  arg: 'tower_hanoi' },
  };
  // Match section ID to algo key (e.g. "16_linear_search_best" → "linear_search")
  const matchedAlgo = Object.keys(SECTION_ALGO_SETUP).find(k => sectionId.includes(k));
  const algoSetup = matchedAlgo ? SECTION_ALGO_SETUP[matchedAlgo] : null;

  if (algoSetup && algoSetup.tab === sectionTargetTab) {
    const called = await page.evaluate((setup) => {
      if (typeof window[setup.fn] === 'function') {
        window[setup.fn](setup.arg);
        return true;
      }
      return false;
    }, algoSetup);
    if (called) {
      await page.waitForTimeout(600); // allow chart to render
      console.log(`   ✅ Pre-selected algo: ${algoSetup.fn}('${algoSetup.arg}')`);

      // ── Set meaningful input size for recursive/iterative visualizations ────
      //
      // Many tools have an "input size n" slider. Small defaults (n=8) produce
      // trivial trees/arrays that don't illustrate the algorithm's behavior.
      // This is GENERAL: discovers any range input on the page, reads its min/max,
      // and sets a value that produces a meaningful visualization.
      //
      // Strategy: find visible range inputs, set them to ~75% of max (enough nodes
      // to show the pattern without overflowing the SVG). Then trigger the change
      // event so the tool rebuilds its data structures.
      if (sectionTargetTab === 'recursive' || sectionTargetTab === 'iterative') {
        const sizeSet = await page.evaluate(() => {
          // Find ALL visible range sliders on the page
          const sliders = Array.from(document.querySelectorAll('input[type="range"]'))
            .filter(s => s.offsetParent !== null); // visible only
          if (sliders.length === 0) return null;

          const results = [];
          for (const slider of sliders) {
            const min = parseInt(slider.min) || 2;
            const max = parseInt(slider.max) || 16;
            const current = parseInt(slider.value) || min;
            // Set to ~75% of max — enough to show patterns without overflow
            const target = Math.round(min + (max - min) * 0.75);
            if (target > current) {
              slider.value = target;
              slider.dispatchEvent(new Event('input', { bubbles: true }));
              slider.dispatchEvent(new Event('change', { bubbles: true }));
              // Update any associated display label
              const label = slider.parentElement?.querySelector('.val, span');
              if (label) label.textContent = target;
              results.push({ from: current, to: target, max });
            }
          }
          // Also call recNChange/recBuild if available (tool-specific but harmless)
          if (typeof recNChange === 'function') recNChange();
          return results.length > 0 ? results : null;
        });
        if (sizeSet) {
          await page.waitForTimeout(400);
          for (const s of sizeSet) {
            console.log(`   📐 Input size: ${s.from} → ${s.to} (max ${s.max})`);
          }
        }
      }

      // Flag recursive sections — the actual "Animate All" button click
      // happens DURING recording (not here) so the animation is captured in frames.
      if (sectionTargetTab === 'recursive') {
        preAnimatedRecursive = true;
      }
    }
  }

  // ── Pre-select case button for iterative sections ───────────────────────────
  //
  // selectIterAlgo() shows the case selector but does NOT auto-select any case.
  // Without this, the case buttons are unselected and the detail panel shows the
  // generic "Choose an input scenario" prompt instead of the case analysis.
  //
  // The case is inferred in order of priority:
  //   1. Hardcoded map from section ID to case ID (most reliable)
  //   2. Narration keyword matching (handles future/unknown sections)
  //
  // For selection_sort, cases are "sorted"/"reversed"/"random" not "best"/"worst",
  // so the hardcoded map is essential.
  // (declarations moved above algo pre-selection block)

  if (sectionTargetTab === 'iterative' && algoSetup) {
    // Hardcoded: section ID substring → case ID for selectIterCase()
    const SECTION_CASE_MAP = {
      'linear_search_best':         'best',
      'linear_search_worst':        'worst',
      'binary_search_power':        'best',
      'logarithmic_beauty':         'best',
      'bubble_sort_tragedy':        'worst',
      'quadratic_scaling':          'worst',
      'insertion_sort_adaptive':    'best',
      'selection_sort_consistency': 'sorted',
    };

    // Match section ID to case key (primary mechanism — most reliable)
    let caseId = null;
    for (const [key, id] of Object.entries(SECTION_CASE_MAP)) {
      if (sectionId.includes(key)) { caseId = id; break; }
    }

    // Fallback: infer from section ID keywords (not narration — narration
    // mentions other cases tangentially which causes false matches).
    // Only match if the section ID itself contains the case keyword.
    if (!caseId) {
      if (sectionId.includes('_worst'))        caseId = 'worst';
      else if (sectionId.includes('_best'))    caseId = 'best';
      else if (sectionId.includes('_average')) caseId = 'average';
      else if (sectionId.includes('_sorted'))  caseId = 'sorted';
      else if (sectionId.includes('_reversed')) caseId = 'reversed';
      else if (sectionId.includes('_random'))  caseId = 'random';
    }

    // Default: for iterative sections without a specific case (e.g. intro sections),
    // select "best" so the array visualization and animation have something to show.
    // Without ANY case selected, the array shows "step 0/0" and Auto Play does nothing.
    if (!caseId) {
      caseId = 'best';
    }

    if (caseId) {
      const caseName = await page.evaluate((cid) => {
        if (typeof selectIterCase === 'function') {
          selectIterCase(cid);
          const btn = document.querySelector(`.case-btn.active`);
          return btn?.textContent?.trim() || cid;
        }
        return null;
      }, caseId);
      if (caseName) {
        preSelectedCaseId = caseId;
        await page.waitForTimeout(400);
        console.log(`   ✅ Pre-selected case: ${caseId} (${caseName})`);

        // Animation will be triggered DURING recording by clicking the actual
        // DOM button — not via evaluate(). See recording loop below.
      }
    }
  }

  // ── Pre-select proof for prover sections ──────────────────────────────────
  //
  // #proof-select is populated by populateProofs() at page load, but the
  // set_select nav action fires at 10% of recording duration — too late to
  // affect frame 0. Pre-select the proof (and Show All steps) BEFORE the
  // recording starts so the proof is visible from the first frame.
  //
  // Derive the proof index from the section's set_select navAction.
  if (sectionTargetTab === 'prover') {
    const proofAction = (section.navActions || []).find(a => a.action === 'set_select' && a.selector === '#proof-select');
    if (proofAction != null) {
      const proofIdx = proofAction.index;
      const preselected = await page.evaluate((idx) => {
        const sel = document.querySelector('#proof-select');
        if (!sel || sel.options.length <= idx) return `options=${sel?.options.length ?? 0} too few`;
        sel.selectedIndex = idx;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        // Also show all proof steps immediately
        if (typeof window.proofShowAll === 'function') window.proofShowAll();
        return sel.options[idx]?.text || 'selected';
      }, proofIdx);
      await page.waitForTimeout(600); // allow proof graph to render
      console.log(`   ✅ Pre-selected proof[${proofIdx}]: ${preselected}`);
    }
  }

  // ── Pre-navigate challenge to correct question ────────────────────────────
  //
  // Challenge mode starts at question 0 (Bubble Sort) every new browser session.
  // Each section narrates a specific question. Navigate to it BEFORE recording
  // so the correct question is visible from frame 0.
  //
  // Map: section ID substring → zero-based question index in CHALLENGES array.
  if (sectionTargetTab === 'challenge') {
    const SECTION_CHALLENGE_Q = {
      '33_bubble_sort_challenge':            0,
      '34_polynomial_relationships':         1,
      '35_theta_implies_both':               2,
      '36_small_o_versus_big_o':             3,
      '37_selection_sort_consistency_test':  4,
      '38_merge_vs_insertion_comparison':    5,
      '39_nested_loop_analysis':             6,
      '40_false_relationship_identification':7,
      '41_fibonacci_vs_hanoi':               8,
      '42_quicksort_complexity_summary':     9,
    };
    const targetQ = SECTION_CHALLENGE_Q[sectionId] ?? null;
    if (targetQ !== null) {
      const navigated = await page.evaluate((qIdx) => {
        // challengeState is declared with 'let' so window.challengeState doesn't work.
        // Access it directly by name in the page JS context.
        try {
          if (typeof challengeState === 'undefined') return 'no challengeState';
          // Ensure challenge is started
          if (!challengeState.started && typeof startChallenge === 'function') startChallenge();
          // Navigate to target question
          challengeState.qIdx = qIdx;
          challengeState.answered = false;
          if (typeof renderChallenge === 'function') renderChallenge();
          return `q${qIdx + 1}`;
        } catch (e) { return 'error: ' + e.message; }
      }, targetQ);
      await page.waitForTimeout(400);
      console.log(`   ✅ Pre-navigated challenge to: ${navigated}`);
    }
  }

  // Build the timed action plan BEFORE executing setup steps
  const preStepPlan = splitPreStepActions(section.navActions || []);
  const timedPlanSource = preStepPlan.hasStepThrough
    ? { ...section, navActions: preStepPlan.post }
    : section;
  const timedPlan = planTimedActions(timedPlanSource, durationMs);

  if (preStepPlan.hasStepThrough && preStepPlan.pre.length > 0) {
    for (const action of preStepPlan.pre) {
      try {
        if (action.action === 'move_cursor_to') continue;
        await executeNavActions(page, [action]);
      } catch (err) {
        console.log(`   ⚠️  Pre-step action failed: ${action.action} → ${err.message?.substring(0, 60)}`);
      }
    }
    await page.waitForTimeout(400);
  }

  // Execute SETUP actions (initial wait, cursor moves) BEFORE starting screencast.
  // Tab clicks in setup are already handled by the verified switch above — skip them.
  if (timedPlan.length > 0 && timedPlan[0].atMs === 0) {
    const setupStep = timedPlan.shift();
    for (const action of setupStep.actions) {
      if (action.action === 'click_tab') continue; // already done above, verified
      try {
        if (action.action === 'move_cursor_to') {
          await moveCursorTo(page, action.target, action.label || '');
        } else {
          await executeNavActions(page, [action]);
        }
      } catch (err) {
        console.log(`   ⚠️  Setup action failed: ${action.action} → ${err.message?.substring(0, 60)}`);
      }
    }
    await page.waitForTimeout(600);
  }

  // Force render flush before starting screencast — ensures CSS state is composited.
  // getBoundingClientRect() forces synchronous layout; the subsequent double-RAF
  // guarantees Chromium completes two full render+composite cycles so the GPU
  // compositor has committed the new frame before startScreencast captures frame 0.
  // This fixes sections showing the wrong tab in the assembled video despite DOM checks passing.
  await page.evaluate(() => { document.body.getBoundingClientRect(); }).catch(() => {});
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })).catch(() => {});
  await page.waitForTimeout(500);

  // ── Pre-recording tab abort ────────────────────────────────────────────────
  // Check the active tab ONE FINAL TIME before starting screencast.
  // If it's still wrong after all switch attempts, abort immediately — don't
  // waste 30s recording footage that will certainly fail inspection.
  if (sectionTargetTab) {
    const preRecordTab = await page.evaluate(() =>
      document.querySelector('.tab.active')?.getAttribute('data-mod') || null
    ).catch(() => null);
    if (preRecordTab !== sectionTargetTab) {
      console.log(`   ❌ Pre-recording abort: active="${preRecordTab}" expected="${sectionTargetTab}"`);
      return { framePaths: [], frameCount: 0, durationMs: 0 };
    }
  }

  // Inject subtitle overlay and show first sentence before recording starts
  await injectSubtitleOverlay(page);
  const subtitleSchedule = planSubtitleSchedule(section.narration, durationMs, sentenceTimestamps);
  if (subtitleSchedule.length > 0) {
    await updateSubtitle(page, subtitleSchedule[0].text);
  }

  // ── Subtitle dimensions QA (deterministic, runs every section) ────────────
  // PERMANENT FIX (2026-04-10): assert the subtitle bar isn't oversized
  // BEFORE the screencast starts. Auto-tune up to 3 attempts; warn if still
  // failing. Catches the "subtitle text too big" failure mode without an LLM.
  try {
    const { inspectSubtitleSize, tuneSubtitleSize } = await import('./frame-guard.mjs');
    let subInspect = await inspectSubtitleSize(page);
    let tuneAttempt = 0;
    while (!subInspect.pass && tuneAttempt < 3) {
      console.log(`   📏 Subtitle inspector flagged: ${subInspect.issues.join(', ')}`);
      await tuneSubtitleSize(page, subInspect.measured);
      await page.waitForTimeout(100);
      subInspect = await inspectSubtitleSize(page);
      tuneAttempt++;
    }
    if (subInspect.pass) {
      const m = subInspect.measured;
      console.log(`   📏 Subtitle OK: ${m.fontPx}px font, ${(m.height/m.vh*100).toFixed(1)}% h, ${(m.width/m.vw*100).toFixed(1)}% w, ${m.lineCount} line(s)`);
    } else {
      console.log(`   ⚠️  Subtitle still failing after auto-tune: ${subInspect.issues.join(', ')}`);
    }
  } catch (err) {
    console.log(`   ⚠️  Subtitle inspector error: ${err.message?.substring(0, 80)}`);
  }

  // ═══ LAYER 1: FRAME-0 GATE ═══════════════════════════════════════════════
  // Hard-gate: verify correct module is on screen BEFORE recording.
  // If the gate fails, fix the issue and re-check (up to 3 attempts).
  const { frame0Gate } = await import('./frame-guard.mjs');
  const isTheorySection = sectionIsTheoryModule(section);
  const allowsInteractiveModuleFocus = sectionAllowsInteractiveModuleFocus(section);

  for (let gateAttempt = 0; gateAttempt < 3; gateAttempt++) {
    const gate = await frame0Gate(page, section, sectionTargetTab);
    if (gate.pass) break;

    console.log(`   ⚠️  Frame-0 gate failed (attempt ${gateAttempt + 1}/3): ${gate.issues.join(', ')}`);

    // Auto-fix common issues — but NOT for theory/intro sections where
    // the wrap is intentionally hidden and intro body intentionally expanded
    if (!isTheorySection) {
      for (const issue of gate.issues) {
        if (issue.includes('theory_not_collapsed')) {
          await page.evaluate(() => {
            const ib = document.getElementById('introBody');
            if (ib) ib.classList.add('collapsed');
          });
        }
        if (issue.includes('wrong_tab')) {
          await page.evaluate((tab) => {
            document.querySelector(`.tab[data-mod="${tab}"]`)?.click();
          }, sectionTargetTab).catch(() => {});
        }
        if (issue.includes('zoom_on_interactive') && !allowsInteractiveModuleFocus) {
          await page.evaluate(() => {
            document.documentElement.style.zoom = '1';
            if (typeof window.__lectureSetSubtitleScale === 'function') {
              window.__lectureSetSubtitleScale(1);
            }
          });
        }
        if (issue.includes('wrap_hidden')) {
          await page.evaluate(() => {
            const w = document.querySelector('.wrap');
            if (w) w.style.display = '';
          });
        }
        // PERMANENT FIX (2026-04-10): If expectedElements are missing/invisible
        // when the gate runs, the section's setup actions either failed or
        // weren't classified as setup. Re-run the setup bucket of the timed
        // plan to give them another chance to render before frame 0.
        if (issue.includes('missing_expected_elements')
            || issue.includes('invisible_expected_elements')) {
          try {
            const replanPlan = planTimedActions(section, durationMs);
            const replanSetup = replanPlan.find(step => step.atMs === 0);
            if (replanSetup && Array.isArray(replanSetup.actions)) {
              for (const action of replanSetup.actions) {
                if (action.action === 'click_tab') continue;
                if (action.action === 'move_cursor_to') continue;
                try { await executeNavActions(page, [action]); } catch {}
              }
              await page.waitForTimeout(500);
            }
          } catch (err) {
            console.log(`   ⚠️  Gate auto-fix replan failed: ${err.message?.substring(0, 80)}`);
          }
        }
      }
    }
    await page.waitForTimeout(500);
  }

  // For interactive sections, ensure clean viewport one final time
  if (!isTheorySection) {
    await page.evaluate(() => {
      const ib = document.getElementById('introBody');
      if (ib && !ib.classList.contains('collapsed')) ib.classList.add('collapsed');
    });
    if (!allowsInteractiveModuleFocus) {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '1';
        if (typeof window.__lectureSetSubtitleScale === 'function') {
          window.__lectureSetSubtitleScale(1);
        }
        window.scrollTo(0, 0);
      });
    }
    await page.waitForTimeout(200);
  }

  // Final render flush
  await page.evaluate(() => { document.body.getBoundingClientRect(); }).catch(() => {});
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await page.waitForTimeout(400);

  // Start screencast AFTER gate passes — first frame is guaranteed correct
  const cast = await startScreencast(page, { fps: 5, quality: 85 });

  // Merge subtitle schedule into timed plan
  const mergedPlan = [...timedPlan];
  for (const sub of subtitleSchedule) {
    mergedPlan.push({ atMs: sub.atMs, _subtitle: sub.text });
  }
  mergedPlan.sort((a, b) => a.atMs - b.atMs);

  // ── Discover available buttons ONCE before recording loop ──────────────────
  // This is tool-agnostic: discovers full-animation vs single-step buttons by
  // text patterns, regardless of exact button labels. Works for any HTML tool.
  const discoveredButtons = await discoverButtons(page);
  if (discoveredButtons.fullAnimation) {
    console.log(`   🔍 Discovered full-animation button: "${discoveredButtons.fullAnimation}"`);
  }

  // Track whether the full-animation button has been clicked (click only once)
  let fullAnimClickedDuringRecording = false;

  // Execute timed actions
  const startTime = Date.now();

  for (const step of mergedPlan) {
    // Wait until the right timestamp
    const elapsed = Date.now() - startTime;
    const waitMs = step.atMs - elapsed;
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    // Subtitle update step
    if (step._subtitle) {
      await updateSubtitle(page, step._subtitle);
      continue;
    }

    // Execute this step's actions
    for (const action of step.actions) {
      // PERMANENT FIX (2026-03-25): General-purpose animation button replacement.
      //
      // Works for ANY HTML tool:
      //   1. discoverButtons() finds buttons matching full-animation patterns
      //      (e.g. "Auto Play", "Animate All", "Run All", "Play Through", "▶▶ ...")
      //   2. When a single-step button click is encountered in navActions
      //      (e.g. "Next Step", "Next Level", "Advance", "▶ ..."),
      //      it's replaced with the discovered full-animation button.
      //   3. The actual DOM button is clicked via Playwright (not JS evaluate),
      //      so the animation plays DURING recording and is captured in frames.
      //
      // Skip algo card re-selection (resets case/animation state):
      const skipAlgoReselect = preSelectedCaseId || preAnimatedRecursive;
      if (skipAlgoReselect
          && (action.action === 'click_selector' || action.action === 'click_nth')
          && action.target?.includes('data-id')) {
        continue;
      }

      // Replace single-step button with full-animation button (tool-agnostic)
      if (action.action === 'click_button'
          && isSingleStepButton(action.text)
          && discoveredButtons.fullAnimation
          && !fullAnimClickedDuringRecording) {
        try {
          // Use XPath text match for robustness — handles unicode arrows, whitespace
          const btnText = discoveredButtons.fullAnimation;
          const btn = await page.$(`button:has-text("${btnText.replace(/[▶▶]/g, '').trim()}")`);
          if (btn) {
            await btn.click();
            fullAnimClickedDuringRecording = true;
            console.log(`   ▶▶ Clicked "${btnText}" (replaces single-step "${action.text}")`);
          } else {
            // Fallback: try matching by the original patterns directly
            const fallback = await page.evaluate((pat) => {
              const btns = Array.from(document.querySelectorAll('button'));
              const match = btns.find(b => new RegExp(pat, 'i').test(b.textContent));
              if (match) { match.click(); return match.textContent.trim(); }
              return null;
            }, FULL_ANIM_PATTERNS.source);
            if (fallback) {
              fullAnimClickedDuringRecording = true;
              console.log(`   ▶▶ Clicked "${fallback}" via fallback (replaces "${action.text}")`);
            }
          }
        } catch { /* non-fatal */ }
        continue;
      }
      // Skip subsequent single-step clicks after full-animation has been triggered
      if (action.action === 'click_button'
          && isSingleStepButton(action.text)
          && fullAnimClickedDuringRecording) {
        continue;
      }
      try {
        if (action.action === 'move_cursor_to') {
          const moved = await moveCursorTo(page, action.target, action.label || '');
          if (!moved) await hideCursor(page);
        } else {
          await executeNavActions(page, [action]);
        }
      } catch {
        // Don't let action failures stop the recording
      }
    }
  }

  // Hide cursor so it doesn't linger over content during remaining recording time
  try { await hideCursor(page); } catch { /* non-fatal */ }

  // Wait for remaining duration
  const remaining = durationMs - (Date.now() - startTime);
  if (remaining > 0) {
    await page.waitForTimeout(remaining);
  }

  // Stop screencast
  const frames = await cast.stop();

  // Save frames
  const framePaths = [];
  for (const frame of frames) {
    const framePath = join(outputDir, `${sectionId}_frame_${String(frame.index).padStart(4, '0')}.jpg`);
    await writeFile(framePath, frame.data);
    framePaths.push(framePath);
  }

  console.log(`   🎬 Captured ${frames.length} live frames over ${(durationMs/1000).toFixed(1)}s`);

  // Fallback if no frames captured
  if (framePaths.length === 0) {
    console.log(`   ⚠️ No frames from screencast, falling back to screenshot`);
    const fallbackPath = join(outputDir, `${sectionId}_fallback.jpg`);
    await captureStaticFrame(page, fallbackPath);
    return { type: 'static', framePaths: [fallbackPath], frameCount: 1 };
  }

  return { type: 'live', framePaths, frameCount: frames.length, durationMs };
}

/**
 * Legacy: Record a section (static or animation burst).
 * Kept for backward compatibility but recordSectionLive is preferred.
 */
export async function recordSection(page, section, outputDir) {
  // Default to live recording with estimated duration
  const estimatedDuration = (section.narration?.split(/\s+/).length || 30) / 2.5 * 1000; // ~2.5 words/sec
  return recordSectionLive(page, section, outputDir, estimatedDuration);
}
