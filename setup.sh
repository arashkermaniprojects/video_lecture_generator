#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  LECTURE PIPELINE — Setup Script
# ═══════════════════════════════════════════════════════════
#
#  Prerequisites:
#    - Node.js 18+ (https://nodejs.org)
#    - ffmpeg installed (brew install ffmpeg / apt install ffmpeg)
#    - OpenAI API key (https://platform.openai.com) — for planning, QA, and TTS
#
#  Run this script once from the lecture-pipeline/ folder:
#    chmod +x setup.sh && ./setup.sh
#
# ═══════════════════════════════════════════════════════════

set -e

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Lecture Pipeline — Setup"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Check Node.js ──
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install from https://nodejs.org (v18+)"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js v18+ required (found v$(node -v))"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# ── Check ffmpeg ──
if ! command -v ffmpeg &> /dev/null; then
    echo "❌ ffmpeg not found."
    echo "   Install: brew install ffmpeg (macOS) or sudo apt install ffmpeg (Linux)"
    exit 1
fi
echo "✅ ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"

# ── Check ffprobe ──
if ! command -v ffprobe &> /dev/null; then
    echo "⚠️  ffprobe not found (usually installed with ffmpeg)"
fi

# ── Install npm dependencies ──
echo ""
echo "📦 Installing npm dependencies..."
npm install

# ── Install Playwright browsers ──
echo ""
echo "🌐 Installing Playwright Chromium..."
npx playwright install chromium

# ── Check API keys ──
echo ""
if [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️  OPENAI_API_KEY not set (needed for planning, QA, and TTS)."
    echo "   Get one at: https://platform.openai.com/api-keys"
    echo "   Then run:   export OPENAI_API_KEY=sk-..."
else
    echo "✅ OPENAI_API_KEY is set"
fi

# ── Create run directories ──
mkdir -p runs

# ── Verify syntax ──
echo ""
echo "🔍 Checking pipeline syntax..."
node --check pipeline.mjs && echo "   ✅ pipeline.mjs OK"
node --check utils/state.mjs && echo "   ✅ state.mjs OK"
node --check utils/human-review.mjs && echo "   ✅ human-review.mjs OK"
node --check utils/claude-agent.mjs && echo "   ✅ claude-agent.mjs OK"

for f in agents/*.mjs; do
    node --check "$f" && echo "   ✅ $(basename $f) OK"
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Setup complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Set your API keys (if not already):"
echo "     export OPENAI_API_KEY=sk-..."
echo ""
echo "  2. Edit config/sections.json with your section definitions"
echo "     (6 examples are included — fill in all 42 for your lecture)"
echo ""
echo "  3. Run the pipeline:"
echo "     node pipeline.mjs                  # Full run"
echo "     node pipeline.mjs --skip-pedagogy  # Skip simulated students"
echo "     node pipeline.mjs --no-human-review # Fully automated"
echo ""
echo "  4. If it crashes or you pause, resume with:"
echo "     node pipeline.mjs --resume --run-dir runs/run_XXXXX"
echo ""
