> **Note (v1.0.0):** This document describes the original design of the pipeline.
> Several details have since changed; where they differ, the code and `README.md` are
> authoritative. In particular: all language and vision calls go through
> `utils/claude-agent.mjs`, which routes them to OpenAI models (default `gpt-4.1`) or to
> local open-weight models via vLLM, not to Claude; recording captures periodic
> screenshots (about 5 frames/s) rather than a CDP screencast; the quality loop runs up
> to five iterations by default; and a section that fails inspection three times is kept
> with warnings rather than escalated to human review.

# Lecture Production Pipeline — Architecture

## The Pedagogical Intelligence Loop

The pipeline doesn't just *produce* a video — it **teaches itself to teach better**.

Before any recording happens, simulated students (weak, average, strong) "watch"
each section and report confusion. If the tool can't adequately explain a concept,
the tool itself evolves — new visualizations, interactions, or scaffolding get added
automatically. This loop runs until all student personas can follow the lecture.

```
    ┌────────────────────────────────────────────────────────────┐
    │              PEDAGOGICAL EVOLUTION LOOP                    │
    │                                                            │
    │   ┌──────────────┐     ┌──────────────────────┐           │
    │   │ TOOL (v1)     │────►│ TEACHING EVALUATOR   │           │
    │   │ HTML tool     │     │ (master teacher)      │           │
    │   └──────────────┘     └──────────┬───────────┘           │
    │          ▲                        │                        │
    │          │                        ▼                        │
    │          │              ┌──────────────────────┐           │
    │   ┌──────┴───────┐     │ STUDENT SIMULATOR     │           │
    │   │ TOOL EVOLVER  │     │                      │           │
    │   │ adds features │     │ 🟢 Alex (strong)     │           │
    │   │ adds animations│◄───│ 🟡 Jordan (average)  │           │
    │   │ adds scaffolds│     │ 🔴 Sam (struggling)  │           │
    │   └──────────────┘     │                      │           │
    │                        │ "I'm confused about   │           │
    │                        │  which line is f(n)"  │           │
    │                        │                      │           │
    │                        │ "Can you show n=100?" │           │
    │                        │                      │           │
    │                        │ "Is this a tight      │           │
    │                        │  bound?"              │           │
    │                        └──────────────────────┘           │
    │                                                            │
    │   Repeats until all students follow (max 3 cycles)        │
    └────────────────────────────────────────────────────────────┘
                          │
                          ▼ Tool is now pedagogically optimized
```

## The Full Agentic Cycle

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌──────────────────┐                                           │
│  │  TOOL GENERATOR   │  Claude creates/modifies the HTML tool   │
│  │  (Claude Agent)   │  from a topic description                │
│  └────────┬─────────┘                                           │
│           │                                                     │
│           ▼                                                     │
│  ┌──────────────────┐         ┌──────────────────┐              │
│  │    TOOL QA        │───fail──►  TOOL PATCHER    │              │
│  │  (Playwright +    │         │  (Claude Agent)   │              │
│  │   Claude Vision)  │◄────────┤  fixes HTML       │              │
│  └────────┬─────────┘         └──────────────────┘              │
│           │ pass                                                │
│           ▼                                                     │
│  ┌──────────────────┐                                           │
│  │ SECTION PLANNER   │  Claude analyzes the tool and creates    │
│  │ (Claude Agent)    │  navigation + narration for each section │
│  └────────┬─────────┘                                           │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────────────────────────────────┐                │
│  │         PER-SECTION LOOP (42 sections)       │                │
│  │                                              │                │
│  │  ┌────────────┐                              │                │
│  │  │ NAVIGATOR   │ Playwright drives browser   │                │
│  │  │             │ clicks, scrolls, triggers   │                │
│  │  └──────┬─────┘                              │                │
│  │         │                                    │                │
│  │         ▼                                    │                │
│  │  ┌────────────┐                              │                │
│  │  │ RECORDER    │ CDP screencast captures     │                │
│  │  │             │ real frames + animations    │                │
│  │  └──────┬─────┘                              │                │
│  │         │                                    │                │
│  │         ▼                                    │                │
│  │  ┌────────────┐                              │                │
│  │  │ FRAME QA    │ Claude Vision checks:       │                │
│  │  │             │ • content visible?          │  ┌──────────┐ │
│  │  │             │ • bottom shown?       fail──┼──► RETRY    │ │
│  │  │             │ • layout correct?           │  │ (max 3x) │ │
│  │  └──────┬─────┘                              │  └──────────┘ │
│  │         │ pass                               │                │
│  │         ▼                                    │                │
│  │  ┌────────────┐                              │                │
│  │  │ TTS AGENT   │ OpenAI TTS + quality check: │                │
│  │  │             │ • silence detection          │                │
│  │  │             │ • duration vs word count     │                │
│  │  │             │ • clipping detection          │                │
│  │  └──────┬─────┘                              │                │
│  │         │ pass                               │                │
│  │         ▼                                    │                │
│  │  ┌────────────┐                              │                │
│  │  │ AUDIO QA    │ Validates audio integrity    │                │
│  │  └──────┬─────┘                              │                │
│  │         │                                    │                │
│  │    every 10 sections                         │                │
│  │         ▼                                    │                │
│  │  ┌────────────┐                              │                │
│  │  │ 👤 HUMAN    │ Review checkpoint:           │                │
│  │  │  REVIEW     │ approve / retry / pause     │                │
│  │  └──────┬─────┘                              │                │
│  │         │                                    │                │
│  └─────────┼────────────────────────────────────┘                │
│            │                                                     │
│            ▼                                                     │
│  ┌──────────────────┐                                           │
│  │ 👤 PRE-ASSEMBLY   │ Final human check before rendering       │
│  │    REVIEW         │                                           │
│  └────────┬─────────┘                                           │
│           │                                                     │
│           ▼                                                     │
│  ┌──────────────────┐                                           │
│  │  ASSEMBLER        │ ffmpeg: segments → concat → MP4          │
│  │                   │ • per-section encoding                   │
│  │                   │ • animation segments (real video)        │
│  │                   │ • static segments (still image)          │
│  └────────┬─────────┘                                           │
│           │                                                     │
│           ▼                                                     │
│  ┌──────────────────┐                                           │
│  │  FINAL QA         │ Duration check, sample frame review     │
│  │  (Claude Vision)  │                                          │
│  └────────┬─────────┘                                           │
│           │                                                     │
│           ▼                                                     │
│      ✅ DONE — MP4 output                                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Why Claude Agent SDK (not LangGraph/n8n)?

1. **Same ecosystem** — The HTML tool is built with Claude. The pipeline
   uses Claude for QA, tool fixing, section planning. One stack.

2. **Vision-native QA** — Claude can look at screenshots and evaluate
   whether content is visible, readable, and correct. This is the core
   quality gate.

3. **Tool-creation loop** — When Tool QA fails, Claude fixes the HTML
   directly. LangGraph can't do this without wrapping Claude anyway.

4. **State persistence** — Pipeline state saves to JSON. Resume anytime
   with `--resume`. No database needed.

### Why Playwright (not html2canvas)?

- **Real scrolling** — html2canvas captures the viewport only. Playwright
  scrolls to bottom content (formulas, charts) before capture.

- **Real animations** — CDP screencast captures actual frame-by-frame
  video. html2canvas gives you one frozen moment.

- **Reliable navigation** — Proper `click()`, `waitForSelector()`,
  `scrollIntoView()`. No brittle DOM queries.

### The Retry Budget

Each section gets 3 retries. The pipeline tracks:
- Which stage failed (frame capture, TTS, QA)
- What the specific issue was
- How many retries are left

When retries exhaust, the section escalates to human review.
The human can: approve (override), retry (reset budget), skip, or pause.

### The Pedagogical Evolution (Stage 1.5)

This runs BEFORE expensive recording. It catches teaching problems early:

1. **Preview Capture** — Quick screenshots of each section's tool state
2. **Student Simulation** — Three AI personas react to screenshot + narration
3. **Teaching Evaluation** — Master teacher agent assesses pedagogy
4. **Tool Evolution** — If tool can't explain a concept, Claude modifies the HTML
5. **Re-evaluation** — Loop until all students can follow (max 3 cycles)

The three student personas each serve a different purpose:
- **Strong student** catches errors and asks for rigor
- **Average student** needs visual-verbal alignment
- **Struggling student** reveals where scaffolding is missing

### The Real-Human Confusion Loop (Conversation Monitor)

While Stage 1.5 catches pedagogical issues with simulated students BEFORE
recording, the Conversation Monitor catches issues with the REAL human
reviewer DURING recording. This is the ultimate feedback loop:

```
    ┌─────────────────────────────────────────────────────────┐
    │           REAL-HUMAN CONFUSION LOOP                      │
    │                                                          │
    │   Recording section...                                   │
    │          │                                                │
    │          ▼                                                │
    │   ┌────────────┐                                         │
    │   │ 👤 HUMAN    │ Reviews section frame + audio           │
    │   │   REVIEW    │ Chooses: approve / retry / feedback     │
    │   └──────┬─────┘                                         │
    │          │ (feedback text captured)                       │
    │          ▼                                                │
    │   ┌──────────────────────────┐                           │
    │   │ CONVERSATION MONITOR     │                           │
    │   │                          │                           │
    │   │ Quick signals:           │                           │
    │   │ • "don't understand"     │                           │
    │   │ • repeated retries       │                           │
    │   │ • notation questions     │                           │
    │   │                          │                           │
    │   │ Deep analysis (Claude):  │                           │
    │   │ • confusion type         │                           │
    │   │ • can tool help?         │                           │
    │   │ • specific suggestion    │                           │
    │   └──────┬───────────────────┘                           │
    │          │                                                │
    │      ┌───┴───┐                                           │
    │    strong   weak                                         │
    │      │       │                                           │
    │      │       └──► Log for future improvement             │
    │      ▼                                                   │
    │   ┌──────────────┐                                       │
    │   │ TOOL EVOLVER  │ Mid-pipeline evolution!              │
    │   │ • modifies HTML│                                     │
    │   │ • reloads page │                                     │
    │   │ • retries section│                                   │
    │   └──────────────┘                                       │
    │          │                                                │
    │          ▼                                                │
    │   Section re-recorded with evolved tool                  │
    │                                                          │
    │   ── After all sections ──                               │
    │                                                          │
    │   ┌────────────────────────────┐                         │
    │   │ SYSTEMIC ISSUE DETECTION   │                         │
    │   │ Groups recurring confusions │                         │
    │   │ across multiple sections   │                         │
    │   │ → batch tool evolution     │                         │
    │   └────────────────────────────┘                         │
    └─────────────────────────────────────────────────────────┘
```

Confusion strength levels determine the response:
- **STRONG** (auto-trigger): Explicit confusion language, repeated retries
  → Immediately evolve tool and retry section
- **MEDIUM** (suggest): Notation questions, skipped sections, narration edits
  → Log and suggest evolution at checkpoint
- **WEAK** (monitor): Long pauses, quick approvals without review
  → Log for systemic analysis only

The Conversation Tracker accumulates all confusion events across the session.
After recording completes, `detectSystemicIssues()` groups recurring patterns
and generates batch tool evolution requirements (e.g., "every proof section
confuses the human → add a persistent notation reference sidebar").

## File Structure

```
lecture-pipeline/
├── pipeline.mjs              # Main orchestrator (entry point)
├── package.json
├── ARCHITECTURE.md           # This file
│
├── agents/
│   ├── tool-generator.mjs    # Creates HTML tools from topic descriptions
│   ├── tool-qa.mjs           # Validates tools with Playwright + Claude
│   ├── student-simulator.mjs # Simulates weak/average/strong students
│   ├── teaching-evaluator.mjs# Master teacher evaluates pedagogy
│   ├── tool-evolver.mjs      # Evolves tool based on pedagogy feedback
│   ├── navigator.mjs         # Drives browser navigation per section
│   ├── recorder.mjs          # CDP screencast + screenshot capture
│   ├── tts-agent.mjs         # OpenAI TTS with quality checks
│   ├── video-qa.mjs          # Claude Vision frame + animation QA
│   ├── assembler.mjs         # ffmpeg video assembly
│   └── conversation-monitor.mjs # Real human confusion detection + tracker
│
├── utils/
│   ├── state.mjs             # Pipeline state machine + persistence
│   ├── claude-agent.mjs      # Claude API wrapper for sub-agents
│   └── human-review.mjs      # Terminal-based human review interface
│
├── config/
│   └── sections.json         # Section definitions (nav + narration)
│
└── runs/                     # Created at runtime
    └── run_<timestamp>/
        ├── state.json        # Persistent pipeline state
        ├── frames/           # Captured screenshots + animation frames
        ├── audio/            # TTS MP3 files
        ├── segments/         # Per-section MP4 segments
        └── qa-reports/       # QA verdicts and review packets
```

## Usage

```bash
# Install dependencies
npm install

# Set API keys
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-proj-..."

# Full pipeline run
node pipeline.mjs

# Resume after pause/crash
node pipeline.mjs --resume --run-dir ./runs/run_1234567890

# Re-record a single section
node pipeline.mjs --section 28_merge_sort --run-dir ./runs/run_1234567890

# Fully automated (no human review gates)
node pipeline.mjs --no-human-review

# Skip tool QA (when tool is known-good)
node pipeline.mjs --skip-tool-qa

# Skip pedagogical evaluation (trust the tool as-is)
node pipeline.mjs --skip-pedagogy

# Limit evolution cycles
node pipeline.mjs --max-evolution 5
```

---

## Authentication & Billing

### Claude Code CLI Login

The pipeline uses the `claude` CLI for vision QA (see `utils/claude-agent.mjs`).
**Important:** If you run Claude Code CLI without logging in (`claude login`), it falls back
to the `ANTHROPIC_API_KEY` environment variable if present — and **all calls are billed to
your API account**, not your Claude.ai subscription.

To avoid unexpected API costs:
1. Run `claude login` in a terminal **before** starting the pipeline
2. This authenticates Claude Code to your Claude.ai account (Max or Pro)
3. Usage is then counted against your subscription, not the API pay-per-token billing

If you see unexpected charges on your Anthropic API dashboard, check whether
`ANTHROPIC_API_KEY` is set in your environment (`echo $ANTHROPIC_API_KEY`).

### OpenAI (TTS)
The pipeline uses `OPENAI_API_KEY` for text-to-speech (TTS). This is always billed to
your OpenAI account per character — no subscription alternative exists.
