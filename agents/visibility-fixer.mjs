import { readFile, writeFile } from 'fs/promises';
import { basename, dirname, extname, join } from 'path';

const DEFAULTS = {
  minReadableFontPx: 14,
  minStrongFontPx: 18,
  minControlFontPx: 15,
  minChartLabelPx: 16,
  minFormulaFontPx: 15,
  minContrastRatio: 4.5,
  minLargeTextContrastRatio: 3.0,
  minFormulaContrastRatio: 6.5,
  minPanelFillRatio: 0.42,
};

const VISIBILITY_ISSUE_TYPES = new Set([
  'visibility_font_size',
  'visibility_contrast',
  'visibility_formula_readability',
  'visibility_space_usage',
  'font_size',
  'small_text',
  'contrast',
  'low_contrast',
  'panel_layout',
]);

function enhancerThresholds(config = {}) {
  return {
    minReadableFontPx: config.minReadableFontPx || DEFAULTS.minReadableFontPx,
    minStrongFontPx: config.minStrongFontPx || DEFAULTS.minStrongFontPx,
    minControlFontPx: config.minControlFontPx || DEFAULTS.minControlFontPx,
    minChartLabelPx: config.minChartLabelPx || DEFAULTS.minChartLabelPx,
    minFormulaFontPx: config.minFormulaFontPx || DEFAULTS.minFormulaFontPx,
    minContrastRatio: config.minContrastRatio || DEFAULTS.minContrastRatio,
    minLargeTextContrastRatio: config.minLargeTextContrastRatio || DEFAULTS.minLargeTextContrastRatio,
    minFormulaContrastRatio: config.minFormulaContrastRatio || DEFAULTS.minFormulaContrastRatio,
    minPanelFillRatio: config.minPanelFillRatio || DEFAULTS.minPanelFillRatio,
  };
}

export function hasVisibilityBlockers(verdict) {
  const issues = verdict?.issues || [];
  return issues.some(issue => VISIBILITY_ISSUE_TYPES.has(issue?.type));
}

function buildEnhancerStyle() {
  return `
<style id="codex-visibility-enhancer-style">
html[data-codex-visibility-enhanced="true"] {
  color-scheme: dark;
}

html[data-codex-visibility-enhanced="true"] body {
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

html[data-codex-visibility-enhanced="true"] [data-codex-formula="true"] {
  background: rgba(106, 169, 255, 0.18) !important;
  border: 1px solid rgba(214, 230, 255, 0.18) !important;
  border-radius: 8px !important;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04) !important;
}

html[data-codex-visibility-enhanced="true"] code[data-codex-formula="true"],
html[data-codex-visibility-enhanced="true"] pre[data-codex-formula="true"] {
  display: block !important;
  padding: 12px 14px !important;
  white-space: pre-wrap !important;
  background: rgba(1, 5, 18, 0.92) !important;
}

html[data-codex-visibility-enhanced="true"] .codex-visibility-boost svg,
html[data-codex-visibility-enhanced="true"] .codex-visibility-boost canvas,
html[data-codex-visibility-enhanced="true"] .codex-visibility-boost img {
  width: 100% !important;
  max-width: 100% !important;
}

html[data-codex-visibility-enhanced="true"] svg text[data-codex-visibility-boosted="true"] {
  paint-order: stroke;
  stroke: rgba(2, 6, 16, 0.92);
  stroke-linejoin: round;
}
</style>`.trim();
}

function buildEnhancerScript(thresholds) {
  return `
<script id="codex-visibility-enhancer-script">
(() => {
  if (window.__codexVisibilityEnhancerInstalled) return;
  window.__codexVisibilityEnhancerInstalled = true;

  const cfg = ${JSON.stringify(thresholds)};
  const root = document.documentElement;
  root.dataset.codexVisibilityEnhanced = 'true';

  function parseColor(input) {
    const text = String(input || '').trim();
    if (!text || text === 'transparent' || text === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    if (text.startsWith('#')) {
      const hex = text.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        const [r, g, b, a = 'f'] = hex.split('');
        return {
          r: parseInt(r + r, 16),
          g: parseInt(g + g, 16),
          b: parseInt(b + b, 16),
          a: parseInt(a + a, 16) / 255
        };
      }
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
          a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
        };
      }
    }
    const rgba = text.match(/rgba?\\(([^)]+)\\)/i);
    if (!rgba) return { r: 0, g: 0, b: 0, a: 1 };
    const parts = rgba[1].split(',').map(part => parseFloat(part.trim()));
    const [r = 0, g = 0, b = 0, a = 1] = parts;
    return { r, g, b, a: Number.isFinite(a) ? a : 1 };
  }

  function blend(fg, bg) {
    const alpha = fg.a == null ? 1 : fg.a;
    return {
      r: Math.round((fg.r * alpha) + (bg.r * (1 - alpha))),
      g: Math.round((fg.g * alpha) + (bg.g * (1 - alpha))),
      b: Math.round((fg.b * alpha) + (bg.b * (1 - alpha))),
      a: 1
    };
  }

  function luminance(color) {
    const convert = (value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    return (0.2126 * convert(color.r)) + (0.7152 * convert(color.g)) + (0.0722 * convert(color.b));
  }

  function contrastRatio(fg, bg) {
    const lighter = Math.max(luminance(fg), luminance(bg));
    const darker = Math.min(luminance(fg), luminance(bg));
    return (lighter + 0.05) / (darker + 0.05);
  }

  function mixColor(base, target, ratio) {
    return {
      r: Math.round(base.r + ((target.r - base.r) * ratio)),
      g: Math.round(base.g + ((target.g - base.g) * ratio)),
      b: Math.round(base.b + ((target.b - base.b) * ratio)),
      a: 1
    };
  }

  function ensureReadableColor(raw, bg, targetContrast) {
    const flattened = raw.a >= 0.99 ? raw : blend(raw, bg);
    if (contrastRatio(flattened, bg) >= targetContrast) return flattened;
    let best = flattened;
    let bestContrast = contrastRatio(flattened, bg);
    const white = { r: 255, g: 255, b: 255, a: 1 };
    for (let ratio = 0.08; ratio <= 1; ratio += 0.04) {
      const candidate = mixColor(flattened, white, ratio);
      const candidateContrast = contrastRatio(candidate, bg);
      if (candidateContrast > bestContrast) {
        best = candidate;
        bestContrast = candidateContrast;
      }
      if (candidateContrast >= targetContrast) return candidate;
    }
    return best;
  }

  const fallbackBg = { r: 12, g: 18, b: 34, a: 1 };
  const formulaRegex = /(?:=|σ\\(|π(?:_ref)?|β|∇|KL\\s*\\(|R\\s*\\(|P\\s*\\(|L\\s*=|log\\b|max\\b|y_[wl1-9]|x\\s*,\\s*y|loss\\b|reward\\b)/i;

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.05) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function effectiveBackground(el) {
    let current = fallbackBg;
    let node = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const bg = parseColor(style.backgroundColor);
      if (bg.a > 0.02) current = blend(bg, current);
      node = node.parentElement;
    }
    return current;
  }

  function elementText(el) {
    if (el.tagName && el.tagName.toLowerCase() === 'text') return String(el.textContent || '').replace(/\\s+/g, ' ').trim();
    return String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  function isMeaningfulLeaf(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'text') return true;
    if (!el.children || el.children.length === 0) return true;
    return ![...el.children].some(child => isVisible(child) && elementText(child).length >= 2);
  }

  function isFormulaLike(el, text) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const classNames = String(el.className || '');
    return tag === 'code' ||
      tag === 'pre' ||
      classNames.includes('math') ||
      classNames.includes('formula') ||
      classNames.includes('equation') ||
      classNames.includes('code-block') ||
      formulaRegex.test(text);
  }

  function styleHtmlElement(el) {
    if (!isVisible(el)) return;
    const text = elementText(el);
    if (text.length < 2) return;
    if (!isMeaningfulLeaf(el)) return;

    const style = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const fontPx = parseFloat(style.fontSize || '0') || 0;
    const fontWeight = parseInt(style.fontWeight || '400', 10) || 400;
    const formulaLike = isFormulaLike(el, text);
    const controlLike = /^(button|label|input|select|textarea|summary)$/.test(tag) || el.getAttribute('role') === 'button';
    const titleLike = /^h[1-6]$/.test(tag) || fontWeight >= 700 || fontPx >= cfg.minStrongFontPx;
    const targetFont = formulaLike
      ? Math.max(fontPx, cfg.minFormulaFontPx)
      : controlLike
      ? Math.max(fontPx, cfg.minControlFontPx)
      : titleLike
      ? Math.max(fontPx, cfg.minStrongFontPx)
      : Math.max(fontPx, cfg.minReadableFontPx);

    if (targetFont > fontPx + 0.2) {
      el.style.fontSize = targetFont.toFixed(1) + 'px';
      if (style.lineHeight === 'normal') {
        el.style.lineHeight = (targetFont * 1.45).toFixed(1) + 'px';
      }
    }
    if ((formulaLike || controlLike || titleLike) && fontWeight < 650) {
      el.style.fontWeight = formulaLike || titleLike ? '700' : '650';
    }

    const bg = effectiveBackground(el);
    const fg = parseColor(style.color);
    const targetContrast = formulaLike ? cfg.minFormulaContrastRatio : (titleLike ? Math.max(cfg.minLargeTextContrastRatio, 4.2) : cfg.minContrastRatio);
    const readable = ensureReadableColor(fg.a > 0.02 ? fg : { r: 230, g: 238, b: 255, a: 1 }, bg, targetContrast);
    el.style.color = 'rgb(' + readable.r + ', ' + readable.g + ', ' + readable.b + ')';

    if (formulaLike) {
      el.dataset.codexFormula = 'true';
      if (tag === 'code' || tag === 'pre') {
        el.style.fontFamily = "'SFMono-Regular', 'Courier New', monospace";
      } else {
        el.style.display = style.display === 'block' ? 'block' : 'inline-block';
        el.style.padding = style.display === 'block' ? '10px 12px' : '2px 8px';
      }
    }
  }

  function styleSvgText(node) {
    if (!node || !isVisible(node)) return;
    const text = elementText(node);
    if (text.length < 1) return;

    const fontPx = parseFloat(node.getAttribute('font-size') || getComputedStyle(node).fontSize || '0') || 0;
    const fontWeight = parseInt(node.getAttribute('font-weight') || getComputedStyle(node).fontWeight || '400', 10) || 400;
    const formulaLike = formulaRegex.test(text);
    const annotationLike = /(?:stage\\s+\\d|demo data|human prefs|prompts \\+ r|comparison #|training step|reward score|kl divergence|log-ratio gap|reward-kl trade-off|policy update|loss\\b|ideal:|response [ab]|cross-entropy|aligned model)/i.test(text);
    const targetFont = formulaLike
      ? Math.max(fontPx, cfg.minFormulaFontPx + 1)
      : annotationLike
      ? Math.max(fontPx, cfg.minChartLabelPx)
      : Math.max(fontPx, cfg.minReadableFontPx);
    if (targetFont > fontPx + 0.2) {
      node.setAttribute('font-size', targetFont.toFixed(1));
    }
    if ((formulaLike || annotationLike || fontWeight >= 650) && fontWeight < 650) {
      node.setAttribute('font-weight', '700');
    }

    const bg = fallbackBg;
    const fill = parseColor(node.getAttribute('fill') || getComputedStyle(node).fill || '#e8ecff');
    const targetContrast = formulaLike ? cfg.minFormulaContrastRatio + 1.2 : (annotationLike ? cfg.minContrastRatio + 2.2 : cfg.minContrastRatio + 1.2);
    const readable = ensureReadableColor(fill.a > 0.02 ? fill : { r: 230, g: 238, b: 255, a: 1 }, bg, targetContrast);
    node.setAttribute('fill', 'rgb(' + readable.r + ', ' + readable.g + ', ' + readable.b + ')');
    node.setAttribute('data-codex-visibility-boosted', 'true');
    node.setAttribute('stroke-width', formulaLike ? '1.2' : '0.8');
  }

  function boostPanels() {
    const selectors = [
      '.graph-wrap',
      '.viz',
      '.moduleViz',
      '.modulePanel',
      '.card',
      '.wrap > *',
      '[class*="chart"]',
      '[class*="graph"]',
      '[class*="visual"]'
    ];
    const panels = new Set();
    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(panel => panels.add(panel));
    });

    const viewportArea = window.innerWidth * window.innerHeight;
    panels.forEach(panel => {
      if (!isVisible(panel)) return;
      const rect = panel.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < viewportArea * 0.12) return;
      const visuals = [...panel.querySelectorAll('svg,canvas,img')].filter(isVisible);
      if (visuals.length === 0) return;
      panel.classList.add('codex-visibility-boost');
      visuals.forEach(visual => {
        const visualRect = visual.getBoundingClientRect();
        const fillRatio = (visualRect.width * visualRect.height) / Math.max(area, 1);
        const desiredHeight = Math.min(Math.max(visualRect.height, rect.height * 0.68), 420);
        if (fillRatio < Math.max(cfg.minPanelFillRatio, 0.5) && desiredHeight > visualRect.height + 24) {
          visual.style.height = Math.round(desiredHeight) + 'px';
        }
        visual.style.width = '100%';
        visual.style.maxWidth = '100%';
      });
    });
  }

  function apply() {
    document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,label,button,summary,strong,em,small,span,div,code,pre,input,select,textarea').forEach(styleHtmlElement);
    document.querySelectorAll('svg text, text').forEach(styleSvgText);
    boostPanels();
  }

  let scheduled = false;
  function queueApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  }

  new MutationObserver(queueApply).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true
  });

  document.addEventListener('DOMContentLoaded', queueApply, { once: true });
  window.addEventListener('load', queueApply, { once: true });
  setTimeout(queueApply, 50);
  setTimeout(queueApply, 500);
  setTimeout(queueApply, 1500);
})();
</script>`.trim();
}

function injectBeforeClosingTag(source, tagName, block) {
  const pattern = new RegExp(`</${tagName}>`, 'i');
  if (pattern.test(source)) {
    return source.replace(pattern, `${block}\n</${tagName}>`);
  }
  return `${source}\n${block}\n`;
}

function stripExistingEnhancer(source) {
  return source
    .replace(/\n?<style id="codex-visibility-enhancer-style">[\s\S]*?<\/style>\n?/i, '\n')
    .replace(/\n?<script id="codex-visibility-enhancer-script">[\s\S]*?<\/script>\n?/i, '\n');
}

function visibilityOutputPath(toolPath) {
  const ext = extname(toolPath) || '.html';
  const stem = basename(toolPath, ext);
  const baseStem = stem.endsWith('_visibility') ? stem.slice(0, -'_visibility'.length) : stem;
  return join(dirname(toolPath), `${baseStem}_visibility${ext}`);
}

export async function applyDeterministicVisibilityFixes(state, verdict = null) {
  const toolPath = state.data.toolPath;
  const runDir = state.runDir;
  const thresholds = enhancerThresholds(state.data.config || {});
  const original = await readFile(toolPath, 'utf-8');

  let patched = stripExistingEnhancer(original);
  patched = injectBeforeClosingTag(patched, 'head', buildEnhancerStyle());
  patched = injectBeforeClosingTag(patched, 'body', buildEnhancerScript(thresholds));

  const outputPath = visibilityOutputPath(toolPath);
  await writeFile(outputPath, patched);

  const reportPath = join(runDir, 'qa-reports', 'visibility-fixer-report.json');
  await writeFile(reportPath, JSON.stringify({
    appliedAt: new Date().toISOString(),
    sourceToolPath: toolPath,
    outputToolPath: outputPath,
    thresholds,
    issues: verdict?.issues || [],
  }, null, 2));

  return outputPath;
}
