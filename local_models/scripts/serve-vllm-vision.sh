#!/usr/bin/env bash
# Launch the local Qwen vision-language model under vLLM with an OpenAI-compatible API.
#
# Runs on a SECOND port (8001) so it can co-exist with the text server (8000).
# Together they fit in 32 GB VRAM:
#   text   Qwen2.5-32B AWQ   ~18 GB at GPU_FRACTION=0.55
#   vision Qwen2.5-VL-7B     ~9 GB  at GPU_FRACTION=0.30
#   ──────────────────────────────────
#                            ~27 GB total, leaves ~5 GB headroom

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VENV="$REPO_DIR/local_models/venv"

if [ ! -x "$VENV/bin/vllm" ]; then
  echo "vLLM venv not found at $VENV — run the install step first."
  exit 1
fi

MODEL="${MODEL:-Qwen/Qwen2.5-VL-7B-Instruct-AWQ}"
PORT="${PORT:-8001}"
# 8k context: image tokens alone can hit 1k-1.5k for a 1920x1080 frame, plus
# a multi-paragraph prompt + room for output. 4k was too small for the
# student-simulator agent (image + ~3k char prompt + 4096 output tokens).
MAX_LEN="${MAX_LEN:-8192}"
# 0.42 → ~13.4 GB. AWQ weights ~6.5 GB + activations/CUDA graphs + KV cache.
GPU_FRACTION="${GPU_FRACTION:-0.42}"
export PYTORCH_ALLOC_CONF=expandable_segments:True

echo "Starting vLLM (vision):"
echo "  model        $MODEL"
echo "  port         $PORT"
echo "  max-model-len $MAX_LEN"
echo "  gpu-fraction $GPU_FRACTION"
echo

exec "$VENV/bin/vllm" serve "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --max-model-len "$MAX_LEN" \
  --gpu-memory-utilization "$GPU_FRACTION" \
  --served-model-name "$MODEL" \
  --dtype auto
