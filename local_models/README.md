# Local LLM serving for the lecture pipeline

This directory contains everything needed to run the pipeline against a
local Qwen model instead of the OpenAI API. No agent code is touched —
backend selection happens entirely via the `LECTURE_LLM_BACKEND` env var.

## What's here

```
local_models/
  venv/                     Python venv with vLLM 0.19, torch 2.10+cu128
  scripts/
    serve-vllm-text.sh      Launches Qwen2.5-14B-Instruct-AWQ on :8000 (32B optional via MODEL=)
    serve-vllm-vision.sh    Launches Qwen2.5-VL-7B-Instruct  on :8001
    smoke-test.mjs          Hits both endpoints via the pipeline's own client
  install.log               Output of the vLLM install
  download.log              Output of the HF model download
```

## Quick start

```bash
# 1. Start the text server (foreground; runs forever)
./local_models/scripts/serve-vllm-text.sh

# 2. In a second terminal, start the vision server
./local_models/scripts/serve-vllm-vision.sh

# 3. In a third terminal, smoke-test both
node local_models/scripts/smoke-test.mjs

# 4. Run the pipeline against the local backend
LECTURE_LLM_BACKEND=local node pipeline.mjs --config ./config/test-1min-recurrence.json \
  --skip-tool-qa --skip-planning --skip-quality-loop --skip-nav-validation \
  --skip-inspection --no-human-review --max-sections 3
```

## Backend modes

`LECTURE_LLM_BACKEND` controls where every LLM call goes:

| Value    | Text calls | Vision calls | Use when |
|----------|------------|--------------|----------|
| `api`    | OpenAI     | OpenAI       | Default. No local servers needed. |
| `local`  | local vLLM | local vLLM   | Both servers running. Fully offline. |
| `hybrid` | local vLLM | OpenAI       | Text server running, vision still on API. Useful while debugging vision. |

The pipeline reads this once at startup; you don't need to restart anything
when flipping it.

## Memory budget

Both models co-exist on the 32 GB RTX 5090. The table shows the optional 32B text model;
the default text model is Qwen2.5-14B-Instruct-AWQ, served with `gpu_memory_utilization` 0.4:

| Model                          | VRAM at default GPU_FRACTION |
|--------------------------------|------------------------------|
| Qwen2.5-32B-Instruct-AWQ (text) | ~18 GB at 0.55              |
| Qwen2.5-VL-7B-Instruct (vision) | ~9 GB  at 0.30              |
| KV cache + overhead             | ~3 GB                        |
| **Total**                       | **~30 GB / 32 GB**           |

If you hit OOM, lower `GPU_FRACTION` for one of them via env:
```bash
GPU_FRACTION=0.45 ./local_models/scripts/serve-vllm-text.sh
```

## Override which model is served

```bash
# Smaller, faster text model:
MODEL=Qwen/Qwen2.5-14B-Instruct ./local_models/scripts/serve-vllm-text.sh

# Bigger vision model (if you have headroom):
MODEL=Qwen/Qwen2.5-VL-32B-Instruct ./local_models/scripts/serve-vllm-vision.sh
```

The pipeline picks up the served model name automatically — just keep the
`LOCAL_TEXT_MODEL` / `LOCAL_VISION_MODEL` env var aligned, or rely on
vLLM's `--served-model-name` flag (already passed in the launch script).

## Switching back to the API

```bash
unset LECTURE_LLM_BACKEND
# or:
LECTURE_LLM_BACKEND=api node pipeline.mjs ...
```

The local vLLM servers can keep running; they won't be hit.

## A/B comparison

Run the same lecture twice, once each backend, then compare outputs:

```bash
LECTURE_LLM_BACKEND=api    node pipeline.mjs --config ./config/test-1min-recurrence.json ... --run-dir runs/api_run
LECTURE_LLM_BACKEND=local  node pipeline.mjs --config ./config/test-1min-recurrence.json ... --run-dir runs/local_run

diff -r runs/api_run/state.json runs/local_run/state.json | head
```
