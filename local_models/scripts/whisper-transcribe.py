#!/usr/bin/env python3
"""
whisper-transcribe.py — whisper.cpp bridge for the lecture pipeline.

Usage:
  whisper-transcribe.py --audio /path/to/audio.{wav,mp3} [--model base.en]

Always returns JSON to stdout: {text, segments: [{t0, t1, text}, ...]}.
The pipeline uses this to derive sentence-level timestamps for subtitle sync.

If the input is not 16 kHz WAV, this script resamples via ffmpeg first.

This is the Phase 4 replacement for OpenAI whisper-1.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import warnings

warnings.filterwarnings('ignore')


def ensure_16k_wav(input_path):
    """Resample to 16 kHz mono WAV via ffmpeg. Returns the resampled path
    plus a flag indicating whether the caller should clean it up."""
    ext = os.path.splitext(input_path)[1].lower()
    if ext == '.wav':
        # Probe sample rate; if already 16k mono, no work needed
        try:
            probe = subprocess.check_output(
                ['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                 '-show_entries', 'stream=sample_rate,channels',
                 '-of', 'json', input_path],
                stderr=subprocess.DEVNULL,
            )
            info = json.loads(probe.decode())
            stream = info.get('streams', [{}])[0]
            if int(stream.get('sample_rate', 0)) == 16000 and int(stream.get('channels', 0)) == 1:
                return input_path, False
        except Exception:
            pass

    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    subprocess.check_call(
        ['ffmpeg', '-y', '-i', input_path, '-ar', '16000', '-ac', '1', tmp.name],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return tmp.name, True


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--audio', required=True)
    p.add_argument('--model', default='base.en', help='whisper.cpp model id')
    p.add_argument('--threads', type=int, default=8)
    args = p.parse_args()

    if not os.path.exists(args.audio):
        print(json.dumps({'error': f'audio not found: {args.audio}'}), file=sys.stderr)
        sys.exit(2)

    wav_path, cleanup = ensure_16k_wav(args.audio)
    try:
        from pywhispercpp.model import Model
        m = Model(args.model, n_threads=args.threads)
        segments = m.transcribe(wav_path)

        result = {
            'text': ' '.join(s.text.strip() for s in segments),
            'segments': [
                {
                    't0': s.t0 / 100.0,   # whisper.cpp returns 10 ms units
                    't1': s.t1 / 100.0,
                    'text': s.text.strip(),
                }
                for s in segments
            ],
        }
        print(json.dumps(result))
    finally:
        if cleanup:
            try: os.unlink(wav_path)
            except OSError: pass


if __name__ == '__main__':
    main()
