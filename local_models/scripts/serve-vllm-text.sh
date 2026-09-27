#!/usr/bin/env bash
# Launch the local Qwen text model under vLLM with an OpenAI-compatible API.
#
# Defaults:
#   model       Qwen/Qwen2.5-14B-Instruct-AWQ by default (32B-AWQ optional via MODEL=, ~18 GB VRAM at 4-bit)
#   port        8000
#   ctx length  16384  (Qwen2.5 supports up to 32k; 16k is plenty for our prompts)
#   gpu fraction 0.55  (leave room for the vision model on the same GPU)
#
# Override via env vars: MODEL, PORT, MAX_LEN, GPU_FRACTION.
#
# Usage:
#   ./local_models/scripts/serve-vllm-text.sh           # foreground
#   nohup ./local_models/scripts/serve-vllm-text.sh > /tmp/vllm-text.log 2>&1 &
#                                                       # background

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VENV="$REPO_DIR/local_models/venv"

if [ ! -x "$VENV/bin/vllm" ]; then
  echo "vLLM venv not found at $VENV — run the install step first."
  exit 1
fi

MODEL="${MODEL:-Qwen/Qwen2.5-14B-Instruct-AWQ}"
PORT="${PORT:-8000}"
# 14B model fits comfortably with 8k context and a 7B-VL vision server alongside.
# To run the 32B model instead, override MODEL=Qwen/Qwen2.5-32B-Instruct-AWQ — but
# you'll need to either drop the vision server, install CUDA toolkit (for fp8 KV
# cache), or accept hybrid mode. The 32B doesn't coexist with vision on 32 GB.
MAX_LEN="${MAX_LEN:-8192}"
# 0.40 → ~12.7 GB budget. 14B AWQ weights are ~9 GB + KV ~2 GB + overhead. Plenty.
# Leaves ~17 GB free for vision (which needs ~9 GB).
GPU_FRACTION="${GPU_FRACTION:-0.40}"
export PYTORCH_ALLOC_CONF=expandable_segments:True

echo "Starting vLLM (text):"
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
