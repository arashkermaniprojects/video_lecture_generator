/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  PERMANENT FIXES — do not revert these without understanding why ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  1. validateSections: Only click_tab failures are blocking.      ║
 * ║     Other selector failures (card clicks, sliders) are warnings. ║
 * ║     The old code treated ALL failures as blocking, causing       ║
 * ║     infinite fix/re-validate loops lasting 6+ hours.            ║
 * ║                                                                  ║
 * ║  2. planSections saves to config/sections.json after planning.   ║
 * ║     This means --skip-planning on future runs uses the full set  ║
 * ║     of discovered sections, not the original 6-section stub.    ║
 * ║                                                                  ║
 * ║  3. maxTokens=32000 for generateSections. The old 16384 limit    ║
 * ║     truncated Claude's response mid-JSON causing parse failures. ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

/**
 * Section Planner Agent
 *
 * Automatically explores the interactive HTML tool and generates
 * a comprehensive set of lecture sections covering ALL content.
 *
 * Process:
 *   1. Launch browser and catalog every interactive element
 *   2. Map the pedagogical flow (what to teach, in what order)
 *   3. Generate navActions + narration for each section
 *   4. Validate that generated sections are navigable
 *
 * This replaces hand-written sections.json with auto-discovered content.
 */

import { chromium } from 'playwright';
import { runAgent, parseVerdict } from '../utils/claude-agent.mjs';
import { executeNavActions } from './navigator.mjs';
import { writeFile, readFile, readdir } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { normalizeSectionsToModules } from '../utils/section-normalizer.mjs';

/**
 * Auto-detect a lecture guide file next to the HTML tool.
 * Looks for files like lecture_guide.txt, guide.txt, teaching_guide.txt, etc.
 * Also checks if a guide references the tool file name to avoid false matches
 * when multiple tools share a directory.
 */
export async function detectGuide(toolPath) {
  const toolDir = dirname(toolPath);
  const toolName = basename(toolPath, '.html').toLowerCase();
  try {
    const files = await readdir(toolDir);
    const { stat } = await import('fs/promises');

    // Check for guide directories first (modular guides)
    const guideDirPatterns = [/^lecture[-_]?guide$/i, /^teaching[-_]?guide$/i, /^guide$/i];
    for (const pattern of guideDirPatterns) {
      const match = files.find(f => pattern.test(f));
      if (match) {
        const fullPath = join(toolDir, match);
        const s = await stat(fullPath).catch(() => null);
        if (s?.isDirectory()) {
          // Verify it has numbered txt files (not just a random directory)
          const subfiles = await readdir(fullPath);
          if (subfiles.some(f => /^\d+.*\.(txt|md)$/.test(f))) {
            return fullPath;
          }
        }
      }
    }

    // First pass: look for guide files that reference this specific tool in their name
    const toolSpecificGuide = files.find(f => {
      if (!(f.endsWith('.txt') || f.endsWith('.md'))) return false;
      const lower = f.toLowerCase();
      const toolWords = toolName.replace(/[-_]/g, ' ').split(' ').filter(w => w.length > 3);
      return toolWords.some(w => lower.includes(w)) && /guide|scenario|teaching/i.test(lower);
    });
    if (toolSpecificGuide) return join(toolDir, toolSpecificGuide);

    // Second pass: generic guide files, but only if there's exactly one HTML tool
    const htmlFiles = files.filter(f => f.endsWith('.html'));
    if (htmlFiles.length <= 1) {
      const guidePatterns = [
        /^lecture[-_]?guide\./i,
        /^teaching[-_]?guide\./i,
        /^guide\./i,
      ];
      for (const pattern of guidePatterns) {
        const match = files.find(f => pattern.test(f) && (f.endsWith('.txt') || f.endsWith('.md')));
        if (match) return join(toolDir, match);
      }
    }

    // Third pass: check guide content for tool reference (expensive, for ambiguous cases)
    if (htmlFiles.length > 1) {
      const guidePatterns = [/^lecture[-_]?guide\./i, /^teaching[-_]?guide\./i, /^guide\./i];
      for (const pattern of guidePatterns) {
        const match = files.find(f => pattern.test(f) && (f.endsWith('.txt') || f.endsWith('.md')));
        if (match) {
          const content = await readFile(join(toolDir, match), 'utf-8');
          const toolBaseName = basename(toolPath);
          if (content.includes(toolBaseName) || content.toLowerCase().includes(toolName.replace(/_/g, ' '))) {
            return join(toolDir, match);
          }
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Read guide content, returning null if no guide found.
 * Supports both single-file and modular (directory) guides.
 *
 * For modular guides (directory with numbered files like 00_master.txt, 01_prologue.txt, etc.):
 *   Returns { type: 'modular', master, modules: [{ filename, content }] }
 *
 * For single-file guides:
 *   Returns { type: 'single', content }
 */
export async function loadGuide(guidePath) {
  if (!guidePath) return null;
  try {
    const stat = await import('fs/promises').then(m => m.stat);
    const s = await stat(guidePath);

    if (s.isDirectory()) {
      // Modular guide directory
      const files = (await readdir(guidePath)).filter(f => f.endsWith('.txt') || f.endsWith('.md')).sort();
      const modules = [];
      let master = null;
      for (const f of files) {
        const content = await readFile(join(guidePath, f), 'utf-8');
        if (f.startsWith('00') || f.toLowerCase().includes('master')) {
          master = content;
        } else {
          modules.push({ filename: f, content });
        }
      }
      return { type: 'modular', master, modules, dirPath: guidePath };
    } else {
      // Single-file guide
      const content = await readFile(guidePath, 'utf-8');
      return content;
    }
  } catch {
    return null;
  }
}

function formatSelectOptions(select) {
  return (select.options || [])
    .map(opt => typeof opt === 'string' ? opt : opt.text)
    .join(', ');
}

function formatSelectStates(selectStates = []) {
  return selectStates.map(sel =>
    `  - Dynamic states for #${sel.id}:\n${(sel.states || []).map(state =>
      `    * [${state.index}] ${state.optionText}: buttons=[${(state.buttons || []).map(btn => btn.text).join(', ')}]`
    ).join('\n')}`
  ).join('\n');
}

/**
 * Explore the HTML tool and catalog all interactive elements.
 * Works generically with any HTML tool — discovers tabs, buttons, sliders,
 * clickable cards, selects, collapsibles, SVGs, and text content.
 */
export async function exploreTool(toolPath) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.goto(`file://${toolPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Discover all tabs
  const tabs = await page.evaluate(() => {
    return [...document.querySelectorAll('.tab')].map(t => ({
      text: t.textContent.trim(),
      dataMod: t.getAttribute('data-mod')
    }));
  });

  // Discover page-level elements (theory sections, intro sections, etc.)
  const pageElements = await page.evaluate(() => {
    // Collapsible/expandable sections at the top level
    const introSections = [...document.querySelectorAll('.intro-section, .intro-card, .collapsible, [class*="theory"]')].map(el => ({
      tag: el.tagName,
      classes: [...el.classList].join(' '),
      id: el.id || null,
      text: el.textContent.trim().substring(0, 300)
    }));

    // Key concept boxes, warning boxes, example boxes
    const specialBoxes = [...document.querySelectorAll('.key-concept, .warning-box, .example-box, .phase-bar, [class*="concept"], [class*="warning"]')].map(el => ({
      classes: [...el.classList].join(' '),
      title: el.querySelector('[class*="title"]')?.textContent?.trim() || '',
      text: el.textContent.trim().substring(0, 200)
    }));

    // Math content
    const mathContent = [...document.querySelectorAll('.math-inline, .math-block, .code-block, .math, .formal-def, [class*="formula"]')].map(el =>
      el.textContent.trim().substring(0, 150)
    );

    return { introSections, specialBoxes, mathContent };
  });

  const modules = await page.evaluate(() => {
    const seen = new Set();
    const modules = [];

    const buildSelector = (el) => {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;

      const parts = [];
      let node = el;
      while (node && node !== document.body) {
        const parent = node.parentElement;
        if (!parent) break;
        const idx = Array.from(parent.children).indexOf(node) + 1;
        parts.unshift(`:nth-child(${idx})`);
        if (parent.id) {
          parts.unshift(`#${CSS.escape(parent.id)}`);
          return parts.join(' > ');
        }
        node = parent;
      }
      return parts.join(' > ');
    };

    const textExcerpt = (el) => el.textContent.trim().replace(/\s+/g, ' ').substring(0, 160);
    const titleFor = (el) =>
      el.querySelector?.('.kc-title, .wb-title, .eb-title, summary, h2, h3, label')?.textContent?.trim()
      || el.getAttribute?.('aria-label')
      || el.id
      || textExcerpt(el).substring(0, 60);

    const pushModule = (el, meta) => {
      if (!el) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const selector = buildSelector(el);
      if (!selector || seen.has(selector)) return;
      seen.add(selector);
      modules.push({
        selector,
        title: titleFor(el),
        textExcerpt: textExcerpt(el),
        region: meta.region,
        kind: meta.kind,
        interactive: Boolean(meta.interactive),
        preferMotion: Boolean(meta.preferMotion)
      });
    };

    const introBody = document.getElementById('introBody');
    if (introBody) {
      if (introBody.firstElementChild) {
        pushModule(introBody.firstElementChild, { region: 'intro', kind: 'roadmap', interactive: false, preferMotion: false });
      }
      introBody.querySelectorAll(':scope > h3, :scope > .key-concept, :scope > .warning-box, :scope > .example-box, :scope > .code-block, :scope > table').forEach(el => {
        const kind = el.matches('h3') ? 'heading'
          : el.matches('.code-block') ? 'formula'
          : el.matches('table') ? 'table'
          : 'concept';
        pushModule(el, { region: 'intro', kind, interactive: false, preferMotion: false });
      });
    }

    const wrap = document.querySelector('.wrap');
    if (wrap) {
      [
        ['#algo', 'control', false],
        ['#speed', 'control', false],
        ['#presetRow', 'control', false],
        ['.btnRow', 'control', false],
        ['#algoOverview', 'reference', false],
        ['#phaseBar', 'visual', true],
        ['#vizArea', 'visual', true],
        ['#resultBar', 'visual', true],
        ['#pseudocode', 'visual', true],
        ['#codeHelp', 'visual', true]
      ].forEach(([selector, kind, preferMotion]) => {
        pushModule(document.querySelector(selector), {
          region: 'interactive',
          kind,
          interactive: true,
          preferMotion
        });
      });
    }

    const appendixToggle = document.getElementById('appendixToggleBtn');
    if (appendixToggle) {
      pushModule(appendixToggle, { region: 'appendix', kind: 'heading', interactive: false, preferMotion: false });
    }
    const appendixBody = document.getElementById('appendixBody');
    if (appendixBody) {
      appendixBody.querySelectorAll(':scope > h3, :scope > .key-concept, :scope > .warning-box, :scope > .example-box, :scope > .code-block, :scope > table').forEach(el => {
        const kind = el.matches('h3') ? 'heading'
          : el.matches('.code-block') ? 'formula'
          : el.matches('table') ? 'table'
          : 'concept';
        pushModule(el, { region: 'appendix', kind, interactive: false, preferMotion: false });
      });
    }

    document.querySelectorAll('svg[id], canvas[id]').forEach(el => {
      pushModule(el, { region: 'interactive', kind: 'visual', interactive: true, preferMotion: true });
    });

    return modules;
  });

  // For each tab, discover all interactive elements and content
  const tabContents = [];
  for (const tab of tabs) {
    await page.click(`.tab[data-mod="${tab.dataMod}"]`);
    await page.waitForTimeout(1000);

    const content = await page.evaluate((tabMod) => {
      // Try multiple panel selectors generically
      const panelSelectors = [
        `.modulePanel[data-mod="${tabMod}"]`,
        `.module[data-mod="${tabMod}"]`,
        `#mod-${tabMod}`,
        `.moduleViz[data-mod="${tabMod}"]`
      ];
      let panels = [];
      for (const sel of panelSelectors) {
        const el = document.querySelector(sel);
        if (el) panels.push(el);
      }
      const root = panels.length > 0 ? document.body : document.body;

      // Find all clickable elements with data attributes or specific classes
      const clickables = [...document.querySelectorAll('[onclick], .pipeline-node, .response-card, .notation-card, .algo-card, [data-id]')].filter(el => {
        // Only include elements visible in the current tab's panels
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(c => ({
        tag: c.tagName,
        classes: [...c.classList].join(' '),
        text: c.textContent.trim().substring(0, 120),
        dataId: c.getAttribute('data-id'),
        id: c.id || null,
        onclick: c.getAttribute('onclick')?.substring(0, 80) || null,
        parentId: c.parentElement?.id || null
      }));

      // Find all buttons (excluding tabs)
      const buttons = [...document.querySelectorAll('button, .btn')].filter(b => {
        if (b.classList.contains('tab')) return false;
        const style = window.getComputedStyle(b);
        return style.display !== 'none';
      }).map(b => ({
        text: b.textContent.trim().substring(0, 60),
        classes: [...b.classList].join(' '),
        id: b.id || null,
        onclick: b.getAttribute('onclick')?.substring(0, 80) || null
      }));

      // Find select dropdowns
      const selects = [...document.querySelectorAll('select')].filter(s => {
        const style = window.getComputedStyle(s);
        return style.display !== 'none';
      }).map(s => ({
        id: s.id,
        options: [...s.options].map(o => ({
          text: o.textContent.trim(),
          value: o.value
        }))
      }));

      // Find sliders
      const sliders = [...document.querySelectorAll('input[type="range"]')].filter(s => {
        const style = window.getComputedStyle(s);
        return style.display !== 'none';
      }).map(s => ({
        id: s.id,
        min: s.min, max: s.max, value: s.value,
        label: s.closest('.controls, .card, .modulePanel')?.querySelector(`label[for="${s.id}"]`)?.textContent?.trim()
          || s.previousElementSibling?.tagName === 'LABEL' ? s.previousElementSibling?.textContent?.trim()?.substring(0, 80) : null
      }));

      // Find collapsibles
      const collapsibles = [...document.querySelectorAll('.collapsible, .intro-card, [class*="collapsible"]')].map(c => ({
        title: (c.querySelector('.collapsible-toggle, .intro-header h2')?.textContent?.trim()) || '',
        isOpen: !c.querySelector('.collapsed')
      }));

      // Find SVGs and canvases (charts/graphs)
      const visuals = [...document.querySelectorAll('svg[id], canvas[id]')].map(v => ({
        type: v.tagName.toLowerCase(),
        id: v.id
      }));

      // Phase bars and info panels
      const phaseBars = [...document.querySelectorAll('.phase-bar')].filter(p => {
        const style = window.getComputedStyle(p);
        return style.display !== 'none';
      }).map(p => ({
        id: p.id || null,
        title: p.querySelector('.phaseTitle')?.textContent?.trim() || '',
        text: p.textContent.trim().substring(0, 200)
      }));

      // Stat pills
      const statPills = [...document.querySelectorAll('.pill, .stat')].filter(p => {
        const style = window.getComputedStyle(p);
        return style.display !== 'none';
      }).map(p => ({
        text: p.textContent.trim().substring(0, 100)
      }));

      // Text content sections (headings, paragraphs)
      const textContent = [...document.querySelectorAll('.key-concept, .warning-box, .example-box, .math-inline, .code-block')].filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none';
      }).map(el => ({
        classes: [...el.classList].join(' '),
        text: el.textContent.trim().substring(0, 200)
      }));

      // Comparison tables
      const tables = [...document.querySelectorAll('table')].filter(t => {
        const style = window.getComputedStyle(t);
        return style.display !== 'none';
      }).map(t => ({
        classes: [...t.classList].join(' '),
        headers: [...t.querySelectorAll('th')].map(th => th.textContent.trim()),
        rowCount: t.querySelectorAll('tbody tr').length
      }));

      return { clickables, buttons, selects, sliders, collapsibles, visuals, phaseBars, statPills, textContent, tables };
    }, tab.dataMod);

    if (Array.isArray(content.selects) && content.selects.length > 0) {
      content.selectStates = [];
      for (const select of content.selects) {
        const originalIndex = await page.evaluate((id) => {
          const el = document.getElementById(id);
          return el ? el.selectedIndex : 0;
        }, select.id);

        const states = [];
        for (let index = 0; index < select.options.length; index++) {
          await page.evaluate(({ id, index }) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.selectedIndex = index;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, { id: select.id, index });
          await page.waitForTimeout(150);

          const state = await page.evaluate((id) => {
            const visible = (el) => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden';
            };
            const el = document.getElementById(id);
            if (!el) return null;
            const option = el.options[el.selectedIndex];
            const buttons = [...document.querySelectorAll('button, .btn')]
              .filter(btn => !btn.classList.contains('tab') && visible(btn))
              .map(btn => ({
                text: btn.textContent.trim().substring(0, 60),
                id: btn.id || null,
                classes: [...btn.classList].join(' ')
              }));
            return {
              id,
              index: el.selectedIndex,
              value: el.value,
              optionText: option?.textContent?.trim() || '',
              buttons
            };
          }, select.id);

          if (state) states.push(state);
        }

        await page.evaluate(({ id, index }) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.selectedIndex = index;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { id: select.id, index: originalIndex });
        await page.waitForTimeout(100);

        content.selectStates.push({ id: select.id, states });
      }
    }

    // Take a screenshot of each tab
    const screenshotPath = `/tmp/explore_tab_${tab.dataMod}.jpg`;
    await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 85 });

    tabContents.push({ tab, content, screenshotPath });
  }

  // Single-page tools may have no tabs at all. In that case, collect one
  // "page" content bundle so section planning can still work.
  if (tabs.length === 0) {
    const content = await page.evaluate(() => {
      const clickables = [...document.querySelectorAll('[onclick], [data-id], .algo-card, .preset-btn, [role="button"]')].filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(c => ({
        tag: c.tagName,
        classes: [...c.classList].join(' '),
        text: c.textContent.trim().substring(0, 120),
        dataId: c.getAttribute('data-id'),
        id: c.id || null,
        onclick: c.getAttribute('onclick')?.substring(0, 80) || null,
        parentId: c.parentElement?.id || null
      }));

      const buttons = [...document.querySelectorAll('button, .btn')].filter(b => {
        const style = window.getComputedStyle(b);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(b => ({
        text: b.textContent.trim().substring(0, 60),
        classes: [...b.classList].join(' '),
        id: b.id || null,
        onclick: b.getAttribute('onclick')?.substring(0, 80) || null
      }));

      const selects = [...document.querySelectorAll('select')].filter(s => {
        const style = window.getComputedStyle(s);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(s => ({
        id: s.id,
        options: [...s.options].map(o => ({
          text: o.textContent.trim(),
          value: o.value
        }))
      }));

      const sliders = [...document.querySelectorAll('input[type="range"]')].filter(s => {
        const style = window.getComputedStyle(s);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(s => ({
        id: s.id,
        min: s.min,
        max: s.max,
        value: s.value
      }));

      const collapsibles = [...document.querySelectorAll('.collapsible, .intro-card, .intro-header, [class*="collapsible"]')].map(c => ({
        title: c.textContent.trim().substring(0, 120),
        id: c.id || null
      }));

      const visuals = [...document.querySelectorAll('svg[id], canvas[id], #vizArea, #phaseTitle, .phase-bar')].filter(v => {
        const style = window.getComputedStyle(v);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(v => ({
        type: v.tagName.toLowerCase(),
        id: v.id || null,
        classes: [...v.classList].join(' ')
      }));

      const phaseBars = [...document.querySelectorAll('.phase-bar')].filter(p => {
        const style = window.getComputedStyle(p);
        return style.display !== 'none';
      }).map(p => ({
        id: p.id || null,
        title: p.querySelector('.phaseTitle')?.textContent?.trim() || '',
        text: p.textContent.trim().substring(0, 200)
      }));

      const statPills = [...document.querySelectorAll('.pill, .stat')].filter(p => {
        const style = window.getComputedStyle(p);
        return style.display !== 'none';
      }).map(p => ({
        text: p.textContent.trim().substring(0, 100)
      }));

      const textContent = [...document.querySelectorAll('h1, h2, h3, p, .key-concept, .warning-box, .example-box, .code-block, .appendix')].filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).map(el => ({
        tag: el.tagName,
        id: el.id || null,
        classes: [...el.classList].join(' '),
        text: el.textContent.trim().substring(0, 200)
      }));

      const tables = [...document.querySelectorAll('table')].filter(t => {
        const style = window.getComputedStyle(t);
        return style.display !== 'none';
      }).map(t => ({
        classes: [...t.classList].join(' '),
        headers: [...t.querySelectorAll('th')].map(th => th.textContent.trim()),
        rowCount: t.querySelectorAll('tbody tr').length
      }));

      return { clickables, buttons, selects, sliders, collapsibles, visuals, phaseBars, statPills, textContent, tables };
    });

    if (Array.isArray(content.selects) && content.selects.length > 0) {
      content.selectStates = [];
      for (const select of content.selects) {
        const originalIndex = await page.evaluate((id) => {
          const el = document.getElementById(id);
          return el ? el.selectedIndex : 0;
        }, select.id);

        const states = [];
        for (let index = 0; index < select.options.length; index++) {
          await page.evaluate(({ id, index }) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.selectedIndex = index;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, { id: select.id, index });
          await page.waitForTimeout(150);

          const state = await page.evaluate((id) => {
            const visible = (el) => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden';
            };
            const el = document.getElementById(id);
            if (!el) return null;
            const option = el.options[el.selectedIndex];
            const buttons = [...document.querySelectorAll('button, .btn')]
              .filter(btn => visible(btn))
              .map(btn => ({
                text: btn.textContent.trim().substring(0, 60),
                id: btn.id || null,
                classes: [...btn.classList].join(' ')
              }));
            return {
              id,
              index: el.selectedIndex,
              value: el.value,
              optionText: option?.textContent?.trim() || '',
              buttons
            };
          }, select.id);

          if (state) states.push(state);
        }

        await page.evaluate(({ id, index }) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.selectedIndex = index;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { id: select.id, index: originalIndex });
        await page.waitForTimeout(100);

        content.selectStates.push({ id: select.id, states });
      }
    }

    const screenshotPath = '/tmp/explore_single_page.jpg';
    await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 85, fullPage: false });
    tabContents.push({
      tab: { text: 'Single Page', dataMod: null },
      content,
      screenshotPath
    });
  }

  // Extract JavaScript data structures generically
  const jsData = await page.evaluate(() => {
    const data = {};
    // Known structures from various tools
    const knownGlobals = [
      'NOTATIONS', 'ITER_ALGOS', 'REC_ALGOS', 'CHALLENGES',
      'rmData', 'stageInfo', 'ppoState'
    ];
    for (const name of knownGlobals) {
      try {
        const val = window[name];
        if (val && typeof val === 'object') {
          data[name] = JSON.parse(JSON.stringify(val, (k, v) => {
            if (typeof v === 'function') return '[function]';
            if (typeof v === 'string' && v.length > 300) return v.substring(0, 300) + '...';
            return v;
          }));
        }
      } catch {}
    }
    return data;
  });

  // Get page title for context
  const pageTitle = await page.title();
  const pageH1 = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() || '');

  await browser.close();

  return { tabs, tabContents, jsData, pageElements, pageTitle, pageH1, modules };
}

/**
 * Use Claude to generate a comprehensive lecture plan from discovered content.
 * When a guide is available, uses it as the primary teaching scenario.
 * Otherwise, auto-generates from discovered tool content.
 *
 * For modular guides (directory with per-module files), generates sections
 * one module at a time to stay within token limits.
 */
export async function generateSections(toolExploration, toolPath, guideData = null) {
  // Handle modular guides: generate sections per module then combine
  if (guideData && typeof guideData === 'object' && guideData.type === 'modular') {
    return generateSectionsModular(toolExploration, toolPath, guideData);
  }

  // For single-file guides, guideData is the raw string content
  const guideContent = (typeof guideData === 'string') ? guideData : null;

  const { tabs, tabContents, jsData, pageElements, pageTitle, pageH1, modules = [] } = toolExploration;
  const hasTabs = tabs.length > 0;

  const topicName = pageH1 || pageTitle || basename(toolPath, '.html').replace(/[-_]/g, ' ');

  // Build the discovered elements section.
  // When a guide is present, include only essential selectors (the guide already describes content).
  // Without a guide, include full exploration data for auto-discovery.
  const formatSelectOptions = (select) => (select.options || [])
    .map(opt => typeof opt === 'string' ? opt : opt.text)
    .join(', ');

  const formatSelectStates = (selectStates = []) => selectStates.map(sel =>
    `  - Dynamic states for #${sel.id}:\n${(sel.states || []).map(state =>
      `    * [${state.index}] ${state.optionText}: buttons=[${(state.buttons || []).map(btn => btn.text).join(', ')}]`
    ).join('\n')}`
  ).join('\n');

  const moduleCatalog = modules.length > 0
    ? `## MODULE CATALOG
Each item below is a concrete module that can own exactly one video section.
Modules marked [motion] should be demonstrated with real state changes on screen.

${modules.map((module, idx) =>
  `${idx + 1}. ${module.selector} | ${module.region}/${module.kind}${module.preferMotion ? ' [motion]' : ''} | ${module.title}`
).join('\n')}`
    : '';

  let discoveredContent;

  if (guideContent) {
    // Guide-aware mode: compact selector reference only
    discoveredContent = `## TOOL: "${topicName}"

## TABS
${hasTabs
  ? tabs.map(t => `- "${t.text}" (data-mod="${t.dataMod}")`).join('\n')
  : '- None. This is a single-page interactive tool; use page sections, selectors, buttons, dropdowns, and zoom targets instead of tab switches.'}

## INTERACTIVE ELEMENTS PER TAB (CSS selectors for navActions)
${tabContents.map(tc => {
  const c = tc.content;
  const buttons = (c.buttons || []).map(b => `  - Button: "${b.text}"${b.id ? ` id="${b.id}"` : ''}${b.onclick ? ` onclick="${b.onclick}"` : ''}`).join('\n');
  const sliders = (c.sliders || []).map(s => `  - Slider: #${s.id} min=${s.min} max=${s.max} default=${s.value}`).join('\n');
  const selects = (c.selects || []).map(s => `  - Select: #${s.id} options=[${formatSelectOptions(s)}]`).join('\n');
  const selectStates = formatSelectStates(c.selectStates || []);
  const visuals = (c.visuals || []).map(v => `  - ${v.type.toUpperCase()}: #${v.id}`).join('\n');
  const clickables = (c.clickables || []).filter(el => el.onclick || el.classes.includes('node') || el.classes.includes('card'))
    .map(el => `  - Clickable: ${el.classes}${el.id ? ` id="${el.id}"` : ''}${el.onclick ? ` onclick="${el.onclick}"` : ''} "${el.text.substring(0, 50)}"`).join('\n');
  return `### Tab: "${tc.tab.text}" (data-mod="${tc.tab.dataMod}")
${clickables}
${buttons}
${sliders}
${selects}
${selectStates}
${visuals}`;
}).join('\n\n')}

## COLLAPSIBLE SECTIONS
- Theory section: click ".intro-header" to toggle (or click_selector target=".intro-header")

${moduleCatalog}`;
  } else {
    // Auto-discovery mode: full exploration data
    discoveredContent = `## TOOL: "${topicName}"

## TABS
${hasTabs
  ? tabs.map(t => `- "${t.text}" (data-mod="${t.dataMod}")`).join('\n')
  : '- None. This is a single-page interactive tool; use page sections, selectors, buttons, dropdowns, and zoom targets instead of tab switches.'}

## PAGE-LEVEL ELEMENTS
${pageElements ? `
Intro/Theory sections: ${JSON.stringify(pageElements.introSections?.slice(0, 5), null, 2)}
Special boxes (concepts, warnings): ${JSON.stringify(pageElements.specialBoxes?.slice(0, 10), null, 2)}
Math content: ${JSON.stringify(pageElements.mathContent?.slice(0, 10))}
` : 'None found'}

## ${hasTabs ? 'CONTENT PER TAB' : 'SINGLE-PAGE INTERACTIVE CONTENT'}
${tabContents.map(tc => `
### ${hasTabs ? `Tab: "${tc.tab.text}" (data-mod="${tc.tab.dataMod}")` : 'Page controls and visible modules'}
Clickable elements: ${JSON.stringify(tc.content.clickables, null, 2)}
Buttons: ${JSON.stringify(tc.content.buttons, null, 2)}
Selects: ${JSON.stringify(tc.content.selects, null, 2)}
Select states: ${JSON.stringify(tc.content.selectStates || [], null, 2)}
Sliders: ${JSON.stringify(tc.content.sliders, null, 2)}
Collapsibles: ${JSON.stringify(tc.content.collapsibles, null, 2)}
Visuals (SVG/Canvas): ${JSON.stringify(tc.content.visuals, null, 2)}
Phase bars: ${JSON.stringify(tc.content.phaseBars, null, 2)}
Tables: ${JSON.stringify(tc.content.tables, null, 2)}
Text content: ${JSON.stringify(tc.content.textContent?.slice(0, 5), null, 2)}
`).join('\n')}

## JAVASCRIPT DATA STRUCTURES
${JSON.stringify(jsData, null, 2)}

${moduleCatalog}`;
  }

  // Build the guide section if available — trim redundant sections to stay within token limits
  let guideSection = '';
  if (guideContent) {
    // Extract the most important parts of the guide:
    // Section A (prompt/overview) — brief, keep it
    // Section B (component reference) — very long, redundant with discovered selectors, REMOVE
    // Section C (teaching scenario) — essential, defines acts/timing/demonstrations, KEEP
    // Section D (checklist) — redundant with Section C, REMOVE
    // Section E (timing summary) — brief, keep it
    let trimmedGuide = guideContent;

    // Remove Section B (component reference) — we already have discovered selectors
    const sectionBStart = trimmedGuide.indexOf('SECTION B');
    const sectionCStart = trimmedGuide.indexOf('SECTION C');
    if (sectionBStart > 0 && sectionCStart > sectionBStart) {
      trimmedGuide = trimmedGuide.substring(0, sectionBStart) + trimmedGuide.substring(sectionCStart);
    }

    // Remove Section D (quick-reference checklist) — redundant with Section C
    const sectionDStart = trimmedGuide.indexOf('SECTION D');
    if (sectionDStart > 0) {
      const sectionEStart = trimmedGuide.indexOf('SECTION E', sectionDStart);
      if (sectionEStart > 0) {
        trimmedGuide = trimmedGuide.substring(0, sectionDStart) + trimmedGuide.substring(sectionEStart);
      } else {
        trimmedGuide = trimmedGuide.substring(0, sectionDStart);
      }
    }

    // Remove the end-of-document marker and trailing whitespace
    trimmedGuide = trimmedGuide.replace(/={10,}\s*END OF DOCUMENT\s*={10,}\s*$/, '').trim();

    guideSection = `
## LECTURE GUIDE (PRIMARY SOURCE)
You have a detailed teaching guide that specifies exactly how to teach this lecture.
Follow the guide's teaching scenario CLOSELY for:
- The order of topics and acts
- Specific demonstrations with parameter values
- What to say at each stage (adapt for narration, never reference UI)
- Timing and pacing
- Key pedagogical points and "aha" moments

THE GUIDE:
---
${trimmedGuide}
---

IMPORTANT: The guide references UI elements (tabs, sliders, buttons). Translate these into
navActions but NEVER mention them in the narration. The narration must teach the concept as if
the professor is explaining to students — the visual just happens to be on screen.
`;
  }

  // Determine valid tab targets from discovered tabs
  const validTabTargets = tabs.map(t => t.dataMod);
  const tabTargetList = validTabTargets.map(t => `"${t}"`).join(', ');

  const prompt = `You are a master lecturer designing a comprehensive video lecture on "${topicName}".

You have an interactive HTML tool that you will use as a visual aid.

${discoveredContent}

${guideSection}

## NAVIGATION ACTIONS AVAILABLE
${hasTabs
  ? `- click_tab: { action: "click_tab", target: "<data-mod value>" }
  VALID target values: ${tabTargetList}
  **CRITICAL**: click_tab MUST use "target", never "text". The recorder uses target to find
  the button — without it the tab switch is silently skipped and the section shows the wrong tab.
  **EVERY section that needs a specific tab must include click_tab with target**, even if the
  previous section was already on that tab. The page is reloaded between sections so tab state
  does NOT carry over.`
  : `- This tool has no tabs. Do NOT emit click_tab actions.
  Begin each section by focusing the relevant page region with zoom_to or scroll_to, then use
  click_selector, click_button, set_select, and set_slider to establish the state you want.`}
- click_nth: { action: "click_nth", selector: "<css selector>", index: <0-based> }
- click_button: { action: "click_button", text: "<exact button text>" }
- click_selector: { action: "click_selector", target: "<css selector>" }
- set_select: { action: "set_select", selector: "<select id>", index: <0-based> }
- set_slider: { action: "set_slider", selector: "<slider id>", value: <number> }
  NOTE: value must be the RAW slider value (what the HTML input sees), not the display value.
  For example, if a slider has min=0 max=100 and displays "0.20", set value to 20.
- scroll_to: { action: "scroll_to", target: "<css selector>" }
- zoom_to: { action: "zoom_to", target: "<css selector>" }
  CRITICAL: Use zoom_to (NOT scroll_to) for any content that should fill the viewport.
  This zooms and scales the target element to fill the 1920x1080 viewport, making text
  large and readable. Use for: theory subsections, visualization SVGs, formula blocks,
  comparison tables. ALWAYS prefer zoom_to over scroll_to for content visibility.
- reset_zoom: { action: "reset_zoom" }
  Resets any active zoom. Called automatically between sections, but use explicitly
  if you need to show multiple areas in one section.
- wait: { action: "wait", ms: <milliseconds> }
- wait_for_animation: { action: "wait_for_animation", timeout: <ms> }
- move_cursor_to: { action: "move_cursor_to", target: "<css selector>", label: "<what to point at>" }
- toggle_intro: { action: "click_selector", target: ".intro-header" }
  Use this to expand/collapse the theory section if the tool has one.

## YOUR TASK
${guideContent
  ? `Generate sections following the teaching guide's scenario. The guide defines acts/sections with timing.
Convert each act/demonstration into one or more sections. Each demonstration or major teaching point = one section.
Total sections: aim for 25-50 depending on the guide's detail level.`
  : `Generate a COMPLETE lecture with 30-45 sections covering ALL content in the tool.`}

## VIDEO-FIRST RULE
This is a video lecture, not a screenshot lecture.
Use brief static note sections only for orientation or definitions.
Once the interactive tool is available, the lecture should primarily show the tool DOING things:
- click buttons
- change dropdowns/sliders
- build states
- step through algorithms
- play animations and wait for them

If a section focuses an interactive module marked [motion], it MUST contain at least one state-changing navAction.
Prefer sequences like set_select -> click_button -> step_through, or click_button -> wait_for_animation.
Do NOT spend the whole lecture slowly zooming static note panels.

## TEACHING-DEMO RULES (CRITICAL)
- Keep the professor speech tighter. Prefer 1-3 concise sentences per section.
- For interactive demo sections, prefer 1-2 sentences so the visual has room to teach.
- For every important animated example, structure the lecture as:
  1. a quick overview run that plays once end-to-end
  2. a follow-up guided section that rebuilds and steps through the same idea more slowly
- After an autoplay finishes, add a short pause so students can absorb the final state.
- Use every meaningful control for teaching:
  - every dropdown option
  - every meaningful preset/example button
  - Build Steps, Step, Play, Pause, Reset
  - speed slider when it helps compare pacing
- Do not use controls as software-tour filler. Each control must help explain the algorithmic idea.

## NARRATION RULES (CRITICAL)
The narration is what a professor says while the visual is on screen. It must:

1. **TEACH the concept, not describe the tool.**
   - WRONG: "Click on the Pipeline tab to see the stages."
   - WRONG: "Move the beta slider to 0.20."
   - RIGHT: "The RLHF pipeline consists of three stages. First, supervised fine-tuning gives the model a baseline ability to follow instructions..."
   - RIGHT: "When we set the KL penalty coefficient to zero, the model is free to drift as far as it wants from the original policy. Watch what happens to the reward — it climbs rapidly, but this is actually reward hacking."
${guideContent
  ? `\n2. **Follow the guide's pedagogical points** — the guide tells you WHAT to say. Adapt it into
   natural professor speech. Include the guide's specific examples, numbers, and explanations.`
  : `\n2. **Be enthusiastic and engaging** — like an excited professor who LOVES this topic.`}

3. **Use concrete numbers and examples** from the tool's content.

4. **Explain WHY, not just WHAT** — connect concepts to real-world implications.

5. **NEVER reference the UI** — no "click", "tab", "card", "tool", "slider", "button", "animation", "graph", "panel", "screen". The visual supports the teaching silently.

## NAVIGATION (separate from narration)
Each section has navActions that silently set up the visual. The viewer sees the tool change while hearing the professor teach.

For each section output:
\`\`\`json
{
  "sections": [
    {
      "id": "01_intro",
      "group": "introduction",
      "navActions": [ ... ],
      "narration": "...",
      "expectedElements": ["css selectors that should be visible"],
      "scrollTarget": "#element or null",
      "focusTarget": "css selector of main visual focus",
      "isAnimated": false
    }
  ]
}
\`\`\`

IMPORTANT RULES:
- Narration should usually be 1-3 concise sentences per section
- Interactive demo sections should usually be 1-2 sentences
${guideContent
  ? `- Follow the guide's timing: convert the guide's total lecture time into proportional sections
- Cover EVERY demonstration and teaching point specified in the guide
- Use the guide's specific parameter values for slider/button demonstrations`
  : `- Total narration should produce a 17-22 minute lecture
- Cover EVERY interactive element in the tool at least once, including dropdown options, meaningful presets, and playback controls`}
- One section = one module from MODULE CATALOG above
- If focusTarget is an interactive module marked [motion], add real state-changing navActions so the viewer sees visible change over time
- After clicking a card/button, wait 300-700ms for the UI to update
- NEVER mention the tool, UI, clicks, buttons, or interactive elements in narration
- For animated elements (PPO training, etc.), use wait_for_animation with appropriate timeout
${hasTabs ? '- Include click_tab whenever a section depends on a specific tab.' : '- Because this tool has no tabs, sections should rely on zoom targets, selectors, dropdowns, and playback controls instead of click_tab.'}

POINTER RULES (CRITICAL — every section MUST have move_cursor_to):
- EVERY section must include at least one move_cursor_to action pointing at the main visual
- Use SVG ids or other stable selectors discovered from the tool content above
- Place move_cursor_to AFTER the setup actions that establish the state, not before
- Target the main visualization area for the current concept (e.g., the SVG chart, the diagram, the table)`;

  const result = await runAgent({
    model: 'claude-sonnet-4-6',
    maxTokens: 32000,
    systemPrompt: `You are an enthusiastic professor designing a video lecture on "${topicName}". The narration must TEACH concepts — never describe the UI tool. Write like you are passionately explaining to students, not giving a software tutorial. Keep demo narration concise and leave room for the animation to teach. Output valid JSON.${guideContent ? ' You have a detailed teaching guide — follow its pedagogical structure closely.' : ''}`,
    userMessage: prompt
  });

  const parsed = parseVerdict(result.text);
  if (!parsed || !parsed.sections) {
    throw new Error('Failed to parse sections from Claude response');
  }

  return parsed.sections;
}

/**
 * Generate sections from a modular guide (one Claude call per module file).
 * This keeps each prompt small enough to avoid CLI timeouts.
 */
async function generateSectionsModular(toolExploration, toolPath, guideData) {
  const { tabs, tabContents, pageTitle, pageH1 } = toolExploration;
  const topicName = pageH1 || pageTitle || basename(toolPath, '.html').replace(/[-_]/g, ' ');

  // Build compact tool reference (same as guide-aware mode)
  const toolRef = `## TOOL: "${topicName}"

## TABS
${tabs.map(t => `- "${t.text}" (data-mod="${t.dataMod}")`).join('\n')}

## INTERACTIVE ELEMENTS PER TAB (CSS selectors for navActions)
${tabContents.map(tc => {
  const c = tc.content;
  const buttons = (c.buttons || []).map(b => `  - Button: "${b.text}"${b.id ? ` id="${b.id}"` : ''}${b.onclick ? ` onclick="${b.onclick}"` : ''}`).join('\n');
  const sliders = (c.sliders || []).map(s => `  - Slider: #${s.id} min=${s.min} max=${s.max} default=${s.value}`).join('\n');
  const selects = (c.selects || []).map(s => `  - Select: #${s.id} options=[${formatSelectOptions(s)}]`).join('\n');
  const selectStates = formatSelectStates(c.selectStates || []);
  const visuals = (c.visuals || []).map(v => `  - ${v.type.toUpperCase()}: #${v.id}`).join('\n');
  const clickables = (c.clickables || []).filter(el => el.onclick || el.classes.includes('node') || el.classes.includes('card'))
    .map(el => `  - Clickable: ${el.classes}${el.id ? ` id="${el.id}"` : ''}${el.onclick ? ` onclick="${el.onclick}"` : ''} "${el.text.substring(0, 50)}"`).join('\n');
  return `### Tab: "${tc.tab.text}" (data-mod="${tc.tab.dataMod}")
${clickables}
${buttons}
${sliders}
${selects}
${selectStates}
${visuals}`;
}).join('\n\n')}

## COLLAPSIBLE SECTIONS
- Theory section: click ".intro-header" to toggle`;

  const validTabTargets = tabs.map(t => t.dataMod);
  const tabTargetList = validTabTargets.map(t => `"${t}"`).join(', ');

  const navActionsRef = `## NAVIGATION ACTIONS AVAILABLE
- click_tab: { action: "click_tab", target: "<data-mod value>" }
  VALID targets: ${tabTargetList}
  EVERY section MUST include click_tab — page reloads between sections.
- click_button: { action: "click_button", text: "<exact button text>" }
- click_selector: { action: "click_selector", target: "<css selector>" }
- set_select: { action: "set_select", selector: "<select id>", index: <0-based> }
- set_slider: { action: "set_slider", selector: "<slider id>", value: <RAW slider value> }
  NOTE: value = RAW input value. If slider has min=0 max=100 and displays "0.20", use value=20.
- scroll_to: { action: "scroll_to", target: "<css selector>" }
- wait: { action: "wait", ms: <milliseconds> }
- wait_for_animation: { action: "wait_for_animation", timeout: <ms> }
- move_cursor_to: { action: "move_cursor_to", target: "<css selector>", label: "<what>" }
- zoom_to: { action: "zoom_to", target: "<css selector>" }
  CRITICAL: Use zoom_to for any content module. Zooms the target to fill the viewport.
  Use for: theory subsections, visualization SVGs, control panels, comparison tables.
  ALWAYS prefer zoom_to over scroll_to for content visibility.`;

  const systemPrompt = `You are an enthusiastic professor designing a video lecture on "${topicName}". Convert each teaching step into lecture sections with navActions and narration. The narration must TEACH concepts — never mention the UI. Output valid JSON with a "sections" array.`;

  const allSections = [];
  let sectionCounter = 1;

  for (let i = 0; i < guideData.modules.length; i++) {
    const mod = guideData.modules[i];
    console.log(`      📄 Processing module: ${mod.filename}...`);

    // Build summary of previously generated sections to avoid duplicates
    const previousSummary = allSections.length > 0
      ? `\n## PREVIOUSLY GENERATED SECTIONS (DO NOT DUPLICATE)
The following sections have ALREADY been generated by earlier modules. Do NOT create sections
that repeat these topics. If the guide mentions reviewing a concept already covered, skip it
or reference it briefly in narration without creating a new section for it.

${allSections.map(s => `- ${s.id}: "${s.narration?.substring(0, 60)}..." [zoom_to: ${s.navActions?.find(a => a.action === 'zoom_to')?.target || 'none'}]`).join('\n')}
`
      : '';

    const modulePrompt = `${toolRef}

${navActionsRef}

${previousSummary}

## MODULE GUIDE
This is one module of the lecture. Generate sections for THIS module only.
Do NOT regenerate sections for topics already covered in previous modules listed above.

---
${mod.content}
---

## RULES

### VIEWPORT & READABILITY (CRITICAL — VISIBILITY IS TOP PRIORITY)
- The video is 1920x1080. EVERY section must show exactly ONE focused module/subsection.
- The module must fill the viewport with TEXT AS LARGE AS POSSIBLE.
- NEVER show a long scrollable page as one frame. Each subsection = one separate video section.
- Use zoom_to (NOT scroll_to) to make each module fill the viewport at maximum readable size.
- NO content should be cut off — the module must be COMPLETELY visible within the viewport.
- NO empty space around the module — zoom_to scales it up to fill the available area.
- For theory/text sections: zoom_to the specific heading/box so only that subsection is visible at large scale.
- For interactive tabs: COLLAPSE the theory section first, then click the tab, then zoom_to the visualization.
- For demo animations: zoom_to the chart/SVG so it fills the viewport. Controls should be visible but the visualization is the focus.
- EVERY button, slider, and control in the tool should be used at least once across all sections.
- No module should be left unexplained in the video.

### ZOOM STRATEGY (replaces scroll strategy)
- zoom_to hides all sibling modules and scales the target to fill the viewport.
- For the Theory section: each subsection is wrapped in a .theory-module div. Use these IDs:
  - zoom_to "#theory-what-is-rlhf" for "What is RLHF?" paragraph
  - zoom_to "#theory-core-idea" for the Core Idea equation box
  - zoom_to "#theory-three-stages" for "The Three Stages of RLHF"
  - zoom_to "#theory-why-not-supervised" for "Why Not Just Use More Supervised Data?"
  - zoom_to "#theory-bradley-terry" for the Bradley-Terry formulas
  - zoom_to "#theory-kl-reward-hacking" for KL Divergence & Reward Hacking + warning box
  - zoom_to "#theory-dpo" for "DPO: A Simpler Alternative"
  - zoom_to "#theory-rlhf-vs-dpo" for the "RLHF vs DPO at a Glance" summary
  EACH of these MUST be its own separate video section. NEVER combine multiple theory modules.
- For interactive tabs: zoom_to ".wrap" to show the COMPLETE tool at 1x (both panels visible).
  NEVER zoom into a fragment of an interactive tool (e.g., a single SVG or panel).
  The whole tool with controls + visualization must always be fully visible.
- ALWAYS add zoom_to AFTER click_tab and setup actions, BEFORE move_cursor_to
- If a module is too large to fit the viewport even at 1x zoom, zoom_to the specific part being discussed

### ABBREVIATIONS (CRITICAL)
- Before ANY abbreviation is first used in narration, it MUST be defined:
  - First use: "Reinforcement Learning from Human Feedback, or RLHF"
  - First use: "Supervised Fine-Tuning, often called SFT"
  - First use: "Proximal Policy Optimization, known as PPO"
  - First use: "Kullback-Leibler divergence, or KL divergence"
  - First use: "Direct Preference Optimization, or DPO"
- After the first definition, abbreviations can be used freely.
- Track which abbreviations have been defined across sections — do NOT re-define in every section.

### GENERAL
- Convert each teaching step/demonstration into 1-2 sections
- Keep narration tighter: 1-3 concise sentences per section
- For animated demos, prefer a paired structure:
  1. autoplay overview
  2. guided step-by-step explanation
- After an autoplay completes, add a short wait so students can absorb the result
- Section IDs: use prefix "${String(sectionCounter).padStart(2, '0')}_" and increment
- NEVER reference UI elements in narration — teach the concept
- Follow the guide's specific parameter values for demonstrations
- EVERY section needs click_tab + move_cursor_to targeting the main visualization
- For animated elements, use wait_for_animation with appropriate timeout (3000-8000ms)
- For slider changes: use set_slider with RAW value, then wait 500ms
- ONLY ONE zoom_to per section — multiple zoom_to causes visible jumping during recording.
  If a section needs to show different areas, split it into separate sections instead.

### INTERACTION REQUIREMENT (CRITICAL — most common failure)
- ANY section that shows an interactive tool (not static theory text) MUST include at least
  one navAction that CHANGES the tool's state. Showing a static default screen is NEVER acceptable.
  Valid state-changing actions: click_button, click_selector, click_nth, set_slider, set_select.
  Non-state-changing actions (click_tab, zoom_to, move_cursor_to, wait, scroll_to) do NOT count.
- A section that only has click_tab + zoom_to + move_cursor_to is REJECTED — it shows a static
  screen with no demonstration. The whole point of an interactive tool is to INTERACT with it.
- RULE: If the guide says to demonstrate something, there MUST be navActions that make it happen.
  Translate guide instructions to concrete navActions:
  - "drag/adjust/change a value" → set_slider or click_selector
  - "click/select an item" → click_selector or click_button or click_nth
  - "run/start/play" → click_button
  - "reset/clear" → click_button
  - "choose/pick from dropdown" → set_select
  - "compare/toggle" → click_selector or click_button
- If no specific control exists for a guide instruction (e.g., "drag bars" but tool uses
  custom drag elements), use the closest available control OR use click_selector to trigger
  the element's onclick handler.
- NEVER generate a section for an interactive view that just shows the default state — always
  demonstrate something changing on screen.

### MAYER'S MULTIMEDIA LEARNING PRINCIPLES (follow ALL 12)
1. COHERENCE: Show only the relevant module. No extraneous content on screen.
2. SIGNALING: Use move_cursor_to to point at what the narration discusses.
3. SPATIAL CONTIGUITY: Zoom to areas where text and visuals are together, not separated.
4. TEMPORAL CONTIGUITY: The visual must match the narration at every moment. Set up visuals
   BEFORE the narration starts (use setup actions at t=0). Never narrate about something
   that hasn't appeared on screen yet.
5. SEGMENTING: ONE concept per section. One experiment, one formula, one subsection.
   Never cram multiple topics into one section.
6. PRE-TRAINING: Define ALL terms before using them. Early sections define abbreviations.
   Later sections can use them freely. If a formula appears on screen, the narration
   must have already explained each symbol.
7. MODALITY: Use spoken narration + interactive visuals, not walls of text.
   The narration explains; the visual demonstrates.
8. MULTIMEDIA: Every section must have BOTH narration AND a meaningful visual.
   No empty/blank screens.
9. PERSONALIZATION: Write narration in conversational professor tone, not textbook language.
   Use "we", "let's", "think about", "notice how".
10. VOICE: Natural speech patterns (handled by TTS).
11. REDUNDANCY: Narration should EXPLAIN the visual, not READ text that's on screen.
    Add insight, examples, "why it matters" — don't just describe what's visible.
12. IMAGE: N/A (no talking head in this format).

Output format:
\`\`\`json
{
  "sections": [
    {
      "id": "${String(sectionCounter).padStart(2, '0')}_section_name",
      "group": "module_group",
      "navActions": [ ... ],
      "narration": "...",
      "expectedElements": [],
      "focusTarget": "css selector",
      "isAnimated": false
    }
  ]
}
\`\`\``;

    const result = await runAgent({
      model: 'claude-sonnet-4-6',
      maxTokens: 16000,
      systemPrompt,
      userMessage: modulePrompt
    });

    const parsed = parseVerdict(result.text);
    if (parsed?.sections) {
      // Re-number section IDs to ensure global ordering
      for (const section of parsed.sections) {
        section.id = `${String(sectionCounter).padStart(2, '0')}_${section.id.replace(/^\d+_/, '')}`;
        sectionCounter++;
      }
      allSections.push(...parsed.sections);
      console.log(`      ✅ ${parsed.sections.length} sections from ${mod.filename}`);
    } else {
      console.log(`      ⚠️  Failed to parse sections from ${mod.filename}`);
    }
  }

  if (allSections.length === 0) {
    throw new Error('Failed to generate any sections from modular guide');
  }

  // ═══ POST-GENERATION INTERACTION VALIDATOR ═══════════════════════════════
  // Check that interactive tab sections actually have interactions.
  // Theory sections (zoom_to #theory-*) are exempt.
  // Sections with only click_tab + zoom_to + move_cursor_to are flagged.
  const INTERACTIVE_ACTIONS = new Set([
    'click_button', 'click_selector', 'click_nth',
    'set_slider', 'set_select', 'step_through'
  ]);
  const NON_INTERACTIVE_EXEMPT_GROUPS = new Set([
    'prologue', 'epilogue', 'introduction', 'theory', 'summary', 'transition'
  ]);

  let staticCount = 0;
  for (const s of allSections) {
    const isTheory = (s.navActions || []).some(a =>
      a.action === 'zoom_to' && a.target?.includes('theory')
    );
    const isExemptGroup = NON_INTERACTIVE_EXEMPT_GROUPS.has(s.group);
    if (isTheory || isExemptGroup) continue;

    const hasInteraction = (s.navActions || []).some(a => INTERACTIVE_ACTIONS.has(a.action));
    if (!hasInteraction) {
      staticCount++;
      console.log(`      ⚠️  Static section: ${s.id} — no interactive actions (only tab + zoom)`);
    }
  }
  if (staticCount > 0) {
    console.log(`      📊 Interaction check: ${staticCount} interactive-tab sections lack interactions`);
  }

  return allSections;
}

/**
 * Validate that generated sections are actually navigable.
 * ONLY click_tab failures are blocking — everything else is a warning.
 * Other selector failures (card clicks, slider moves) are handled
 * gracefully by the recorder at runtime.
 */
export async function validateSections(sections, toolPath) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const results = [];
  let passCount = 0;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    await page.goto(`file://${toolPath}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Filter out move_cursor_to for validation (it's a visual overlay, not a real nav action)
    const realNavActions = section.navActions.filter(a => a.action !== 'move_cursor_to');
    const navResults = await executeNavActions(page, realNavActions);

    // Only click_tab failures are blocking — other failures are warnings
    const tabFailures = navResults.filter(r => r.success === false && r.action === 'click_tab');
    const otherFailures = navResults.filter(r => r.success === false && r.action !== 'click_tab');

    const passed = tabFailures.length === 0;
    if (passed) passCount++;

    results.push({
      id: section.id,
      passed,
      failures: tabFailures.map(f => f.error || 'unknown'),
      warnings: otherFailures.map(f => ({ action: f.action, error: f.error || 'unknown' }))
    });

    if (tabFailures.length > 0) {
      console.log(`   ❌ Section ${section.id}: tab switch failed — BLOCKING`);
    } else if (otherFailures.length > 0) {
      console.log(`   ⚠️  Section ${section.id}: ${otherFailures.length} non-critical warning(s) (ignored)`);
    }
  }

  await browser.close();

  console.log(`   📊 Validation: ${passCount}/${sections.length} sections navigable`);
  return { results, passCount, total: sections.length };
}

/**
 * Fix sections that failed validation (tab-click failures only).
 */
export async function fixFailedSections(sections, validationResults, toolExploration) {
  const failed = validationResults.results.filter(r => !r.passed); // only blocking (tab) failures
  if (failed.length === 0) return sections;

  const failedSections = failed.map(f => {
    const section = sections.find(s => s.id === f.id);
    return { ...section, failures: f.failures };
  });

  const result = await runAgent({
    model: 'claude-sonnet-4-6',
    maxTokens: 16000,
    systemPrompt: 'You fix navigation actions for lecture sections. Output JSON array of fixed sections.',
    userMessage: `These sections failed browser navigation validation. Fix their navActions.

FAILED SECTIONS:
${JSON.stringify(failedSections, null, 2)}

AVAILABLE ELEMENTS PER TAB:
${JSON.stringify(toolExploration.tabContents.map(tc => ({
  tab: tc.tab,
  cards: tc.content.cards,
  buttons: tc.content.buttons,
  caseButtons: tc.content.caseButtons,
  selects: tc.content.selects
})), null, 2)}

Common issues:
- Selector doesn't exist → use correct CSS selector from the elements listed above
- Element not found → the tab might not be active, add click_tab first
- Index out of range → check how many elements match the selector

Output the fixed sections as:
\`\`\`json
{ "fixedSections": [ { "id": "...", "navActions": [...] } ] }
\`\`\``
  });

  const parsed = parseVerdict(result.text);
  if (!parsed?.fixedSections) return sections;

  // Merge fixes back into sections
  for (const fix of parsed.fixedSections) {
    const idx = sections.findIndex(s => s.id === fix.id);
    if (idx >= 0) {
      sections[idx].navActions = fix.navActions;
    }
  }

  return sections;
}

/**
 * Full section planning pipeline.
 * @param {string} toolPath - Path to the HTML tool
 * @param {string} outputDir - Directory to save generated sections
 * @param {string} [guidePath] - Optional explicit path to a lecture guide file
 */
export async function planSections(toolPath, outputDir, guidePath = null) {
  console.log('   🔍 Exploring interactive tool...');
  const exploration = await exploreTool(toolPath);

  console.log(`   📋 Found: ${exploration.tabs.length} tabs`);
  console.log(`      Title: ${exploration.pageH1 || exploration.pageTitle || '(unknown)'}`);
  for (const tc of exploration.tabContents) {
    const elCount = (tc.content.clickables?.length || 0) + (tc.content.buttons?.length || 0)
      + (tc.content.sliders?.length || 0) + (tc.content.selects?.length || 0);
    console.log(`      Tab "${tc.tab.text}": ${elCount} interactive elements`);
  }

  // Detect and load guide
  if (!guidePath) {
    guidePath = await detectGuide(toolPath);
  }
  const guideData = await loadGuide(guidePath);
  if (guideData) {
    if (typeof guideData === 'object' && guideData.type === 'modular') {
      console.log(`   📖 Modular lecture guide found: ${basename(guidePath)}/`);
      console.log(`      ${guideData.modules.length} module files + master`);
    } else {
      console.log(`   📖 Lecture guide found: ${basename(guidePath)}`);
      console.log(`      Guide size: ${(guideData.length / 1024).toFixed(1)} KB`);
    }
  } else {
    console.log('   📖 No lecture guide found — using auto-discovery only');
  }

  console.log('   🧠 Generating comprehensive lecture plan...');
  let sections = await generateSections(exploration, toolPath, guideData);
  console.log(`   📝 Generated ${sections.length} sections`);

  const normalized = normalizeSectionsToModules(sections, exploration);
  sections = normalized.sections;
  console.log(`   🧩 Module normalization: ${normalized.summary.moduleFocusAdjusted} focus target(s) tightened, ${normalized.summary.motionInjected} motion section(s) auto-upgraded`);

  // Validate
  console.log('   🔬 Validating navigation...');
  let validation = await validateSections(sections, toolPath);

  // Fix failed sections (one attempt)
  if (validation.passCount < validation.total) {
    console.log('   🔧 Fixing failed sections...');
    sections = await fixFailedSections(sections, validation, exploration);

    // Re-validate
    console.log('   🔬 Re-validating...');
    validation = await validateSections(sections, toolPath);
  }

  // Save to run directory
  const sectionsPath = join(outputDir, 'generated_sections.json');
  await writeFile(sectionsPath, JSON.stringify({ sections }, null, 2));
  console.log(`   💾 Saved to ${sectionsPath}`);

  // Also persist to config/sections.json so future --skip-planning runs use these sections
  try {
    const configDir = join(dirname(toolPath), 'config');
    const configPath = join(configDir, 'sections.json');
    await writeFile(configPath, JSON.stringify(sections, null, 2));
    console.log(`   💾 Updated config/sections.json (${sections.length} sections) — future runs will use these`);
  } catch {
    // Config dir may not exist for tools outside the project directory — that's fine
    console.log('   ℹ️  Skipped config/sections.json update (directory not found)');
  }

  return { sections, exploration, validation };
}
