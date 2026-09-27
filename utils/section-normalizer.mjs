const STATE_CHANGING_ACTIONS = new Set([
  'click_button',
  'click_selector',
  'click_nth',
  'set_select',
  'set_slider',
  'step_through'
]);

const BROAD_TARGET_PATTERNS = [
  /^\s*\.intro-section\s*$/,
  /^\s*\.intro-card\s*$/,
  /^\s*\.wrap\s*$/,
  /^\s*\.card\s*$/,
  /^\s*body\s*$/,
  /^\s*main\s*$/
];

const THEORY_HINTS = [
  'intro',
  'appendix',
  '#sec',
  'key-concept',
  'warning-box',
  'example-box',
  'code-block',
  'mini-table'
];

const MOTION_HINTS = [
  '#vizarea',
  '#phasebar',
  '#resultbar',
  '#pseudocode',
  '#codehelp',
  'svg',
  'canvas'
];

const COVERAGE_STOPWORDS = new Set([
  'approximation',
  'algorithm',
  'based',
  'greedy',
  'interactive',
  'overview',
  'visualization'
]);

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(token => token.length >= 3);
}

function splitSentences(text) {
  const raw = String(text || '').match(/[^.!?]*[.!?]+["']?/g) || [String(text || '').trim()];
  return raw.map(s => s.trim()).filter(Boolean);
}

function shortenNarration(text, maxSentences = 2) {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return text;
  return sentences.slice(0, maxSentences).join(' ').trim();
}

function collectSectionText(section) {
  const navText = (section.navActions || []).flatMap(action => [
    action?.target,
    action?.text,
    action?.label
  ]).filter(Boolean);

  return [
    section.id,
    section.group,
    section.narration,
    ...(section.expectedElements || []),
    section.focusTarget,
    ...navText
  ].join(' ');
}

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function collectSectionPhrases(section) {
  return [
    String(section.id || '').replace(/^\d+_/, '').replace(/_/g, ' '),
    ...(section.navActions || []).flatMap(action => [action?.label, action?.text]).filter(Boolean)
  ]
    .map(normalizePhrase)
    .filter(Boolean);
}

function scoreModule(section, module) {
  const sectionTokens = new Set(tokenize(collectSectionText(section)));

  const moduleTokens = new Set(tokenize([
    module.selector,
    module.title,
    module.textExcerpt,
    module.region,
    module.kind
  ].join(' ')));

  let score = 0;
  for (const token of sectionTokens) {
    if (moduleTokens.has(token)) score += 2;
  }

  const sectionText = collectSectionText(section).toLowerCase();
  const moduleTitle = normalizePhrase(module.title);
  for (const phrase of collectSectionPhrases(section)) {
    if (phrase.length >= 10 && moduleTitle && (moduleTitle.includes(phrase) || phrase.includes(moduleTitle))) {
      score += 8;
    }
  }

  if (sectionText.includes('appendix') && module.region === 'appendix') score += 4;
  if (sectionText.includes('intro') && module.region === 'intro') score += 4;
  if ((sectionText.includes('start here') || /\b01[_\s-]*intro\b/i.test(section.id || '')) && module.kind === 'roadmap') score += 12;
  if ((sectionText.includes('algo') || sectionText.includes('speed') || sectionText.includes('preset') || sectionText.includes('play')) && module.region === 'interactive') score += 3;
  if ((sectionText.includes('visual') || sectionText.includes('graph') || sectionText.includes('tour') || sectionText.includes('cover')) && module.preferMotion) score += 3;

  return score;
}

function isBroadTarget(selector) {
  const text = String(selector || '').trim();
  return BROAD_TARGET_PATTERNS.some(pattern => pattern.test(text));
}

function selectorNeedsStabilization(selector) {
  const text = String(selector || '').trim();
  if (!text) return false;
  if (isBroadTarget(text)) return true;
  if (/:(nth|first|last|eq|has)\b/i.test(text)) return true;
  if (/[+~]/.test(text)) return true;
  if ((text.match(/>/g) || []).length >= 2) return true;
  if ((text.match(/[.#][A-Za-z0-9_-]+/g) || []).length >= 3) return true;
  if (/^#[A-Za-z0-9_-]+$/.test(text)) return false;
  if (/^\.[A-Za-z0-9_-]+$/.test(text)) return false;
  return false;
}

function extractHeadingSelector(section) {
  const texts = [
    section.focusTarget,
    ...(section.expectedElements || []),
    ...(section.navActions || []).flatMap(action => [action?.target, action?.label]).filter(Boolean)
  ];

  for (const text of texts) {
    const match = String(text || '').match(/#sec\d+/i);
    if (match) return match[0];
  }

  return null;
}

function modulesWithinHeading(modules, headingSelector) {
  if (!headingSelector) return modules;
  const startIndex = modules.findIndex(module => module.selector === headingSelector);
  if (startIndex === -1) return modules;

  let endIndex = modules.length;
  for (let i = startIndex + 1; i < modules.length; i++) {
    const module = modules[i];
    if (module.kind === 'heading' && /^#sec\d+$/i.test(module.selector || '')) {
      endIndex = i;
      break;
    }
  }

  return modules.slice(startIndex, endIndex);
}

function hasStateChange(section) {
  return (section.navActions || []).some(action => STATE_CHANGING_ACTIONS.has(action.action));
}

function hasAnimationSequence(section) {
  return (section.navActions || []).some(action => {
    if (action.action === 'step_through' || action.action === 'wait_for_animation') return true;
    if (action.action !== 'click_button') return false;
    return /\b(play|auto play|animate|run all|play through)\b/i.test(action.text || '');
  });
}

function isInteractiveVisualTarget(selector) {
  const lower = String(selector || '').toLowerCase();
  return MOTION_HINTS.some(hint => lower.includes(hint));
}

function isPlaybackButtonText(text, controls) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return false;
  return [
    controls.buildButton,
    controls.stepButton,
    controls.playButton,
    controls.pauseButton,
    controls.resetButton
  ]
    .filter(Boolean)
    .map(value => String(value).trim().toLowerCase())
    .includes(lower);
}

function isCollapsibleButtonText(text) {
  return /\bcollapse\b|\bexpand\b/i.test(String(text || ''));
}

function findFirstAction(actions, name) {
  return (actions || []).find(action => action.action === name) || null;
}

function insertBeforePointer(actions, injected) {
  const idx = (actions || []).findIndex(action => action.action === 'move_cursor_to');
  if (idx === -1) return [...actions, ...injected];
  return [
    ...actions.slice(0, idx),
    ...injected,
    ...actions.slice(idx)
  ];
}

export function buildModuleCatalog(exploration) {
  return Array.isArray(exploration?.modules) ? exploration.modules : [];
}

function buildControlsFromTabContents(tabContents) {
  const selectStateMap = new Map();

  for (const tc of tabContents) {
    for (const selectState of tc.content?.selectStates || []) {
      const existing = selectStateMap.get(selectState.id) || { id: selectState.id, states: [] };
      for (const state of selectState.states || []) {
        const key = `${state.id}:${state.index}:${String(state.optionText || '').toLowerCase()}`;
        if (existing.states.some(entry => `${entry.id}:${entry.index}:${String(entry.optionText || '').toLowerCase()}` === key)) continue;
        existing.states.push({
          ...state,
          buttons: uniqueBy(state.buttons || [], button => String(button.text || '').toLowerCase())
        });
      }
      selectStateMap.set(selectState.id, existing);
    }
  }

  const selectStates = [...selectStateMap.values()];
  const buttons = uniqueBy(
    [
      ...tabContents.flatMap(tc => tc.content?.buttons || []).map(button => button?.text).filter(Boolean),
      ...selectStates.flatMap(sel => sel.states || []).flatMap(state => state.buttons || []).map(button => button?.text).filter(Boolean)
    ],
    text => text.toLowerCase()
  );
  const selects = uniqueBy(
    tabContents.flatMap(tc => tc.content?.selects || []).filter(sel => sel?.id),
    sel => sel.id
  );
  const sliders = uniqueBy(
    tabContents.flatMap(tc => tc.content?.sliders || []).filter(slider => slider?.id),
    slider => slider.id
  );

  const lowerButtons = buttons.map(text => ({ text, lower: text.toLowerCase() }));
  const findButton = (regex) => lowerButtons.find(entry => regex.test(entry.lower))?.text || null;

  return {
    buttons,
    selects,
    sliders,
    selectStates,
    buildButton: findButton(/\bbuild\b/),
    stepButton: findButton(/^step\b|next step|advance/),
    playButton: findButton(/\bauto play\b|\bplay\b/),
    pauseButton: findButton(/\bpause\b/),
    resetButton: findButton(/\breset\b|\brestart\b|\bclear\b/),
    presetButtons: buttons.filter(text => !/\b(build|step|play|pause|reset|restart|clear)\b/i.test(text) && !isCollapsibleButtonText(text))
  };
}

export function discoverInteractiveControls(exploration) {
  const tabContents = exploration?.tabContents || [];
  const globalControls = buildControlsFromTabContents(tabContents);
  const byTab = Object.fromEntries(
    tabContents
      .filter(tc => tc?.tab?.dataMod)
      .map(tc => [tc.tab.dataMod, buildControlsFromTabContents([tc])])
  );

  return {
    ...globalControls,
    byTab
  };
}

function controlsForSection(section, controls) {
  const tabTarget = (section?.navActions || []).find(action => action.action === 'click_tab')?.target;
  if (tabTarget && controls?.byTab?.[tabTarget]) return controls.byTab[tabTarget];
  return controls;
}

export function sectionAllowsInteractiveModuleFocus(section) {
  const focusSelectors = [
    section.focusTarget,
    findFirstAction(section.navActions, 'zoom_to')?.target,
    findFirstAction(section.navActions, 'move_cursor_to')?.target
  ].filter(Boolean);

  if (focusSelectors.some(selector => THEORY_HINTS.some(hint => selector.includes(hint)))) {
    return false;
  }

  if (focusSelectors.some(selector => isBroadTarget(selector))) {
    return false;
  }

  return focusSelectors.some(selector => {
    const lower = selector.toLowerCase();
    return MOTION_HINTS.some(hint => lower.includes(hint))
      || lower.includes('#algo')
      || lower.includes('#speed')
      || lower.includes('preset')
      || lower.includes('btnrow');
  });
}

export function sectionIsTheoryModule(section) {
  const focusSelectors = [
    section.focusTarget,
    findFirstAction(section.navActions, 'zoom_to')?.target,
    findFirstAction(section.navActions, 'move_cursor_to')?.target
  ].filter(Boolean);

  if (!focusSelectors.length) return false;
  return focusSelectors.some(selector => THEORY_HINTS.some(hint => selector.includes(hint)));
}

function chooseFocusTarget(section, modules) {
  const current = section.focusTarget || findFirstAction(section.navActions, 'zoom_to')?.target;
  if (current && modules.some(module => module.selector === current)) return current;

  if (!modules.length) return current || null;

  if (/^#introBody\s*>\s*div:first-child$/i.test(String(current || '').trim())) {
    const roadmap = modules.find(module => module.region === 'intro' && module.kind === 'roadmap');
    if (roadmap) return roadmap.selector;
  }

  const headingSelector = extractHeadingSelector(section);
  const candidateModules = modulesWithinHeading(modules, headingSelector);

  const ranked = candidateModules
    .map(module => ({ module, score: scoreModule(section, module) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || null;
  if (!best || best.score <= 0) return current || null;

  if (!current || isBroadTarget(current)) {
    return best.module.selector;
  }

  if (selectorNeedsStabilization(current) && best.score >= 4) {
    return best.module.selector;
  }

  return current;
}

function requiresMotion(section, focusTarget, modules) {
  if (!focusTarget) return false;
  const lower = focusTarget.toLowerCase();
  if (MOTION_HINTS.some(hint => lower.includes(hint))) return true;
  const module = modules.find(entry => entry.selector === focusTarget);
  return Boolean(module?.preferMotion);
}

function inferTeachingMode(section, focusTarget, controls) {
  const id = String(section.id || '').toLowerCase();
  const text = collectSectionText(section).toLowerCase();
  const focus = String(focusTarget || '').toLowerCase();
  const hasSelectorOrSlider = (section.navActions || []).some(action =>
    action.action === 'click_selector' ||
    action.action === 'click_nth' ||
    action.action === 'set_slider'
  );

  if (id.includes('pause_play_reset') || id.includes('speed_slider')) return 'control';
  if (focus.includes('#algo') || focus.includes('#speed') || focus.includes('.btnrow') || focus.includes('#algooverview') || focus.includes('#pseudocode') || focus.includes('#codehelp')) {
    return 'control';
  }
  if (id.includes('preset') || id.includes('example') || id.includes('graph')) return 'autoplay';
  if (id.includes('build_steps')) return 'build';
  if (id.includes('_step_') || /^step_/.test(id) || id.endsWith('_steps') || text.includes('step by step')) return 'step';
  const hasPresetClick = (section.navActions || []).some(action =>
    action.action === 'click_button' && !isPlaybackButtonText(action.text, controls) && !isCollapsibleButtonText(action.text)
  );
  if (hasPresetClick && isInteractiveVisualTarget(focusTarget)) return 'autoplay';
  if (hasSelectorOrSlider && isInteractiveVisualTarget(focusTarget)) return 'none';
  if (isInteractiveVisualTarget(focusTarget) && /\b(demo|simulation|experiment|guided|frontier|training)\b/.test(id.replace(/_/g, ' '))) {
    return 'autoplay';
  }
  return 'none';
}

function stripPlaybackActions(actions, controls) {
  return (actions || []).filter(action => {
    if (action.action === 'wait_for_animation' || action.action === 'step_through') return false;
    if (action.action === 'click_button' && isPlaybackButtonText(action.text, controls)) return false;
    return true;
  });
}

function injectMotionActions(actions, controls, mode) {
  const baseActions = stripPlaybackActions(actions, controls);
  const injected = [];

  if (mode === 'build') {
    if (controls.buildButton) {
      injected.push({ action: 'click_button', text: controls.buildButton });
      injected.push({ action: 'wait', ms: 500 });
    }
    injected.push({ action: 'wait', ms: 600 });
  } else if (mode === 'step') {
    if (controls.resetButton) {
      injected.push({ action: 'click_button', text: controls.resetButton });
      injected.push({ action: 'wait', ms: 350 });
    }
    if (controls.buildButton) {
      injected.push({ action: 'click_button', text: controls.buildButton });
      injected.push({ action: 'wait', ms: 500 });
    }
    if (controls.stepButton) {
      injected.push({ action: 'step_through', target: '#step', pauseMs: 1500 });
    } else if (controls.playButton) {
      injected.push({ action: 'click_button', text: controls.playButton });
      injected.push({ action: 'wait_for_animation', timeout: 8000 });
    }
    injected.push({ action: 'wait', ms: 700 });
  } else {
    if (controls.buildButton) {
      injected.push({ action: 'click_button', text: controls.buildButton });
      injected.push({ action: 'wait', ms: 500 });
    }
    if (controls.playButton) {
      injected.push({ action: 'click_button', text: controls.playButton });
      injected.push({ action: 'wait_for_animation', timeout: 8000 });
    } else if (controls.stepButton) {
      injected.push({ action: 'step_through', target: '#step', pauseMs: 1200 });
    }
    injected.push({ action: 'wait', ms: 800 });
  }

  if (!injected.length) return baseActions;
  return insertBeforePointer(baseActions, injected);
}

function ensureModuleFocus(actions, focusTarget, zoomTarget = focusTarget) {
  const next = (actions || []).map(action => ({ ...action }));
  let hasZoom = false;
  let hasPointer = false;

  for (const action of next) {
    if (action.action === 'zoom_to') {
      action.target = zoomTarget;
      hasZoom = true;
    }
    if (action.action === 'move_cursor_to') {
      action.target = focusTarget;
      hasPointer = true;
    }
  }

  if (!hasZoom && zoomTarget) {
    next.unshift({ action: 'zoom_to', target: zoomTarget });
    next.splice(1, 0, { action: 'wait', ms: 400 });
  }

  if (!hasPointer && focusTarget) {
    next.push({ action: 'move_cursor_to', target: focusTarget, label: 'module focus' });
  }

  return next;
}

function optionKeywords(optionText) {
  return tokenize(optionText).filter(token => !COVERAGE_STOPWORDS.has(token));
}

function sectionMatchesOption(section, state) {
  const text = collectSectionText(section).toLowerCase();
  const textTokens = new Set(tokenize(text));
  const focus = String(section.focusTarget || '').toLowerCase();
  const isInteractive = isInteractiveVisualTarget(focus)
    || focus.includes('#algo')
    || focus.includes('#speed')
    || focus.includes('.btnrow')
    || focus.includes('#algooverview')
    || (section.navActions || []).some(action => action.action === 'set_select' || action.action === 'set_slider' || action.action === 'click_button');

  if (!isInteractive) return false;

  if ((section.navActions || []).some(action =>
    action.action === 'set_select' &&
    (action.selector === `#${state.id}` || action.selector === state.id) &&
    Number(action.index) === Number(state.index)
  )) {
    return true;
  }

  const keywords = optionKeywords(state.optionText);
  if (!keywords.length) return false;
  const hits = keywords.filter(keyword => textTokens.has(keyword)).length;
  return hits >= Math.min(2, keywords.length);
}

function scoreStateMatch(section, state) {
  const textTokens = new Set(tokenize(collectSectionText(section)));
  let score = 0;

  if ((section.navActions || []).some(action =>
    action.action === 'set_select' &&
    (action.selector === `#${state.id}` || action.selector === state.id) &&
    Number(action.index) === Number(state.index)
  )) {
    score += 50;
  }

  const optionTokens = optionKeywords(state.optionText);
  score += optionTokens.filter(token => textTokens.has(token)).length * 6;

  if (sectionMatchesOption(section, state)) score += 20;
  return score;
}

function meaningfulStateButtons(state, controls) {
  return uniqueBy(
    (state.buttons || [])
      .map(button => button?.text)
      .filter(Boolean)
      .filter(text => !isPlaybackButtonText(text, controls) && !isCollapsibleButtonText(text)),
    text => text.toLowerCase()
  );
}

function chooseMatchingState(section, controls) {
  let bestState = null;
  let bestScore = 0;
  const sectionText = normalizePhrase(collectSectionText(section));

  for (const selectState of controls.selectStates || []) {
    for (const state of selectState.states || []) {
      let score = scoreStateMatch(section, state);
      for (const button of meaningfulStateButtons(state, controls)) {
        const normalizedButton = normalizePhrase(button);
        if (normalizedButton && sectionText.includes(normalizedButton)) {
          score += 24;
        }
      }
      if (score > bestScore) {
        bestState = state;
        bestScore = score;
      }
    }
  }

  return bestState;
}

function choosePresetButton(section, state, controls) {
  const buttons = meaningfulStateButtons(state, controls);
  if (!buttons.length) return null;

  const existing = (section.navActions || [])
    .filter(action => action.action === 'click_button')
    .map(action => String(action.text || '').trim().toLowerCase());
  const alreadyChosen = buttons.find(button => existing.includes(button.trim().toLowerCase()));
  if (alreadyChosen) return null;

  const textTokens = new Set(tokenize(collectSectionText(section)));
  let bestButton = null;
  let bestScore = 0;

  for (const button of buttons) {
    const score = tokenize(button).filter(token => textTokens.has(token)).length;
    if (score > bestScore) {
      bestButton = button;
      bestScore = score;
    }
  }

  if (bestButton) return bestButton;
  return buttons.find(button => /\b(path|default|example|small|simple|intro)\b/i.test(button)) || buttons[0];
}

function insertBeforePlayback(actions, injected, controls) {
  const idx = (actions || []).findIndex(action =>
    action.action === 'step_through' ||
    action.action === 'wait_for_animation' ||
    (action.action === 'click_button' && isPlaybackButtonText(action.text, controls))
  );

  if (idx === -1) return [...injected, ...(actions || [])];
  return [
    ...actions.slice(0, idx),
    ...injected,
    ...actions.slice(idx)
  ];
}

function ensureConcreteDemoSelection(section, actions, controls) {
  const state = chooseMatchingState(section, controls);
  if (!state) return actions;

  const relevantButtons = meaningfulStateButtons(state, controls);
  const relevantLower = new Set(relevantButtons.map(button => button.trim().toLowerCase()));
  const existingPreset = (actions || []).find(action =>
    action.action === 'click_button' &&
    relevantLower.has(String(action.text || '').trim().toLowerCase())
  )?.text || null;

  const cleanedActions = (actions || []).filter(action => {
    if (
      action.action === 'set_select' &&
      (action.selector === `#${state.id}` || action.selector === state.id)
    ) {
      return false;
    }
    if (
      action.action === 'click_button' &&
      relevantLower.has(String(action.text || '').trim().toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  const injected = [
    { action: 'set_select', selector: `#${state.id}`, index: state.index },
    { action: 'wait', ms: 500 }
  ];

  const presetButton = existingPreset || choosePresetButton(section, state, controls);
  if (presetButton) {
    injected.push({ action: 'click_button', text: presetButton });
    injected.push({ action: 'wait', ms: 500 });
  }

  return insertBeforePlayback(cleanedActions, injected, controls);
}

function sectionProvidesGuidedSteps(section, state, controls) {
  if (!sectionMatchesOption(section, state)) return false;
  const id = String(section.id || '').toLowerCase();
  if (id.includes('_step_') || /^step_/.test(id) || id.endsWith('_steps')) return true;
  return (section.navActions || []).some(action =>
    action.action === 'step_through' ||
    (action.action === 'click_button' && controls.stepButton && String(action.text || '').trim().toLowerCase() === String(controls.stepButton).trim().toLowerCase())
  );
}

function sectionUsesPreset(section, presetText) {
  const wanted = String(presetText || '').trim().toLowerCase();
  if (!wanted) return false;
  return (section.navActions || []).some(action =>
    action.action === 'click_button' &&
    String(action.text || '').trim().toLowerCase() === wanted
  );
}

function sectionTargetsPreset(section, state, presetText) {
  if (!sectionMatchesOption(section, state)) return false;
  const buttons = meaningfulStateButtons(state, { buildButton: null, stepButton: null, playButton: null, pauseButton: null, resetButton: null });
  if (buttons.length <= 1) return true;
  return sectionUsesPreset(section, presetText);
}

function sectionProvidesGuidedStepsForPreset(section, state, presetText, controls) {
  if (!sectionTargetsPreset(section, state, presetText)) return false;
  const id = String(section.id || '').toLowerCase();
  if (id.includes('_step_') || /^step_/.test(id) || id.endsWith('_steps') || id.includes('guided_steps')) return true;
  return (section.navActions || []).some(action =>
    action.action === 'step_through' ||
    (action.action === 'click_button' && controls.stepButton && String(action.text || '').trim().toLowerCase() === String(controls.stepButton).trim().toLowerCase())
  );
}

function sectionProvidesAutoplayForPreset(section, state, presetText, controls) {
  if (!sectionTargetsPreset(section, state, presetText)) return false;
  const id = String(section.id || '').toLowerCase();
  if (id.endsWith('_overview') || id.includes('autoplay') || id.includes('playthrough')) return true;
  return (section.navActions || []).some(action =>
    action.action === 'wait_for_animation' ||
    (action.action === 'click_button' && controls.playButton && String(action.text || '').trim().toLowerCase() === String(controls.playButton).trim().toLowerCase())
  );
}

function sanitizeIdPart(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 40);
}

function buildCoverageNarration(optionText, presetText, mode) {
  const lower = String(optionText || '').toLowerCase();
  if (mode === 'step') {
    if (lower.includes('vertex')) return 'Here the process slows to one edge choice at a time, making the two-approximation guarantee easier to see directly in the graph.';
    if (lower.includes('tsp')) return 'Here the construction unfolds slowly: the tree appears first, and the final tour is formed from that structure.';
    if (lower.includes('set cover')) return 'Here the greedy choices appear one selection at a time, making it clear how each chosen set reduces the uncovered elements that remain.';
    return 'Here the example unfolds step by step, so each algorithmic choice can be connected to the approximation guarantee.';
  }

  if (lower.includes('vertex')) return `This ${presetText} instance gives a quick full-run view of how the cover grows. The full motion establishes the final covered structure before the guided walkthrough breaks the choices apart.`;
  if (lower.includes('tsp')) return `This ${presetText} instance gives a quick full-run view of how the tree turns into a tour. The full construction appears first, and the guided walkthrough unpacks the choices afterward.`;
  if (lower.includes('set cover')) return `This ${presetText} instance shows how greedy coverage depends on overlap. The full run appears first, and the guided walkthrough then compares how much uncovered work remains after each choice.`;
  return 'This instance gives a quick overview run first. The overall behavior appears up front, and the slower walkthrough explains the decisions afterward.';
}

function createCoverageSection(state, presetText, mode, sequenceNumber, controls) {
  const id = `${String(sequenceNumber).padStart(2, '0')}_${sanitizeIdPart(state.optionText)}_${sanitizeIdPart(presetText)}_${mode === 'step' ? 'guided_steps' : 'overview'}`;
  let navActions = [
    { action: 'set_select', selector: `#${state.id}`, index: state.index },
    { action: 'wait', ms: 500 },
    { action: 'click_button', text: presetText },
    { action: 'wait', ms: 500 },
  ];

  navActions = injectMotionActions(navActions, controls, mode === 'step' ? 'step' : 'autoplay');
  navActions = ensureModuleFocus(
    navActions,
    '#vizArea',
    hasAnimationSequence({ navActions }) ? '.wrap' : '#vizArea'
  );

  const label = `${state.optionText} ${mode === 'step' ? 'guided walkthrough' : 'overview'}`;
  navActions = navActions.map(action =>
    action.action === 'move_cursor_to'
      ? { ...action, target: '#vizArea', label }
      : action
  );

  return {
    id,
    group: null,
    navActions,
    narration: buildCoverageNarration(state.optionText, presetText, mode),
    expectedElements: ['#vizArea'],
    focusTarget: '#vizArea',
    isAnimated: true
  };
}

function augmentSectionsForCoverage(sections, controls) {
  const generated = [];
  let sequenceNumber = (sections || []).length + 1;

  for (const selectState of controls.selectStates || []) {
    for (const state of selectState.states || []) {
      const buttons = meaningfulStateButtons(state, controls);
      if (!buttons.length) continue;

      for (const button of buttons) {
        const currentSections = [...(sections || []), ...generated];
        const hasAutoplayCoverage = currentSections.some(section =>
          sectionProvidesAutoplayForPreset(section, state, button, controls)
        );
        if (!hasAutoplayCoverage) {
          generated.push(createCoverageSection(state, button, 'autoplay', sequenceNumber++, controls));
        }

        if (controls.stepButton) {
          const afterAutoplay = [...(sections || []), ...generated];
          const hasStepCoverage = afterAutoplay.some(section =>
            sectionProvidesGuidedStepsForPreset(section, state, button, controls)
          );
          if (!hasStepCoverage) {
            generated.push(createCoverageSection(state, button, 'step', sequenceNumber++, controls));
          }
        }
      }
    }
  }

  if (!generated.length) return { sections, addedCount: 0 };

  const insertionIndex = (sections || []).findIndex(section =>
    String(section.id || '').toLowerCase().includes('appendix') ||
    String(section.focusTarget || '').toLowerCase().includes('#appendix')
  );

  const at = insertionIndex === -1 ? sections.length : insertionIndex;
  return {
    sections: [
      ...sections.slice(0, at),
      ...generated,
      ...sections.slice(at)
    ],
    addedCount: generated.length
  };
}

export function normalizeSectionsToModules(sections, exploration) {
  const modules = buildModuleCatalog(exploration);
  const controls = discoverInteractiveControls(exploration);
  let normalizedCount = 0;
  let motionInjectedCount = 0;
  let trimmedNarrationCount = 0;

  const normalizedBase = (sections || []).map(section => {
    const next = {
      ...section,
      navActions: (section.navActions || []).map(action => ({ ...action }))
    };

    const focusTarget = chooseFocusTarget(next, modules);
    if (focusTarget && focusTarget !== next.focusTarget) {
      normalizedCount++;
    }

    if (focusTarget) {
      next.focusTarget = focusTarget;
      next.expectedElements = [focusTarget];
    }

    const sectionControls = controlsForSection(next, controls);
    const teachingMode = inferTeachingMode(next, focusTarget, sectionControls);

    if ((teachingMode !== 'none' || sectionAllowsInteractiveModuleFocus(next)) && next.narration) {
      const maxSentences = teachingMode === 'none' ? 2 : 3;
      const shorterNarration = shortenNarration(next.narration, maxSentences);
      if (shorterNarration !== next.narration) {
        next.narration = shorterNarration;
        trimmedNarrationCount++;
      }
    }

    if (requiresMotion(next, focusTarget, modules) && teachingMode !== 'control' && teachingMode !== 'none') {
      const updated = injectMotionActions(next.navActions, sectionControls, teachingMode);
      if (JSON.stringify(updated) !== JSON.stringify(next.navActions)) {
        next.navActions = updated;
        motionInjectedCount++;
      }
      next.navActions = ensureConcreteDemoSelection(next, next.navActions, sectionControls);
    }

    if (focusTarget) {
      // PERMANENT FIX (2026-04-10): Use `.wrap` (full-tool view) for ANY
      // interactive section, not just ones with explicit play buttons.
      //
      // Old logic only redirected to `.wrap` when both isInteractiveVisualTarget
      // AND hasAnimationSequence were true. This missed `#viz-*`, `#panel-*`,
      // and other module-panel ids — ensureModuleFocus then injected
      // `zoom_to #viz-tree` (etc.), and the navigator's interactive-module
      // mode HID every sibling card, blanking the controls panel in frame 0.
      //
      // New logic: if the section is interactive (has any state-changing
      // navAction OR the focus target is inside the interactive `.wrap` area),
      // zoom the whole tool — never just one panel.
      const focusLooksInteractive =
        isInteractiveVisualTarget(focusTarget)
        || /^#(viz|panel|module|sim|tab)[-_]/i.test(focusTarget)
        || (next.navActions || []).some(a =>
          ['click_button','click_selector','click_nth','set_select','set_slider','step_through','wait_for_animation'].includes(a.action)
        );
      const isTheoryFocus = /^#(intro|theory|appendix)/i.test(focusTarget)
        || sectionIsTheoryModule(next);
      const zoomTarget = focusLooksInteractive && !isTheoryFocus
        ? '.wrap'
        : focusTarget;
      next.navActions = ensureModuleFocus(next.navActions, focusTarget, zoomTarget);
    }

    return next;
  });

  const coverageAugmented = augmentSectionsForCoverage(normalizedBase, controls);
  const normalized = coverageAugmented.sections;

  return {
    sections: normalized,
    summary: {
      moduleFocusAdjusted: normalizedCount,
      motionInjected: motionInjectedCount,
      moduleCount: modules.length,
      coverageAdded: coverageAugmented.addedCount,
      narrationTrimmed: trimmedNarrationCount
    }
  };
}
