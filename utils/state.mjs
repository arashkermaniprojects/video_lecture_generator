/**
 * Pipeline State Machine
 *
 * Manages the full lifecycle of a lecture production run.
 * State is persisted to disk so the pipeline can resume after crashes,
 * human review pauses, or partial failures.
 *
 * State flow:
 *
 *   TOOL_GENERATION ──► TOOL_QA ──► SECTION_PLANNING
 *         ▲                │              │
 *         └── (fail) ──────┘              ▼
 *                                   ┌─────────────┐
 *                                   │  For each    │
 *                                   │  section:    │
 *                                   │              │
 *                                   │  NAVIGATE    │
 *                                   │     │        │
 *                                   │     ▼        │
 *                                   │  RECORD      │
 *                                   │     │        │
 *                                   │     ▼        │
 *                                   │  TTS_GEN     │
 *                                   │     │        │
 *                                   │     ▼        │
 *                                   │  FRAME_QA ───┤◄── retry
 *                                   │     │        │
 *                                   │     ▼        │
 *                                   │  AUDIO_QA ───┤◄── retry
 *                                   │     │        │
 *                                   └─────┼────────┘
 *                                         ▼
 *                                   HUMAN_REVIEW (optional)
 *                                         │
 *                                         ▼
 *                                   ASSEMBLY
 *                                         │
 *                                         ▼
 *                                   FINAL_QA
 *                                         │
 *                                         ▼
 *                                   DONE
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// ── Stage definitions ──
export const Stage = {
  TOOL_GENERATION:  'tool_generation',
  TOOL_QA:          'tool_qa',
  SECTION_PLANNING: 'section_planning',
  NAVIGATE:         'navigate',
  RECORD:           'record',
  TTS_GEN:          'tts_gen',
  FRAME_QA:         'frame_qa',
  AUDIO_QA:         'audio_qa',
  HUMAN_REVIEW:     'human_review',
  ASSEMBLY:         'assembly',
  FINAL_QA:         'final_qa',
  DONE:             'done'
};

// ── Section status ──
export const SectionStatus = {
  PENDING:    'pending',
  RECORDING:  'recording',
  TTS:        'tts',
  QA_PASS:    'qa_pass',
  QA_FAIL:    'qa_fail',
  APPROVED:   'approved',
  RETRY:      'retry'
};

// ── Quality verdict ──
export const QAVerdict = {
  PASS:         'pass',
  FAIL_RETRY:   'fail_retry',    // auto-retry
  FAIL_HUMAN:   'fail_human',    // needs human decision
  FAIL_ABORT:   'fail_abort'     // unrecoverable
};

export class PipelineState {
  constructor(runDir) {
    this.runDir = runDir;
    this.stateFile = join(runDir, 'state.json');
    this.data = {
      runId: null,
      createdAt: null,
      updatedAt: null,
      currentStage: Stage.TOOL_GENERATION,
      toolPath: null,
      sections: [],          // array of SectionState
      config: {},
      retryBudget: {},       // { sectionId: retriesLeft }
      humanReviewQueue: [],  // sections waiting for human review
      assemblyResult: null,
      finalQA: null,
      log: []                // audit trail
    };
  }

  // ── Lifecycle ──

  static async create(runDir, config = {}) {
    await mkdir(runDir, { recursive: true });
    await mkdir(join(runDir, 'frames'), { recursive: true });
    await mkdir(join(runDir, 'audio'), { recursive: true });
    await mkdir(join(runDir, 'segments'), { recursive: true });
    await mkdir(join(runDir, 'qa-reports'), { recursive: true });

    const state = new PipelineState(runDir);
    state.data.runId = `run_${Date.now()}`;
    state.data.createdAt = new Date().toISOString();
    state.data.config = {
      maxRetriesPerSection: 3,
      humanReviewEveryN: 10,       // human gate every N sections
      humanReviewOnFail: true,     // human gate on QA failure after retries
      ttsVoice: 'nova',
      ttsModel: 'tts-1-hd',
      ttsSpeed: 0.95,
      videoFps: 30,
      videoResolution: { width: 1920, height: 1080 },
      screenshotScale: 2,
      autoVisibilityFix: true,
      minReadableFontPx: 14,
      minStrongFontPx: 18,
      minControlFontPx: 15,
      minChartLabelPx: 16,
      severeFontPx: 12,
      minContrastRatio: 4.5,
      minLargeTextContrastRatio: 3.0,
      minFormulaFontPx: 15,
      minFormulaContrastRatio: 6.5,
      minPanelFillRatio: 0.42,
      ...config
    };
    await state.save();
    return state;
  }

  static async resume(runDir) {
    const state = new PipelineState(runDir);
    await state.load();
    state.addLog('pipeline_resumed', {});
    return state;
  }

  async save() {
    this.data.updatedAt = new Date().toISOString();
    await writeFile(this.stateFile, JSON.stringify(this.data, null, 2));
  }

  async load() {
    const raw = await readFile(this.stateFile, 'utf-8');
    this.data = JSON.parse(raw);
  }

  // ── Stage transitions ──

  async setStage(stage) {
    this.data.currentStage = stage;
    this.addLog('stage_change', { stage });
    await this.save();
  }

  // ── Section management ──

  initSections(sections) {
    this.data.sections = sections.map((sec, i) => ({
      index: i,
      id: sec.id,
      status: SectionStatus.PENDING,
      retries: 0,
      framePath: null,
      audioPath: null,
      audioDuration: null,
      segmentPath: null,
      qaReports: [],
      navActions: sec.navActions || [],
      narration: sec.narration || '',
      group: sec.group || null,
      focusTarget: sec.focusTarget || null,
      isAnimated: Boolean(sec.isAnimated),
      scrollTarget: sec.scrollTarget || null,
      expectedElements: sec.expectedElements || []
    }));
    this.data.retryBudget = {};
    sections.forEach(sec => {
      this.data.retryBudget[sec.id] = this.data.config.maxRetriesPerSection;
    });
  }

  getSection(id) {
    return this.data.sections.find(s => s.id === id);
  }

  getPendingSections() {
    return this.data.sections.filter(s =>
      s.status === SectionStatus.PENDING ||
      s.status === SectionStatus.RETRY
    );
  }

  getFailedSections() {
    return this.data.sections.filter(s => s.status === SectionStatus.QA_FAIL);
  }

  async updateSection(id, updates) {
    const sec = this.getSection(id);
    if (!sec) throw new Error(`Section ${id} not found`);
    Object.assign(sec, updates);
    this.addLog('section_update', { id, updates: Object.keys(updates) });
    await this.save();
  }

  canRetry(sectionId) {
    return (this.data.retryBudget[sectionId] || 0) > 0;
  }

  consumeRetry(sectionId) {
    if (this.data.retryBudget[sectionId] > 0) {
      this.data.retryBudget[sectionId]--;
      return true;
    }
    return false;
  }

  // ── Human review ──

  needsHumanReview(sectionIndex) {
    const cfg = this.data.config;
    // Every N sections
    if (cfg.humanReviewEveryN && (sectionIndex + 1) % cfg.humanReviewEveryN === 0) {
      return true;
    }
    return false;
  }

  addToHumanReview(sectionId, reason) {
    this.data.humanReviewQueue.push({
      sectionId,
      reason,
      addedAt: new Date().toISOString(),
      resolved: false
    });
  }

  // ── Audit log ──

  addLog(event, details) {
    this.data.log.push({
      timestamp: new Date().toISOString(),
      event,
      details
    });
    // Keep log bounded
    if (this.data.log.length > 500) {
      this.data.log = this.data.log.slice(-300);
    }
  }
}
