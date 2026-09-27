/**
 * Navigation Agent
 *
 * Drives Playwright through the interactive tool for each section.
 * Unlike our previous html2canvas approach, this:
 *   1. Actually scrolls to show bottom content
 *   2. Waits for animations to complete
 *   3. Can interact with sliders, dropdowns, buttons in sequence
 *   4. Reports what's visible on screen for QA verification
 *
 * Each section has a navActions array that describes the steps:
 *   [
 *     { action: 'click_tab', target: 'iterative' },
 *     { action: 'click_selector', target: '#iter-algo-cards .algo-card:nth-child(2)' },
 *     { action: 'wait', ms: 500 },
 *     { action: 'scroll_to', target: '#chart-container' },
 *     { action: 'click_button', text: 'Auto Play' },
 *     { action: 'wait_for_animation', timeout: 5000 },
 *   ]
 */

export const NavActionTypes = {
  CLICK_TAB:          'click_tab',
  CLICK_SELECTOR:     'click_selector',
  CLICK_BUTTON:       'click_button',        // find by text content
  CLICK_NTH:          'click_nth',            // click nth match of selector
  SET_SLIDER:         'set_slider',
  SET_SELECT:         'set_select',
  SCROLL_TO:          'scroll_to',
  SCROLL_TOP:         'scroll_top',
  SCROLL_BOTTOM:      'scroll_bottom',
  WAIT:               'wait',
  WAIT_FOR_ANIMATION: 'wait_for_animation',  // waits until DOM stops changing
  WAIT_FOR_SELECTOR:  'wait_for_selector',
  MOVE_CURSOR_TO:     'move_cursor_to',      // move visual pointer to element
  GOTO_MODULE:        'goto_module',         // presentation mode: navigate to ?module=<id>
  STEP_THROUGH:       'step_through',        // click a button repeatedly until algo is done
  SET_PLAY_SPEED:     'set_play_speed',      // set animation speed (lower = slower)
  ZOOM_TO:            'zoom_to',             // zoom into a module so it fills the viewport
  RESET_ZOOM:         'reset_zoom',          // reset any active zoom before new section
};

/**
 * Inject the visual cursor/spotlight overlay into the page.
 * Call once before recording begins.
 */
export async function injectCursorOverlay(page) {
  await page.evaluate(() => {
    if (document.getElementById('_lecture_cursor')) return;

    const cursor = document.createElement('div');
    cursor.id = '_lecture_cursor';
    cursor.innerHTML = `
      <div id="_cursor_dot" style="
        width: 28px; height: 28px;
        background: radial-gradient(circle, rgba(255,80,80,0.95) 0%, rgba(255,80,80,0.6) 40%, transparent 70%);
        border-radius: 50%;
        position: absolute; top: -14px; left: -14px;
        pointer-events: none;
        filter: drop-shadow(0 0 6px rgba(255,80,80,0.5));
      "></div>
      <div id="_cursor_ring" style="
        width: 48px; height: 48px;
        border: 2px solid rgba(255,80,80,0.5);
        border-radius: 50%;
        position: absolute; top: -24px; left: -24px;
        pointer-events: none;
        animation: _cursor_pulse 1.5s ease-in-out infinite;
      "></div>
      <div id="_cursor_label" style="
        position: absolute; top: 20px; left: 16px;
        background: rgba(0,0,0,0.85);
        color: #fff;
        font-size: 12px; font-weight: 600;
        padding: 4px 10px;
        border-radius: 6px;
        pointer-events: none;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.3s;
        font-family: system-ui, sans-serif;
      "></div>
    `;
    cursor.style.cssText = `
      position: fixed; z-index: 999999;
      pointer-events: none;
      left: -100px; top: -100px;
      transition: left 0.6s cubic-bezier(0.25,0.1,0.25,1), top 0.6s cubic-bezier(0.25,0.1,0.25,1);
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes _cursor_pulse {
        0%, 100% { transform: scale(1); opacity: 0.5; }
        50% { transform: scale(1.3); opacity: 0.2; }
      }
    `;

    document.body.appendChild(style);
    document.body.appendChild(cursor);
  });
}

/**
 * Move the visual cursor to a target element.
 */
export async function moveCursorTo(page, selector, label = '') {
  const moved = await page.evaluate(({ sel, lbl }) => {
    const el = document.querySelector(sel)
      || (sel === '#ppoSvg' ? document.querySelector('#klPolicyBars') : null);
    if (!el) return false;

    const cursor = document.getElementById('_lecture_cursor');
    if (!cursor) return false;

    // Position cursor in a fixed empty corner of the viewport — NEVER near
    // the target element, to guarantee zero overlap with any content.
    // Top-right corner is consistently empty across all tool layouts.
    const vw = window.innerWidth;
    cursor.style.left = (vw - 120) + 'px';
    cursor.style.top = '30px';

    // Update label
    const labelEl = document.getElementById('_cursor_label');
    if (labelEl) {
      if (lbl) {
        labelEl.textContent = lbl;
        labelEl.style.opacity = '1';
      } else {
        labelEl.style.opacity = '0';
      }
    }

    return true;
  }, { sel: selector, lbl: label });

  // Wait for the CSS transition to complete
  await page.waitForTimeout(700);
  return moved;
}

/**
 * Hide the cursor (move offscreen).
 */
export async function hideCursor(page) {
  await page.evaluate(() => {
    const cursor = document.getElementById('_lecture_cursor');
    if (cursor) {
      cursor.style.left = '-100px';
      cursor.style.top = '-100px';
    }
    const label = document.getElementById('_cursor_label');
    if (label) label.style.opacity = '0';
  });
}

function normalizeUiText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function moveCursorToBox(page, box, label = '') {
  await page.evaluate(({ x, y, lbl }) => {
    const cursor = document.getElementById('_lecture_cursor');
    if (!cursor) return;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    const labelEl = document.getElementById('_cursor_label');
    if (labelEl) {
      if (lbl) {
        labelEl.textContent = lbl;
        labelEl.style.opacity = '1';
      } else {
        labelEl.style.opacity = '0';
      }
    }
  }, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    lbl: label
  }).catch(() => {});
  await page.waitForTimeout(700);
}

async function findClickableControl(page, text) {
  const target = normalizeUiText(text);
  if (!target) return null;

  const handle = await page.evaluateHandle((wanted) => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const labelOf = (el) => normalize(
      el.getAttribute('aria-label')
      || el.innerText
      || el.textContent
      || el.value
    );
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none';
    };

    const candidates = [...document.querySelectorAll('button, .btn, [role="button"], input[type="button"], input[type="submit"]')]
      .filter(isVisible);

    return candidates.find(el => labelOf(el) === wanted)
      || candidates.find(el => labelOf(el).includes(wanted) || wanted.includes(labelOf(el)))
      || null;
  }, target);

  return handle.asElement();
}

/**
 * Execute a sequence of navigation actions on a Playwright page.
 * Returns metadata about what happened (for QA verification).
 */
export async function executeNavActions(page, actions) {
  const results = [];

  for (const action of actions) {
    try {
      switch (action.action) {
        case NavActionTypes.CLICK_TAB: {
          const tabSel = `.tab[data-mod="${action.target}"]`;
          await moveCursorTo(page, tabSel, action.target).catch(() => {});
          await page.click(tabSel);
          await page.waitForTimeout(1200);  // allow tab panel + chart re-render to fully finish
          // Verify the click worked; retry once if the tab didn't change
          const activeAfter = await page.evaluate((target) => {
            const el = document.querySelector('.tab.active, .tab[aria-selected="true"]');
            return el?.getAttribute('data-mod') || null;
          }, action.target);
          if (activeAfter !== action.target) {
            await page.click(tabSel).catch(() => {});
            await page.waitForTimeout(1000);
          }
          results.push({ action: action.action, target: action.target, success: true });
          break;
        }

        case NavActionTypes.CLICK_SELECTOR: {
          await moveCursorTo(page, action.target, action.label || '').catch(() => {});
          await page.click(action.target);
          await page.waitForTimeout(200);
          results.push({ action: action.action, target: action.target, success: true });
          break;
        }

        case NavActionTypes.CLICK_BUTTON: {
          const btn = await findClickableControl(page, action.text);
          if (btn) {
            const btnBox = await btn.boundingBox();
            if (btnBox) {
              await moveCursorToBox(page, btnBox, action.text).catch(() => {});
            }
            await btn.click();
            // Pause after click so the button's active/pressed state appears in frames
            await page.waitForTimeout(300);
            results.push({ action: action.action, text: action.text, success: true });
          } else {
            // Try looser match among real controls only
            const allBtns = await page.$$('button, .btn, [role="button"], input[type="button"], input[type="submit"]');
            let found = false;
            for (const b of allBtns) {
              const text = normalizeUiText(
                (await b.getAttribute('aria-label'))
                || (await b.textContent())
                || (await b.getAttribute('value'))
              );
              if (text.includes(normalizeUiText(action.text))) {
                const box = await b.boundingBox();
                if (box) {
                  await moveCursorToBox(page, box, action.text).catch(() => {});
                }
                await b.click();
                await page.waitForTimeout(300);
                found = true;
                break;
              }
            }
            results.push({ action: action.action, text: action.text, success: found });
          }
          break;
        }

        case NavActionTypes.CLICK_NTH: {
          const elements = await page.$$(action.selector);
          if (elements[action.index]) {
            const nthBox = await elements[action.index].boundingBox();
            if (nthBox) {
              // Move cursor to center of nth element via DOM
              await page.evaluate(({ sel, idx }) => {
                const els = document.querySelectorAll(sel);
                const el = els[idx];
                if (!el) return;
                const rect = el.getBoundingClientRect();
                const cursor = document.getElementById('_lecture_cursor');
                if (cursor) {
                  cursor.style.left = (rect.left + rect.width / 2) + 'px';
                  cursor.style.top  = (rect.top  + rect.height / 2) + 'px';
                }
              }, { sel: action.selector, idx: action.index }).catch(() => {});
              await page.waitForTimeout(600);
            }
            await elements[action.index].click();
            results.push({ action: action.action, success: true });
          } else {
            results.push({ action: action.action, success: false, error: `Only ${elements.length} matches` });
          }
          await page.waitForTimeout(200);
          break;
        }

        case NavActionTypes.SET_SLIDER: {
          const specialSlider = await page.evaluate(({ selector, value }) => {
            const match = /^#ppoSvg-bar-(.+)$/.exec(selector || '');
            if (!match || typeof window.__setKLTokenWeight !== 'function') return { handled: false };
            return {
              handled: true,
              ...(window.__setKLTokenWeight(match[1], value) || { ok: false })
            };
          }, { selector: action.selector, value: action.value });

          if (specialSlider.handled) {
            await page.waitForTimeout(250);
            results.push({
              action: action.action,
              success: Boolean(specialSlider.ok),
              special: 'kl_token_weight',
              token: specialSlider.token
            });
            break;
          }

          const sliderResult = await page.evaluate(({ selector, value }) => {
            const el = document.querySelector(selector);
            if (!el) return { ok: false, reason: 'element not found' };
            if (!('value' in el)) return { ok: false, reason: 'element has no value property' };
            el.value = String(value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, valueAfter: el.value };
          }, { selector: action.selector, value: action.value });

          await page.waitForTimeout(250);
          results.push({
            action: action.action,
            success: Boolean(sliderResult.ok),
            reason: sliderResult.reason || null
          });
          break;
        }

        case NavActionTypes.SET_SELECT: {
          // Wait up to 5s for the option at the target index to exist.
          // Dynamic selects (e.g. #proof-select) are populated by JS after module init —
          // calling selectOption before options exist fails silently, leaving "-- select --".
          try {
            await page.waitForFunction(
              ([sel, idx]) => {
                const el = document.querySelector(sel);
                return el && el.options.length > idx;
              },
              [action.selector, action.index],
              { timeout: 5000 }
            );
          } catch (_) { /* fall through */ }
          // Use page.evaluate to directly set selectedIndex and fire change event.
          // page.selectOption + page.dispatchEvent was unreliable for inline onchange
          // handlers: the Playwright-issued event sometimes didn't trigger loadProof().
          // Direct DOM manipulation + new Event() is guaranteed to fire the handler.
          const selectResult = await page.evaluate(([sel, idx]) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, reason: 'element not found' };
            if (idx >= el.options.length) return { ok: false, reason: `only ${el.options.length} options, wanted idx ${idx}` };
            el.selectedIndex = idx;
            const valueBefore = el.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, value: el.options[idx]?.value, text: el.options[idx]?.text, valueAfter: el.value };
          }, [action.selector, action.index]);
          console.log(`   [SET_SELECT] ${action.selector}[${action.index}]: ${JSON.stringify(selectResult)}`);
          await page.waitForTimeout(600);
          results.push({ action: action.action, success: selectResult.ok, value: selectResult.value });
          break;
        }

        case NavActionTypes.SCROLL_TO: {
          await page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (el) {
              // Scroll element to the TOP of the viewport so the module fills the screen.
              // 'start' ensures maximum content visibility and readability at 1920x1080.
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              window.scrollBy(0, -20);  // small offset from top edge
            }
          }, action.target);
          await page.waitForTimeout(600);
          results.push({ action: action.action, target: action.target, success: true });
          break;
        }

        case NavActionTypes.SCROLL_TOP: {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
          await page.waitForTimeout(300);
          results.push({ action: action.action, success: true });
          break;
        }

        case NavActionTypes.SCROLL_BOTTOM: {
          await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
          await page.waitForTimeout(500);
          results.push({ action: action.action, success: true });
          break;
        }

        case NavActionTypes.ZOOM_TO: {
          // Two modes:
          //   A) THEORY MODULES (#theory-*): Hide siblings, center, zoom up
          //   B) INTERACTIVE TABS (.wrap, SVGs, panels): NO zoom, just scroll to top
          //      Interactive tools must ALWAYS show the COMPLETE tool at 1x scale.
          //      NEVER zoom into a fragment of an interactive tool.
          const zoomResult = await page.evaluate(({ selector }) => {
            const syncSubtitleScale = (scale = 1) => {
              if (typeof window.__lectureSetSubtitleScale === 'function') {
                window.__lectureSetSubtitleScale(scale);
              }
            };

            const cleanupTempWrappers = () => {
              document.querySelectorAll('[data-zoom-temp-wrapper]').forEach(wrapper => {
                const parent = wrapper.parentNode;
                if (!parent) return;
                while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
                wrapper.remove();
              });
            };

            const hideNode = (node) => {
              if (!node || node.id === '_lecture_cursor' || node.id === '_lecture_subtitle') return;
              node.style.display = 'none';
              node.setAttribute('data-zoom-hidden', 'true');
            };

            const scaleAndCenter = (node) => {
              const rect = node.getBoundingClientRect();
              const sH = (window.innerHeight * 0.82) / Math.max(rect.height, 1);
              const sW = (window.innerWidth * 0.92) / Math.max(rect.width, 1);
              let scale = Math.min(sH, sW);
              scale = Math.max(1.0, Math.min(scale, 4.0));
              if (scale > 1.05) {
                document.documentElement.style.zoom = `${scale}`;
                syncSubtitleScale(scale);
              } else {
                syncSubtitleScale(1);
              }
              node.scrollIntoView({ block: 'center' });
              return scale;
            };

            const el = document.querySelector(selector);
            if (!el) return { success: false, reason: 'element not found: ' + selector };

            // Reset any previous zoom/hiding
            document.documentElement.style.zoom = '1';
            syncSubtitleScale(1);
            cleanupTempWrappers();
            document.querySelectorAll('[data-zoom-hidden]').forEach(h => {
              h.style.display = '';
              h.removeAttribute('data-zoom-hidden');
            });
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

            // Determine if this is a theory module or an interactive tab element
            const isTheoryTarget = el.closest('.theory-module') || el.classList.contains('theory-module')
              || el.id?.startsWith('theory-')
              || el.closest('.intro-body') || el.closest('.intro-section')
              || el.id?.startsWith('intro-');

            if (isTheoryTarget) {
              // ═══ MODE A: THEORY MODULE — isolate, center, zoom ═══
              let targetModule = el.closest('.theory-module') || el;

              // For single-page lecture notes, a section heading should bring
              // along the short explanatory content immediately below it.
              if (!el.closest('.theory-module') && /^H[23]$/.test(el.tagName) && el.closest('.intro-body, #appendixBody')) {
                const wrapper = document.createElement('div');
                wrapper.setAttribute('data-zoom-temp-wrapper', 'true');
                wrapper.style.display = 'block';

                const parent = el.parentNode;
                parent.insertBefore(wrapper, el);
                wrapper.appendChild(el);

                let sibling = wrapper.nextSibling;
                while (sibling) {
                  const next = sibling.nextSibling;
                  if (sibling.nodeType === 1 && /^H[23]$/.test(sibling.tagName)) break;
                  if (sibling.nodeType === 1) wrapper.appendChild(sibling);
                  sibling = next;
                  // Stop once we have brought in a substantial first block.
                  if (wrapper.querySelector('.key-concept, .warning-box, .example-box, .code-block, table')) break;
                }
                targetModule = wrapper;
              }

              // Expand theory section (it may have been collapsed by the recorder)
              const introBody = document.getElementById('introBody');
              if (introBody) introBody.classList.remove('collapsed');

              // For ordinary theory blocks, isolate the specific top-level note box
              // so the video does not drift back to unrelated earlier notes.
              const theoryBodyRoot = targetModule.closest('.intro-body, #appendixBody');
              if (theoryBodyRoot && !targetModule.closest('[data-zoom-temp-wrapper]')) {
                Array.from(theoryBodyRoot.children).forEach(child => {
                  if (child === targetModule || child.contains(targetModule) || targetModule.contains(child)) return;
                  hideNode(child);
                });
              }

              // Hide other theory modules
              document.querySelectorAll('.theory-module').forEach(m => {
                if (m !== targetModule) {
                  m.style.display = 'none';
                  m.setAttribute('data-zoom-hidden', 'true');
                }
              });

              // Hide the interactive area and page chrome
              const wrap = document.querySelector('.wrap');
              const h1 = document.querySelector('h1');
              const subtitle = document.querySelector('.subtitle');
              const introHeader = document.querySelector('.intro-header');
              if (wrap) { wrap.style.display = 'none'; wrap.setAttribute('data-zoom-hidden', 'true'); }
              if (h1) { h1.style.display = 'none'; h1.setAttribute('data-zoom-hidden', 'true'); }
              if (subtitle) { subtitle.style.display = 'none'; subtitle.setAttribute('data-zoom-hidden', 'true'); }
              if (introHeader) { introHeader.style.display = 'none'; introHeader.setAttribute('data-zoom-hidden', 'true'); }

              // Center vertically
              const theoryBody = targetModule.closest('.intro-body, #appendixBody');
              if (theoryBody) {
                theoryBody.style.display = 'flex';
                theoryBody.style.flexDirection = 'column';
                theoryBody.style.justifyContent = 'center';
                theoryBody.style.alignItems = 'stretch';
                theoryBody.style.minHeight = '95vh';
                theoryBody.style.padding = '20px 40px';
                theoryBody.setAttribute('data-zoom-scaled', 'true');
              }

              // Boost font size for small theory modules before measuring
              const origFontSize = targetModule.style.fontSize;
              targetModule.style.fontSize = '22px';
              targetModule.style.lineHeight = '1.8';
              targetModule.querySelectorAll('p').forEach(p => { p.style.fontSize = '20px'; p.style.lineHeight = '1.8'; });
              targetModule.querySelectorAll('h3').forEach(h => { h.style.fontSize = '28px'; h.style.marginBottom = '16px'; });
              targetModule.querySelectorAll('.math-inline').forEach(m => { m.style.fontSize = '20px'; });

              const scale = scaleAndCenter(targetModule);
              return { success: true, scale, mode: 'theory' };

            } else {
              // ═══ MODE B: INTERACTIVE TOOL / MODULE ─═══════════════════════
              document.documentElement.style.zoom = '1';
              syncSubtitleScale(1);
              document.querySelectorAll('[data-zoom-hidden]').forEach(h => {
                h.style.display = '';
                h.removeAttribute('data-zoom-hidden');
              });
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
              // Restore any theory-module elements hidden by Mode A
              document.querySelectorAll('.theory-module').forEach(m => {
                m.style.display = '';
                m.style.fontSize = '';
                m.style.lineHeight = '';
                m.querySelectorAll('p,h3,.math-inline').forEach(el => {
                  el.style.fontSize = '';
                  el.style.lineHeight = '';
                  el.style.marginBottom = '';
                });
              });
              // Make sure wrap is visible
              const wrap = document.querySelector('.wrap');
              if (wrap) wrap.style.display = '';

              // Make sure the theory section is collapsed
              const introBody = document.getElementById('introBody');
              if (introBody && !introBody.classList.contains('collapsed')) {
                introBody.classList.add('collapsed');
              }

              // Show the whole tool only if explicitly requested.
              if (selector === '.wrap' || el === wrap) {
                hideNode(document.querySelector('h1'));
                hideNode(document.querySelector('.subtitle'));
                hideNode(document.querySelector('.tut-footer'));
                document.querySelectorAll('body > .intro-section').forEach(hideNode);
                if (wrap) {
                  wrap.style.display = 'grid';
                  wrap.style.width = 'calc(100vw - 48px)';
                  wrap.style.maxWidth = '1760px';
                  wrap.style.margin = '18px auto';
                  wrap.style.minHeight = '92vh';
                  wrap.setAttribute('data-zoom-scaled', 'true');
                }
                window.scrollTo({ top: 0, behavior: 'instant' });
                return { success: true, scale: 1.0, mode: 'interactive-full' };
              }

              // Single-module focus inside the tool: keep only the relevant card
              // and the specific control/visual block being taught.
              let targetModule =
                el.closest('.mb10, .row, .preset-row, .btnRow, .controls, .hint, .algoOverview, .phase-bar, #vizArea, #resultBar, #pseudocode, #codeHelp, table, .mono')
                || el;

              const card = targetModule.closest('.card');
              hideNode(document.querySelector('h1'));
              hideNode(document.querySelector('.subtitle'));
              document.querySelectorAll('body > .intro-section').forEach(hideNode);

              if (wrap) {
                wrap.style.display = 'grid';
              }
              hideNode(document.querySelector('.tut-footer'));

              document.querySelectorAll('.wrap > .card').forEach(c => {
                if (card && c !== card) hideNode(c);
              });

              if (card) {
                Array.from(card.children).forEach(child => {
                  if (child === targetModule || child.contains(targetModule) || child.tagName === 'H2') return;
                  hideNode(child);
                });
              }

              const scale = scaleAndCenter(targetModule);
              return { success: true, scale, mode: 'interactive-module' };
            }
          }, { selector: action.target });

          await page.waitForTimeout(500);
          results.push({ action: action.action, target: action.target, success: zoomResult.success, scale: zoomResult.scale });
          break;
        }

        case NavActionTypes.RESET_ZOOM: {
          // Reset any active zoom: CSS zoom, transform scale, and hidden siblings
          await page.evaluate(() => {
            document.documentElement.style.zoom = '1';
            if (typeof window.__lectureSetSubtitleScale === 'function') {
              window.__lectureSetSubtitleScale(1);
            }
            document.querySelectorAll('[data-zoom-temp-wrapper]').forEach(wrapper => {
              const parent = wrapper.parentNode;
              if (!parent) return;
              while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
              wrapper.remove();
            });
            document.querySelectorAll('[data-zoom-hidden]').forEach(h => {
              h.style.display = '';
              h.removeAttribute('data-zoom-hidden');
            });
            document.querySelectorAll('[data-zoom-scaled]').forEach(s => {
              s.style.transform = '';
              s.style.transformOrigin = '';
              s.removeAttribute('data-zoom-scaled');
            });
          });
          await page.waitForTimeout(200);
          results.push({ action: action.action, success: true });
          break;
        }

        case NavActionTypes.WAIT: {
          await page.waitForTimeout(action.ms || 500);
          results.push({ action: action.action, ms: action.ms, success: true });
          break;
        }

        case NavActionTypes.WAIT_FOR_ANIMATION: {
          // Wait until the DOM stops changing (animation complete)
          const timeout = action.timeout || 5000;
          const startTime = Date.now();
          let lastHTML = await page.content();
          let stable = 0;

          while (Date.now() - startTime < timeout) {
            await page.waitForTimeout(200);
            const currentHTML = await page.content();
            if (currentHTML === lastHTML) {
              stable++;
              if (stable >= 3) break; // 3 consecutive stable checks = animation done
            } else {
              stable = 0;
              lastHTML = currentHTML;
            }
          }
          results.push({
            action: action.action,
            animationCompleted: stable >= 3,
            elapsed: Date.now() - startTime
          });
          break;
        }

        case NavActionTypes.WAIT_FOR_SELECTOR: {
          try {
            await page.waitForSelector(action.selector, { timeout: action.timeout || 5000 });
            results.push({ action: action.action, success: true });
          } catch {
            results.push({ action: action.action, success: false, error: 'timeout' });
          }
          break;
        }

        case 'scroll_panel': {
          // Scroll the right panel to show content below the chart
          await page.evaluate((sel) => {
            const panel = document.querySelector(sel || '.panel:last-child');
            if (panel) {
              panel.scrollTo({ top: action.position === 'bottom' ? panel.scrollHeight : 0, behavior: 'smooth' });
            }
          }, action.target || '.panel:last-child');
          await page.waitForTimeout(500);
          results.push({ action: action.action, success: true });
          break;
        }

        case NavActionTypes.MOVE_CURSOR_TO: {
          const moved = await moveCursorTo(page, action.target, action.label || '');
          results.push({ action: action.action, target: action.target, success: moved });
          break;
        }

        case NavActionTypes.SET_PLAY_SPEED: {
          // Set the tool's animation speed variable (lower = slower, default is 1)
          const speed = action.speed || 0.3;
          await page.evaluate((s) => { if (typeof speedVal !== 'undefined') speedVal = s; }, speed);
          results.push({ action: action.action, speed, success: true });
          break;
        }

        case NavActionTypes.STEP_THROUGH: {
          // Click step button repeatedly, VERIFYING each step advances, until algorithm is done.
          // Reads stepCount ("X / Y") before and after to confirm progress.
          const stepSel = action.target || '#step';
          const pauseMs = action.pauseMs || 2500;
          let clicks = 0;
          let stalled = 0;

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
              stepCount: stepText,
              current,
              total,
              done
            };
          });

          const initialState = await readStepState();
          const hardCap = Math.max(
            action.maxClicks || 0,
            Number.isFinite(initialState.total) ? initialState.total + 3 : 0,
            40
          );

          for (let i = 0; i < hardCap; i++) {
            const state = await readStepState();
            if (state.done) break;

            // Get current step index before clicking
            const beforeStep = state.stepCount;
            const beforeCurrent = state.current;

            // Click the Step button
            await page.click(stepSel).catch(() => {});
            await page.waitForTimeout(400); // let rendering finish

            // Verify step actually advanced
            let afterState = await readStepState();
            const advanced = afterState.stepCount !== beforeStep
              || (
                Number.isFinite(beforeCurrent)
                && Number.isFinite(afterState.current)
                && afterState.current > beforeCurrent
              );

            if (!advanced && !afterState.done) {
              // Step didn't advance — might need Build first, or wrong button
              console.log(`   ⚠️  Step didn't advance (${beforeStep}). Trying Build first...`);
              await page.click('#build').catch(() => {});
              await page.waitForTimeout(500);
              await page.click(stepSel).catch(() => {});
              await page.waitForTimeout(400);
              afterState = await readStepState();
              const recovered = afterState.stepCount !== beforeStep
                || (
                  Number.isFinite(beforeCurrent)
                  && Number.isFinite(afterState.current)
                  && afterState.current > beforeCurrent
                )
                || afterState.done;
              if (!recovered) {
                stalled++;
              } else {
                clicks++;
                stalled = 0;
              }
              if (stalled > 3) {
                console.log(`   ❌ Step stuck after ${stalled} retries. Aborting step_through.`);
                break;
              }
            } else {
              clicks++;
              stalled = 0;
            }

            // Wait between steps for student to see the change
            await page.waitForTimeout(pauseMs);
          }
          results.push({ action: action.action, target: stepSel, clicks, success: clicks > 0 });
          break;
        }

        case NavActionTypes.GOTO_MODULE: {
          // Presentation mode: navigate to ?module=<id>
          const currentUrl = new URL(page.url());
          currentUrl.searchParams.set('module', action.target);
          await page.goto(currentUrl.toString(), { waitUntil: 'networkidle' });
          await page.waitForTimeout(600);
          // Re-inject cursor overlay (page was reloaded)
          await injectCursorOverlay(page);
          results.push({ action: action.action, target: action.target, success: true });
          break;
        }

        default:
          results.push({ action: action.action, success: false, error: 'Unknown action type' });
      }
    } catch (err) {
      results.push({ action: action.action, success: false, error: err.message });
    }
  }

  return results;
}

/**
 * Capture what's currently visible on the page — for QA verification.
 */
export async function captureVisibleState(page) {
  return await page.evaluate(() => {
    const viewport = {
      scrollTop: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    };

    // What tabs/cards are active
    const activeTab = document.querySelector('.tab.active, .tab[aria-selected="true"]');
    const activeCards = [...document.querySelectorAll('.active, [aria-selected="true"]')]
      .map(el => el.textContent?.substring(0, 50));

    // Are there visible charts/graphs
    const charts = document.querySelectorAll('canvas, svg, .chart');
    const visibleCharts = [...charts].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });

    // Check for formulas / math content
    const mathElements = document.querySelectorAll('.formula, .math, mjx-container, .katex');

    return {
      viewport,
      activeTab: activeTab?.textContent?.trim(),
      activeElements: activeCards,
      visibleChartCount: visibleCharts.length,
      totalChartCount: charts.length,
      mathElementCount: mathElements.length,
      visibleMathCount: [...mathElements].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.top < window.innerHeight && rect.bottom > 0;
      }).length
    };
  });
}
