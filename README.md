# Agentic Lecture Production Pipeline

Turns an AI-generated interactive HTML teaching tool into a narrated lecture video.
The pipeline treats the generated tool as a *revisable instructional object*: it
checks the tool technically, plans lecture sections, lets simulated learners and an
evaluator critique each section (and, when needed, revise the narration, the section
order or the tool itself), then records the real tool in a browser, adds synthesized
narration with subtitles and assembles the final video.

Example lectures produced with an earlier version of this pipeline:

| Topic | Video | Interactive tool |
|---|---|---|
| Asymptotic notation | [YouTube](https://www.youtube.com/watch?v=UfbiMRP_Qos) | [Tool](https://arashkermaniprojects.github.io/Asymptotic-Notations/) |
| Recurrence relations | [YouTube](https://www.youtube.com/watch?v=6M6dVZYSmys) | — |
| Approximation algorithms | [YouTube](https://www.youtube.com/watch?v=S0j0UNGl4ak) | [Tool](https://arashkermaniprojects.github.io/approximation-algorithms/) |
| Reinforcement learning from human feedback | — | [Tool](https://arashkermaniprojects.github.io/rlhf/) |

## How it works

```
AI-generated HTML tool
  → 1. Technical QA and repair       agents/tool-qa.mjs, agents/visibility-fixer.mjs
  → 2. Section planning              agents/section-planner.mjs
  → 3. Pedagogical quality loop      agents/quality-loop.mjs
        simulated learners           agents/student-simulator.mjs
        teaching evaluator           agents/teaching-evaluator.mjs
        tool evolution               agents/tool-evolver.mjs
  → re-validate navigation against the (possibly evolved) tool
  → 4. Per-section recording         agents/recorder.mjs, agents/navigator.mjs,
                                     agents/frame-guard.mjs, agents/quality-inspector.mjs
  → 5. Narration (text-to-speech)    agents/tts-agent.mjs
  → 6. Assembly and final video QA   agents/assembler.mjs, agents/video-qa.mjs
```

Human review gates stop the run when tool QA escalates, when the quality loop does
not converge, every ten recorded sections and before assembly
(`utils/human-review.mjs`). All state is saved to `runs/run_*/state.json`, so runs
can be resumed and single sections re-recorded.

**Quality loop in brief.** For every section, three fixed personas (strong, average,
struggling student) look at a screenshot of the section and its narration and report
confusion (0–10), questions, whether the current tool can answer them, and possible
departures from multimedia design principles. A section passes when mean confusion
≤ 3.5, no persona exceeds 6, at most two questions are unanswerable, the evaluator's
pedagogy score is ≥ 65 and no persona would stop watching. Otherwise the evaluator
chooses `rewrite_narration` or `evolve_tool`; sections with a missing prerequisite
are reordered or preceded by a bridging section. The loop repeats (default: at most
five iterations). The persona judgments are a design heuristic and have not been
calibrated against real learners.

## Requirements

- Node.js 18 or newer
- Google Chrome (recording uses Playwright with the system Chrome, `channel: 'chrome'`)
- ffmpeg (a build with `drawtext`/libfreetype, e.g. Homebrew `ffmpeg-full`, is preferred)
- An OpenAI API key for the default hosted backend (language/vision models,
  `tts-1-hd` narration and `whisper-1` timestamps)
- Optional, for a fully local setup: an NVIDIA GPU with vLLM
  (see [`local_models/README.md`](local_models/README.md))

## Installation

```bash
git clone https://github.com/arashkermaniprojects/video_lecture_generator.git
cd video_lecture_generator
npm install
cp .env.example .env        # then put your OPENAI_API_KEY in .env
```

`./setup.sh` checks the prerequisites and performs the same steps.

## Running

```bash
# Full run: QA → planning → quality loop → recording → assembly
node pipeline.mjs --config ./config/recurrence-sections.json

# Resume an interrupted run
node pipeline.mjs --resume --run-dir runs/run_<id>

# Re-record a single section of an existing run
node pipeline.mjs --config ./config/recurrence-sections.json --run-dir runs/run_<id> --section <sectionId>
```

| Option | Effect |
|---|---|
| `--config <file>` | Lecture configuration (default `./config/sections.json`) |
| `--run-dir <dir>` | Run directory to create or reuse |
| `--resume` | Continue from the saved state |
| `--section <id>` | Re-record one section (with `--run-dir`) |
| `--skip-tool-qa`, `--skip-planning`, `--skip-quality-loop`, `--skip-nav-validation`, `--skip-inspection` | Skip individual stages |
| `--no-human-review` | Run without interactive review gates |
| `--max-quality-iter <n>` | Iteration limit of the quality loop (default 5) |
| `--max-sections <n>` | Only process the first *n* sections (for tests) |

### Configuration file

```json
{
  "lecture": {
    "toolPath": "./Recurrence_Relations_Explorer.html",
    "guidePath": "./lecture_guide_recurrence",
    "title": "Recurrence relations and the Master Theorem"
  },
  "sections": [],
  "defaults": { "ttsVoice": "shimmer", "ttsModel": "tts-1-hd", "ttsSpeed": 0.95 }
}
```

`title` is optional; it is the topic shown to the simulated learners (if omitted,
it is derived from the tool's file name). `guidePath` is optional; a guide next to
the tool is detected automatically. With planning enabled, sections are generated
from the tool and the guide.

### Choosing models

| Variable | Values | Default |
|---|---|---|
| `LECTURE_LLM_BACKEND` | `api` (OpenAI), `local` (vLLM), `hybrid` (local text, API vision) | `api` |
| `OPENAI_TEXT_MODEL`, `OPENAI_VISION_MODEL` (or `OPENAI_MODEL`) | any OpenAI chat model | `gpt-4.1` |
| `LOCAL_TEXT_MODEL`, `LOCAL_VISION_MODEL` | models served by vLLM | `Qwen/Qwen2.5-14B-Instruct-AWQ`, `Qwen/Qwen2.5-VL-7B-Instruct-AWQ` |
| `LECTURE_TTS_BACKEND` | `api`, `kokoro` (local Kokoro-82M), `local-say` (macOS) | `api` |

The backend and model names used by each invocation are recorded in
`runs/run_*/state.json` (`llmConfig`, `llmConfigLog`).

## Outputs

- `output/<lecture>.mp4`: the final lecture video (subtitles burned in; an `.srt`
  file only if `generateSrt` is enabled)
- `runs/run_*/`: saved state, section plans, frames, audio, per-section video
  segments and tool versions (`tool_v*.html`) for inspection and re-recording

## Repository layout

```
pipeline.mjs          Orchestrator (command-line entry point)
agents/               One module per agent (QA, planning, personas, evaluator, evolver,
                      recording, TTS, assembly, video QA, review monitor)
utils/                State, LLM wrapper (claude-agent.mjs), human review, section normalizer
config/               Example lecture configurations
lecture_guide*/       Example lecture guides
local_models/         Scripts for serving local models with vLLM and local TTS
*.html                Example AI-generated teaching tools
```

`ARCHITECTURE.md` documents the original design; where it differs from the code,
the code and this README are authoritative.

## Known limitations

- The simulated learners are LLM prompts, not models of real students; their ratings
  have not been validated against learner data.
- Frame inspection samples the first and middle frame of each section, so brief
  mismatches between narration and screen can go unnoticed.
- Reviewer feedback is logged but not yet fed back into automatic revision
  (`agents/conversation-monitor.mjs` contains the unconnected analysis code).
- Output varies between runs because language-model outputs are not deterministic.

## License

Released under the [MIT License](LICENSE).
