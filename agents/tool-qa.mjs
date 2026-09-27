/**
 * Tool QA Agent
 *
 * Validates the interactive HTML tool BEFORE recording begins.
 * Uses Playwright to:
 *   1. Load the tool and verify it renders without errors
 *   2. Click through every tab, card, button
 *   3. Check that expected elements exist (charts, formulas, animations)
 *   4. Verify scroll depth — critical content at page bottom must be reachable
 *   5. Test that animations actually animate (compare frames over time)
 *   6. Report any console errors or missing resources
 *
 * If the tool has issues, this agent can ask Claude to FIX the HTML
 * before proceeding — closing the loop between tool creation and recording.
 */

import { chromium } from 'playwright';
import { runAgent, parseVerdict } from '../utils/claude-agent.mjs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_VISIBILITY_THRESHOLDS = {
  minReadableFontPx: 14,
  severeFontPx: 12,
  minContrastRatio: 4.5,
  minLargeTextContrastRatio: 3.0,
  minFormulaFontPx: 15,
  minFormulaContrastRatio: 6.5,
  minPanelFillRatio: 0.42,
};

async function collectVisibilityAudit(page, label, mode = 'interactive', thresholds = DEFAULT_VISIBILITY_THRESHOLDS) {
  return page.evaluate(({ label, mode, thresholds }) => {
    const viewportWidth = window.innerWidth || 1920;
    const viewportHeight = window.innerHeight || 1080;
    const viewportArea = viewportWidth * viewportHeight;

    function parseColor(input) {
      const text = String(input || '').trim();
      if (!text || text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      const match = text.match(/rgba?\(([^)]+)\)/i);
      if (!match) return { r: 0, g: 0, b: 0, a: 1 };
      const parts = match[1].split(',').map(part => parseFloat(part.trim()));
      const [r = 0, g = 0, b = 0, a = 1] = parts;
      return { r, g, b, a: Number.isFinite(a) ? a : 1 };
    }

    function blend(fg, bg) {
      const alpha = fg.a ?? 1;
      return {
        r: Math.round((fg.r * alpha) + (bg.r * (1 - alpha))),
        g: Math.round((fg.g * alpha) + (bg.g * (1 - alpha))),
        b: Math.round((fg.b * alpha) + (bg.b * (1 - alpha))),
        a: 1,
      };
    }

    function luminance({ r, g, b }) {
      const srgb = [r, g, b].map(value => {
        const channel = value / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    }

    function contrastRatio(fg, bg) {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function rectOf(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left)),
        height: Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top)),
        rawWidth: rect.width,
        rawHeight: rect.height,
      };
    }

    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.05) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) return false;
      return true;
    }

    function textContentFor(el) {
      const raw = (el.tagName === 'text' ? el.textContent : (el.innerText || el.textContent || ''))
        .replace(/\s+/g, ' ')
        .trim();
      return raw;
    }

    const formulaRegex = /(?:=|σ\(|π(?:_ref)?|β|∇|KL\s*\(|R\s*\(|P\s*\(|L\s*=|log\b|max\b|y_[wl1-9]|x\s*,\s*y)/i;

    const bodyBg = (() => {
      const parsed = parseColor(getComputedStyle(document.body).backgroundColor);
      return parsed.a > 0 ? blend(parsed, { r: 15, g: 18, b: 30, a: 1 }) : { r: 15, g: 18, b: 30, a: 1 };
    })();

    function effectiveBackground(el) {
      let current = bodyBg;
      let node = el;
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const bg = parseColor(style.backgroundColor);
        if (bg.a > 0.02) current = blend(bg, current);
        node = node.parentElement;
      }
      return current;
    }

    function effectiveForeground(el, bg) {
      const style = getComputedStyle(el);
      const fill = parseColor(style.fill);
      const color = parseColor(style.color);
      const tag = el.tagName.toLowerCase();
      const isSvgText = tag === 'text' || el.namespaceURI === 'http://www.w3.org/2000/svg';
      const raw = isSvgText
        ? (fill.a > 0.02 ? fill : color)
        : (color.a > 0.02 ? color : fill);
      return raw.a >= 0.99 ? raw : blend(raw, bg);
    }

    function isMeaningfulLeaf(el) {
      if (el.tagName.toLowerCase() === 'text') return true;
      const text = textContentFor(el);
      if (text.length < 2) return false;
      const meaningfulChildren = [...el.children].filter(child => isVisible(child) && textContentFor(child).length >= 2);
      return meaningfulChildren.length === 0;
    }

    const candidates = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,label,button,summary,strong,em,small,span,div,code,pre,svg text,text')]
      .filter(isVisible)
      .filter(isMeaningfulLeaf)
      .slice(0, 800);

    const samples = candidates.map(el => {
      const bg = effectiveBackground(el);
      const fg = effectiveForeground(el, bg);
      const rect = rectOf(el);
      const text = textContentFor(el);
      const fontPx = parseFloat(getComputedStyle(el).fontSize || el.getAttribute('font-size') || '0') || 0;
      const fontWeight = parseInt(getComputedStyle(el).fontWeight || '400', 10) || 400;
      const contrast = contrastRatio(fg, bg);
      const classNames = String(el.className || '');
      const formulaLike = el.tagName.toLowerCase() === 'code'
        || el.tagName.toLowerCase() === 'pre'
        || classNames.includes('code-block')
        || classNames.includes('math-inline')
        || formulaRegex.test(text);
      return {
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 96),
        fontPx: Number(fontPx.toFixed(2)),
        fontWeight,
        contrast: Number(contrast.toFixed(2)),
        formulaLike,
        rect,
        selector: el.id ? `#${el.id}` : (el.className ? `.${String(el.className).split(/\s+/)[0]}` : el.tagName.toLowerCase()),
      };
    }).filter(sample => sample.text.length >= 2);

    const fonts = samples.map(sample => sample.fontPx).filter(value => value > 0).sort((a, b) => a - b);
    const contrasts = samples.map(sample => sample.contrast).filter(value => value > 0).sort((a, b) => a - b);
    const median = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : 0;

    const lowContrastCount = samples.filter(sample => {
      const largeText = sample.fontPx >= 18 || (sample.fontPx >= 14 && sample.fontWeight >= 700);
      return sample.contrast < (largeText ? 3.0 : 4.5);
    }).length;

    const panelRoots = [
      ...document.querySelectorAll('.wrap > *, main > *, body > *'),
      ...document.querySelectorAll('[class*="panel"], [class*="column"], [class*="content"], [class*="controls"], [class*="left"], [class*="right"]')
    ];

    const seenPanels = new Set();
    const panels = [];
    for (const panel of panelRoots) {
      if (!isVisible(panel)) continue;
      const rect = rectOf(panel);
      const area = rect.rawWidth * rect.rawHeight;
      if (area < viewportArea * 0.12) continue;
      const key = panel.id || panel.className || `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.rawWidth)}:${Math.round(rect.rawHeight)}`;
      if (seenPanels.has(key)) continue;
      seenPanels.add(key);

      const descendants = [...panel.querySelectorAll('p,li,button,label,svg,canvas,pre,code,table,select,input,h1,h2,h3,h4,h5,h6,div,span,text')]
        .filter(isVisible);
      const childRects = descendants
        .map(el => ({ el, rect: rectOf(el) }))
        .filter(entry => entry.rect.width > 6 && entry.rect.height > 6);

      let fillRatio = 0;
      if (childRects.length) {
        const minX = Math.min(...childRects.map(entry => entry.rect.x));
        const maxX = Math.max(...childRects.map(entry => entry.rect.x + entry.rect.width));
        const minY = Math.min(...childRects.map(entry => entry.rect.y));
        const maxY = Math.max(...childRects.map(entry => entry.rect.y + entry.rect.height));
        const bboxArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
        fillRatio = bboxArea / area;
      }

      const panelFontValues = samples
        .filter(sample =>
          sample.rect.x >= rect.x - 1 &&
          sample.rect.y >= rect.y - 1 &&
          sample.rect.x + sample.rect.width <= rect.x + rect.rawWidth + 1 &&
          sample.rect.y + sample.rect.height <= rect.y + rect.rawHeight + 1
        )
        .map(sample => sample.fontPx)
        .filter(Boolean)
        .sort((a, b) => a - b);

      panels.push({
        label: panel.id || String(panel.className || panel.tagName).trim().slice(0, 60) || panel.tagName.toLowerCase(),
        areaRatio: Number((area / viewportArea).toFixed(3)),
        fillRatio: Number(fillRatio.toFixed(3)),
        medianFontPx: Number(median(panelFontValues).toFixed(2)),
        minFontPx: Number((panelFontValues[0] || 0).toFixed(2)),
      });
    }

    panels.sort((a, b) => b.areaRatio - a.areaRatio);
    const underusedPanels = panels.filter(panel => panel.areaRatio >= 0.12 && panel.fillRatio > 0 && panel.fillRatio < 0.42 && panel.medianFontPx > 0 && panel.medianFontPx < 15);

    return {
      label,
      mode,
      viewport: { width: viewportWidth, height: viewportHeight },
      visibleTextCount: samples.length,
      minFontPx: Number(((fonts[0] || 0)).toFixed(2)),
      medianFontPx: Number(median(fonts).toFixed(2)),
      lowFontCount: samples.filter(sample => sample.fontPx < 14).length,
      veryLowFontCount: samples.filter(sample => sample.fontPx < 12).length,
      minContrast: Number(((contrasts[0] || 0)).toFixed(2)),
      lowContrastCount,
      formulaSampleCount: samples.filter(sample => sample.formulaLike).length,
      minFormulaFontPx: Number((Math.min(...samples.filter(sample => sample.formulaLike).map(sample => sample.fontPx), Infinity) || 0).toFixed(2)),
      minFormulaContrast: Number((Math.min(...samples.filter(sample => sample.formulaLike).map(sample => sample.contrast), Infinity) || 0).toFixed(2)),
      lowFormulaCount: samples.filter(sample => sample.formulaLike && sample.fontPx < thresholds.minFormulaFontPx).length,
      lowFormulaContrastCount: samples.filter(sample => sample.formulaLike && sample.contrast < thresholds.minFormulaContrastRatio).length,
      worstFontSamples: samples
        .slice()
        .sort((a, b) => a.fontPx - b.fontPx)
        .slice(0, 5),
      worstContrastSamples: samples
        .slice()
        .sort((a, b) => a.contrast - b.contrast)
        .slice(0, 5),
      worstFormulaSamples: samples
        .filter(sample => sample.formulaLike)
        .sort((a, b) => {
          if (a.contrast !== b.contrast) return a.contrast - b.contrast;
          return a.fontPx - b.fontPx;
        })
        .slice(0, 5),
      underusedPanels: underusedPanels.slice(0, 5),
      panels: panels.slice(0, 6),
    };
  }, { label, mode, thresholds });
}

function visibilityIssuesFromAudits(audits, thresholds = DEFAULT_VISIBILITY_THRESHOLDS) {
  const issues = [];
  for (const audit of audits || []) {
    if (!audit || !audit.visibleTextCount) continue;
    const label = audit.label || audit.mode || 'tool view';

    if (audit.medianFontPx < thresholds.minReadableFontPx || audit.veryLowFontCount > 0) {
      const severity = audit.medianFontPx < thresholds.minReadableFontPx - 1 || audit.minFontPx < thresholds.severeFontPx
        ? 'critical'
        : 'warning';
      const examples = (audit.worstFontSamples || []).slice(0, 2)
        .map(sample => `"${sample.text}" (${sample.fontPx}px)`)
        .join(', ');
      issues.push({
        type: 'visibility_font_size',
        severity,
        description: `${label} has text that is too small for lecture viewing (median ${audit.medianFontPx}px, minimum ${audit.minFontPx}px). Examples: ${examples || 'small labels detected'}.`,
        fix: 'Increase body, label, button, stat-pill, and SVG text sizes and use available empty space to enlarge the active module.'
      });
    }

    if (audit.minContrast < thresholds.minContrastRatio || audit.lowContrastCount > 0) {
      const severity = audit.minContrast < thresholds.minLargeTextContrastRatio ? 'critical' : 'warning';
      const examples = (audit.worstContrastSamples || []).slice(0, 2)
        .map(sample => `"${sample.text}" (${sample.contrast}:1)`)
        .join(', ');
      issues.push({
        type: 'visibility_contrast',
        severity,
        description: `${label} has low text/background contrast (minimum ${audit.minContrast}:1). Examples: ${examples || 'low-contrast text detected'}.`,
        fix: 'Raise foreground/background contrast for explanatory text, labels, buttons, SVG text, and stat pills so text clearly separates from the background.'
      });
    }

    if (
      (audit.formulaSampleCount || 0) > 0 &&
      (
        audit.minFormulaFontPx < thresholds.minFormulaFontPx ||
        audit.minFormulaContrast < thresholds.minFormulaContrastRatio ||
        audit.lowFormulaCount > 0 ||
        audit.lowFormulaContrastCount > 0
      )
    ) {
      const examples = (audit.worstFormulaSamples || []).slice(0, 2)
        .map(sample => `"${sample.text}" (${sample.fontPx}px, ${sample.contrast}:1)`)
        .join(', ');
      issues.push({
        type: 'visibility_formula_readability',
        severity: 'critical',
        description: `${label} has formulas or equation text that are too dim or too small for lecture use. Examples: ${examples || 'formula blocks detected below the target contrast/size.'}`,
        fix: 'Increase formula/code-block contrast, enlarge equation labels, and brighten low-emphasis SVG math annotations before recording.'
      });
    }

    if ((audit.underusedPanels || []).length > 0) {
      const panel = audit.underusedPanels[0];
      issues.push({
        type: 'visibility_space_usage',
        severity: 'warning',
        description: `${label} underuses panel space: panel "${panel.label}" fills only ${(panel.fillRatio * 100).toFixed(0)}% of its area while median text remains ${panel.medianFontPx}px.`,
        fix: 'Expand the focused module, enlarge text and charts, and reduce empty margins so the lecture view uses the viewport effectively.'
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const issue of issues) {
    const key = `${issue.type}:${issue.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

export async function runToolQA(state) {
  const toolPath = state.data.toolPath;
  const runDir = state.runDir;
  const config = state.data.config;

  console.log('🔍 Tool QA: Validating interactive tool...');

  // ── Launch browser ──
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: config.videoResolution.width, height: config.videoResolution.height }
  });
  const page = await context.newPage();

  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Collect failed network requests
  const failedRequests = [];
  page.on('requestfailed', req => {
    failedRequests.push({ url: req.url(), error: req.failure()?.errorText });
  });

  // ── Load the tool ──
  await page.goto(`file://${toolPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // ── Gather page info ──
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      scrollable: document.body.scrollHeight > window.innerHeight,
      tabCount: document.querySelectorAll('.tab').length,
      tabNames: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim()),
      canvasCount: document.querySelectorAll('canvas').length,
      svgCount: document.querySelectorAll('svg').length,
      hasCharts: document.querySelectorAll('.chart, canvas, svg').length > 0
    };
  });

  // ── Visibility audit: theory view first ──
  const visibilityAudits = [];
  const theoryPath = join(runDir, 'qa-reports', 'tool_theory_full.png');
  await page.screenshot({ path: theoryPath, fullPage: true });
  visibilityAudits.push(await collectVisibilityAudit(page, 'Theory / initial view', 'theory'));

  // If the tool starts with a large expanded theory section, collapse it before tab audits.
  const toggledTheory = await page.evaluate(() => {
    const wrap = document.querySelector('.wrap');
    const introBody = document.querySelector('.intro-body');
    const wrapHidden = wrap ? getComputedStyle(wrap).display === 'none' : false;
    const introTall = introBody ? introBody.getBoundingClientRect().height > window.innerHeight * 0.35 : false;
    if (!(wrapHidden || introTall)) return false;
    const header = document.querySelector('.intro-header');
    if (header) {
      header.click();
      return true;
    }
    const collapseButton = [...document.querySelectorAll('button')].find(btn => /\bcollapse\b/i.test(btn.textContent || ''));
    if (collapseButton) {
      collapseButton.click();
      return true;
    }
    return false;
  });
  if (toggledTheory) {
    await page.waitForTimeout(800);
  }

  // ── Screenshot each tab ──
  const tabs = await page.$$('.tab');
  const tabScreenshots = [];

  for (let i = 0; i < tabs.length; i++) {
    await tabs[i].click();
    await page.waitForTimeout(1000);

    // Screenshot at top
    const topPath = join(runDir, 'qa-reports', `tool_tab${i}_top.png`);
    await page.screenshot({ path: topPath, fullPage: false });

    // Scroll to bottom and screenshot
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const bottomPath = join(runDir, 'qa-reports', `tool_tab${i}_bottom.png`);
    await page.screenshot({ path: bottomPath, fullPage: false });

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));

    // Full page screenshot
    const fullPath = join(runDir, 'qa-reports', `tool_tab${i}_full.png`);
    await page.screenshot({ path: fullPath, fullPage: true });

    visibilityAudits.push(await collectVisibilityAudit(page, `Tab: ${pageInfo.tabNames[i] || `Tab ${i}`}`, 'interactive'));

    tabScreenshots.push({ tab: pageInfo.tabNames[i] || `Tab ${i}`, topPath, bottomPath, fullPath });
  }

  // ── Test animations: take two frames 500ms apart ──
  // Click first interactive element and compare
  const animationTest = await page.evaluate(async () => {
    // Find first algo card and click it
    const card = document.querySelector('.algo-card');
    if (card) card.click();

    // Find auto-play button
    const playBtn = [...document.querySelectorAll('button, .btn')].find(b =>
      b.textContent.includes('Auto Play') || b.textContent.includes('Animate')
    );
    if (playBtn) playBtn.click();

    return { hasInteractiveElements: !!card, hasPlayButton: !!playBtn };
  });

  await page.waitForTimeout(200);
  const frame1Path = join(runDir, 'qa-reports', 'anim_frame1.png');
  await page.screenshot({ path: frame1Path });
  await page.waitForTimeout(800);
  const frame2Path = join(runDir, 'qa-reports', 'anim_frame2.png');
  await page.screenshot({ path: frame2Path });

  await browser.close();

  // ── Ask Claude to evaluate the QA results ──
  const qaData = {
    pageInfo,
    consoleErrors,
    failedRequests,
    tabScreenshots: tabScreenshots.map(t => t.tab),
    animationTest,
    scrollableContent: pageInfo.scrollable,
    bottomContentRisk: pageInfo.bodyHeight > pageInfo.viewportHeight,
    visibilityAudits
  };

  const visibilityThresholds = {
    minReadableFontPx: config.minReadableFontPx || DEFAULT_VISIBILITY_THRESHOLDS.minReadableFontPx,
    severeFontPx: config.severeFontPx || DEFAULT_VISIBILITY_THRESHOLDS.severeFontPx,
    minContrastRatio: config.minContrastRatio || DEFAULT_VISIBILITY_THRESHOLDS.minContrastRatio,
    minLargeTextContrastRatio: config.minLargeTextContrastRatio || DEFAULT_VISIBILITY_THRESHOLDS.minLargeTextContrastRatio,
    minFormulaFontPx: config.minFormulaFontPx || DEFAULT_VISIBILITY_THRESHOLDS.minFormulaFontPx,
    minFormulaContrastRatio: config.minFormulaContrastRatio || DEFAULT_VISIBILITY_THRESHOLDS.minFormulaContrastRatio,
    minPanelFillRatio: config.minPanelFillRatio || DEFAULT_VISIBILITY_THRESHOLDS.minPanelFillRatio,
  };
  const visibilityIssues = visibilityIssuesFromAudits(visibilityAudits, visibilityThresholds);

  const agentResult = await runAgent({
    systemPrompt: `You are a QA agent for interactive educational web tools.
Evaluate the tool's readiness for video recording.
Check for: rendering issues, missing content, console errors, scrollability problems,
visibility/readability problems, and whether the page layout will fit in a 1920x1080 viewport.

Treat these as recording blockers:
- body or annotation text that is too small to read comfortably in a lecture video
- low contrast between text and background
- low contrast in formulas, equations, math chips, or code-style explanation blocks
- large empty panel space combined with tiny text or undersized charts
- tools whose theory or interactive modules do not use the viewport effectively

Output a JSON verdict:
\`\`\`json
{
  "verdict": "pass" | "fail_retry" | "fail_human",
  "score": 0-100,
  "issues": [{ "type": "...", "severity": "critical|warning|info", "description": "...", "fix": "..." }],
  "recommendations": ["..."],
  "scrollStrategy": "none" | "scroll_per_section" | "full_page_capture",
  "estimatedFixTime": "none" | "quick" | "significant"
}
\`\`\``,
    userMessage: `Evaluate this tool for lecture recording readiness:\n\n${JSON.stringify(qaData, null, 2)}`
  });

  const verdict = parseVerdict(agentResult.text) || {
    verdict: 'pass',
    score: 70,
    issues: [],
    recommendations: [],
    scrollStrategy: pageInfo.scrollable ? 'scroll_per_section' : 'none'
  };

  if (visibilityIssues.length > 0) {
    verdict.issues = [...visibilityIssues, ...(verdict.issues || [])];
    verdict.score = Math.max(
      0,
      (typeof verdict.score === 'number' ? verdict.score : 70) -
        visibilityIssues.reduce((sum, issue) => sum + (issue.severity === 'critical' ? 18 : 8), 0)
    );
    verdict.verdict = 'fail_retry';
    verdict.recommendations = [
      ...(verdict.recommendations || []),
      'Increase readable font sizes before recording.',
      'Increase text/background contrast before recording.',
      'Use empty panel space to enlarge the active teaching module before recording.'
    ];
  }

  // Save QA report
  const reportPath = join(runDir, 'qa-reports', 'tool-qa-report.json');
  await writeFile(reportPath, JSON.stringify({ qaData, visibilityThresholds, verdict, agentOutput: agentResult.text }, null, 2));

  console.log(`   Score: ${verdict.score}/100 — Verdict: ${verdict.verdict}`);
  if (verdict.issues.length > 0) {
    for (const issue of verdict.issues) {
      console.log(`   ${issue.severity === 'critical' ? '❌' : '⚠️'} ${issue.type}: ${issue.description}`);
    }
  }

  return verdict;
}

/**
 * If Tool QA fails, ask Claude to fix the HTML source.
 * This closes the tool-creation → QA → fix loop.
 */
export async function fixTool(state, qaReport) {
  const toolPath = state.data.toolPath;
  const runDir = state.runDir;
  const toolSource = await readFile(toolPath, 'utf-8');

  console.log('🔧 Tool QA: Asking Claude to fix issues...');

  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 16384,
    systemPrompt: `You are a web developer fixing an interactive educational HTML tool.
You will receive the current HTML source and QA issues found during testing.
Output the COMPLETE fixed HTML file wrapped in \`\`\`html code fences. Do not truncate or abbreviate — output every line.
Focus on:
- Making all content visible without scrolling (or adding proper scroll handling)
- Fixing any console errors
- Ensuring animations work correctly
- Making the layout fit 1920x1080 viewport
- Increasing text size where explanations, labels, or controls are too small
- Increasing text/background contrast for readability
- Increasing contrast and font size for formulas, equations, math chips, code blocks, and low-emphasis SVG annotations
- Using available empty space to enlarge the active module instead of leaving large blank areas

Do NOT break the teaching pipeline while fixing visibility:
- Preserve existing element IDs, data-mod values, button text, onclick handlers, exported JS functions, and overall interaction behavior.
- Prefer CSS/layout changes over DOM restructuring.
- If you must wrap or restyle elements, keep the original selectors addressable.`,
    userMessage: `Fix these QA issues in the tool:

QA Report:
${JSON.stringify(qaReport, null, 2)}

Current HTML source:
\`\`\`html
${toolSource}
\`\`\`

Output the complete fixed HTML wrapped in \`\`\`html code fences.`
  });

  const rawResponsePath = join(runDir, 'qa-reports', 'tool-fixer-response.txt');
  await writeFile(rawResponsePath, result.text);

  // Extract HTML from response
  const extractionCandidates = [
    result.text.match(/```html\s*([\s\S]*?)```/i)?.[1],
    result.text.match(/```[a-z]*\s*(<!doctype html[\s\S]*?<\/html>)\s*```/i)?.[1],
    result.text.match(/(<!doctype html[\s\S]*<\/html>)/i)?.[1],
    result.text.match(/(<html[\s\S]*<\/html>)/i)?.[1],
  ].filter(Boolean);

  if (extractionCandidates.length > 0) {
    const fixedHtml = extractionCandidates[0].trim();
    // Write to a _fixed version, not overwriting original
    const fixedPath = toolPath.replace('.html', '_fixed.html');
    await writeFile(fixedPath, fixedHtml);
    console.log(`   Fixed tool saved to: ${fixedPath}`);
    return fixedPath;
  }

  console.log(`   ⚠️ Could not extract fixed HTML from agent response (saved raw response to ${rawResponsePath})`);
  return null;
}
    const formulaRegex = /(?:=|σ\(|π(?:_ref)?|β|∇|KL\s*\(|R\s*\(|P\s*\(|L\s*=|log\b|max\b|y_[wl1-9]|x\s*,\s*y)/i;
