#!/usr/bin/env python3
"""
kokoro-tts.py — Kokoro TTS bridge for the Node lecture pipeline.

Usage:
  kokoro-tts.py --text "Hello world." --out /path/to/output.wav [--voice af_heart] [--speed 1.0]

Reads --text or stdin if --text is "-".
Writes 24 kHz WAV to --out (caller can resample to 16 kHz if needed for Whisper).
Prints a single JSON line to stdout with: {duration, words, sample_rate, voice, gen_time}.

This script is the Phase 4 replacement for OpenAI tts-1-hd. It runs entirely
locally on CPU (no GPU contention with vLLM) at ~15-20x real-time on a modern
multicore CPU.

Models are cached under ~/.cache/huggingface/ on first call.
"""

import argparse
import json
import os
import sys
import time
import warnings

warnings.filterwarnings('ignore')

import numpy as np
import soundfile as sf
import torch
from kokoro import KPipeline


def main():
    p = argparse.ArgumentParser(description='Kokoro TTS bridge for the lecture pipeline')
    p.add_argument('--text', required=True, help='Text to speak (use "-" to read from stdin)')
    p.add_argument('--out', required=True, help='Output WAV file path')
    p.add_argument('--voice', default='af_heart', help='Voice id (default: af_heart)')
    p.add_argument('--speed', type=float, default=1.0, help='Speaking speed (default: 1.0)')
    p.add_argument('--lang', default='a', help='Language code (default: a = American English)')
    args = p.parse_args()

    text = sys.stdin.read() if args.text == '-' else args.text
    text = text.strip()
    if not text:
        print(json.dumps({'error': 'empty input'}), file=sys.stderr)
        sys.exit(2)

    t0 = time.time()
    pipeline = KPipeline(lang_code=args.lang, repo_id='hexgrad/Kokoro-82M')
    init_t = time.time() - t0

    t1 = time.time()
    chunks = list(pipeline(text, voice=args.voice, speed=args.speed))
    gen_t = time.time() - t1

    audio_parts = []
    for c in chunks:
        a = c.audio
        if torch.is_tensor(a):
            a = a.cpu().numpy()
        audio_parts.append(np.asarray(a, dtype=np.float32))

    if not audio_parts:
        print(json.dumps({'error': 'no audio generated'}), file=sys.stderr)
        sys.exit(3)

    audio = np.concatenate(audio_parts)
    sr = 24000
    sf.write(args.out, audio, sr, subtype='PCM_16')

    duration = len(audio) / sr
    words = len(text.split())
    result = {
        'duration': round(duration, 3),
        'words': words,
        'sample_rate': sr,
        'voice': args.voice,
        'speed': args.speed,
        'init_time': round(init_t, 3),
        'gen_time': round(gen_t, 3),
        'real_time_factor': round(duration / gen_t, 1) if gen_t > 0 else None,
        'wpm': round(words / (duration / 60), 1) if duration > 0 else None,
        'output': args.out,
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
