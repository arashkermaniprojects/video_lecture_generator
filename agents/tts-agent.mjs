/**
 * TTS Agent
 *
 * Generates narration audio. Three backends:
 *   1. api    (default) — OpenAI tts-1-hd via REST
 *   2. kokoro             — local Kokoro-82M neural TTS via Python helper
 *   3. local-say          — macOS `say` command (legacy)
 *
 * Backend selection (in order of precedence):
 *   - LECTURE_TTS_BACKEND env var: "api" | "kokoro" | "local-say"
 *   - LOCAL_TTS=1 → "local-say" (legacy, kept for back-compat)
 *   - model option starts with "local-say" → "local-say"
 *   - default: "api"
 *
 * Quality checks (run after generation regardless of backend):
 *   1. Audio duration sanity
 *   2. Silence detection
 *   3. File integrity
 *   4. Word rate check (~150 wpm)
 */

import { writeFile, readFile, stat } from 'fs/promises';
import { execFileSync, execSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const VENV_PYTHON = join(REPO_ROOT, 'local_models', 'venv', 'bin', 'python');
const KOKORO_SCRIPT = join(REPO_ROOT, 'local_models', 'scripts', 'kokoro-tts.py');
const WHISPER_SCRIPT = join(REPO_ROOT, 'local_models', 'scripts', 'whisper-transcribe.py');

function getTTSBackend({ model } = {}) {
  const env = (process.env.LECTURE_TTS_BACKEND || '').toLowerCase().trim();
  if (env === 'api' || env === 'kokoro' || env === 'local-say') return env;
  if (process.env.LOCAL_TTS === '1') return 'local-say';
  if (typeof model === 'string' && model.toLowerCase().startsWith('local-say')) return 'local-say';
  return 'api';
}

function getWhisperBackend() {
  const env = (process.env.LECTURE_WHISPER_BACKEND || '').toLowerCase().trim();
  if (env === 'api' || env === 'whisper-cpp') return env;
  // If TTS backend is local, prefer local Whisper too — they tend to be paired.
  if (getTTSBackend() === 'kokoro') return 'whisper-cpp';
  return 'api';
}

// Map OpenAI voice names → Kokoro voice ids (Kokoro voices share similar styles)
function mapKokoroVoice(voice) {
  const map = {
    nova:    'af_heart',
    shimmer: 'af_heart',
    alloy:   'am_adam',
    echo:    'am_adam',
    fable:   'af_bella',
    onyx:    'am_michael',
    coral:   'af_nicole',
  };
  return map[voice] || process.env.LOCAL_TTS_VOICE || 'af_heart';
}

const EXPECTED_WPM = 155; // nova voice speaks at roughly this rate
const WPM_TOLERANCE = 0.35; // allow 35% deviation

/**
 * Generate TTS audio for a narration text.
 * Returns: { audioPath, duration, fileSize, qualityCheck }
 */
export async function generateTTS(text, outputPath, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    voice = 'nova',
    model = 'tts-1-hd',
    speed = 0.95,
    maxRetries = 2
  } = options;

  const backend = getTTSBackend({ model });

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`   🔄 TTS retry ${attempt}/${maxRetries}...`);
      }

      // ── Generate audio ──
      if (backend === 'kokoro') {
        // PERMANENT FIX (2026-04-10): local Kokoro-82M neural TTS path.
        // Generates 24 kHz WAV, then ffmpeg-converts to MP3 to match the
        // pipeline's expected output format. ~15-20x real-time on CPU.
        const wavPath = outputPath.replace(/\.mp3$/i, '.wav');
        const kokoroVoice = mapKokoroVoice(voice);
        const result = execFileSync(VENV_PYTHON, [
          KOKORO_SCRIPT,
          '--text', text,
          '--out', wavPath,
          '--voice', kokoroVoice,
          '--speed', String(speed),
        ], { encoding: 'utf-8' });
        // Convert WAV → MP3 for pipeline compatibility
        execSync(`ffmpeg -y -i "${wavPath}" -codec:a libmp3lame -q:a 2 "${outputPath}" >/dev/null 2>&1`);
        try { execSync(`rm -f "${wavPath}"`); } catch {}
        // Optional: parse the JSON result from kokoro-tts.py for telemetry
        try {
          const meta = JSON.parse(result.trim().split('\n').pop());
          if (meta && meta.real_time_factor) {
            console.log(`   🎙️  Kokoro: ${meta.duration}s audio in ${meta.gen_time}s (${meta.real_time_factor}x real-time)`);
          }
        } catch {}
      } else if (backend === 'local-say') {
        const aiffPath = outputPath.replace(/\.mp3$/i, '.aiff');
        const sayVoice = mapLocalVoice(voice);
        execFileSync('/usr/bin/say', ['-v', sayVoice, '-o', aiffPath, text]);
        execSync(`ffmpeg -y -i "${aiffPath}" -codec:a libmp3lame -q:a 2 "${outputPath}" >/dev/null 2>&1`);
      } else {
        const resp = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            voice,
            input: text,
            response_format: 'mp3',
            speed
          })
        });

        if (!resp.ok) {
          throw new Error(`TTS API error: ${resp.status} ${await resp.text()}`);
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        await writeFile(outputPath, buffer);
      }

      // ── Quality checks ──
      const qualityCheck = await checkAudioQuality(outputPath, text);

      if (qualityCheck.pass) {
        // Sentence-timestamp extraction strategy:
        //   local-say   → estimate (no real Whisper for that legacy backend)
        //   else        → respect LECTURE_WHISPER_BACKEND (api or whisper-cpp)
        const whisperBackend = getWhisperBackend();
        let sentenceTimestamps;
        if (backend === 'local-say') {
          sentenceTimestamps = estimateSentenceTimestamps(text, qualityCheck.duration);
        } else if (whisperBackend === 'whisper-cpp') {
          sentenceTimestamps = await extractSentenceTimestampsLocal(outputPath, text);
        } else {
          sentenceTimestamps = await extractSentenceTimestamps(outputPath, text, apiKey);
        }

        return {
          audioPath: outputPath,
          duration: qualityCheck.duration,
          fileSize: (await stat(outputPath)).size,
          qualityCheck,
          sentenceTimestamps,
          attempt
        };
      }

      // Quality check failed
      lastError = `Quality check failed: ${qualityCheck.issues.join(', ')}`;
      console.log(`   ⚠️  ${lastError}`);

    } catch (err) {
      lastError = err.message;
      console.log(`   ❌ TTS error: ${err.message}`);
    }
  }

  // All retries exhausted
  return {
    audioPath: outputPath,
    duration: null,
    fileSize: 0,
    qualityCheck: { pass: false, issues: [lastError] },
    attempt: maxRetries
  };
}

function mapLocalVoice(voice) {
  const map = {
    nova: 'Samantha',
    shimmer: 'Samantha',
    alloy: 'Daniel',
    echo: 'Daniel',
    fable: 'Karen',
    onyx: 'Alex',
  };
  return map[voice] || process.env.LOCAL_TTS_VOICE || 'Samantha';
}

function estimateSentenceTimestamps(narration, durationSeconds) {
  const sentences = splitNarrationSentences(narration);
  const totalMs = Math.round((durationSeconds || 0) * 1000);
  if (sentences.length === 0 || totalMs <= 0) return null;
  const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
  const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;
  let cumulative = 0;
  return sentences.map((text, idx) => {
    const atMs = Math.round((cumulative / totalWords) * totalMs);
    cumulative += wordCounts[idx];
    return { text, atMs };
  });
}

/**
 * Check audio quality using ffprobe and heuristics.
 */
async function checkAudioQuality(audioPath, originalText) {
  const issues = [];

  // ── 1. File size check ──
  try {
    const fileInfo = await stat(audioPath);
    if (fileInfo.size < 1000) {
      issues.push('File too small (likely empty or corrupt)');
      return { pass: false, issues, duration: 0 };
    }
  } catch {
    issues.push('File does not exist');
    return { pass: false, issues, duration: 0 };
  }

  // ── 2. Get duration via ffprobe ──
  let duration = 0;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration -of json "${audioPath}"`,
      { encoding: 'utf-8' }
    );
    const probeData = JSON.parse(probe);
    duration = parseFloat(probeData.format.duration) || 0;
  } catch (err) {
    issues.push(`ffprobe failed: ${err.message}`);
    return { pass: false, issues, duration: 0 };
  }

  if (duration < 1) {
    issues.push(`Duration too short: ${duration.toFixed(1)}s`);
    return { pass: false, issues, duration };
  }

  // ── 3. Word rate check ──
  const wordCount = originalText.split(/\s+/).length;
  const actualWPM = (wordCount / duration) * 60;
  const expectedDuration = (wordCount / EXPECTED_WPM) * 60;
  const deviation = Math.abs(duration - expectedDuration) / expectedDuration;

  if (deviation > WPM_TOLERANCE) {
    issues.push(
      `Duration deviation: ${(deviation * 100).toFixed(0)}% ` +
      `(expected ~${expectedDuration.toFixed(1)}s for ${wordCount} words, got ${duration.toFixed(1)}s)`
    );
  }

  // ── 4. Silence detection ──
  try {
    const silenceOutput = execSync(
      `ffmpeg -i "${audioPath}" -af silencedetect=noise=-30dB:d=1.5 -f null - 2>&1 | grep silence_duration || true`,
      { encoding: 'utf-8' }
    );

    const silences = silenceOutput.match(/silence_duration: ([\d.]+)/g) || [];
    const longSilences = silences
      .map(s => parseFloat(s.replace('silence_duration: ', '')))
      .filter(d => d > 2.0);

    if (longSilences.length > 0) {
      issues.push(`${longSilences.length} long silence gap(s) detected (>${longSilences[0].toFixed(1)}s)`);
    }
  } catch {
    // Silence detection is best-effort
  }

  // ── 5. Clipping detection ──
  try {
    const volumeOutput = execSync(
      `ffmpeg -i "${audioPath}" -af volumedetect -f null - 2>&1`,
      { encoding: 'utf-8' }
    );

    const maxVolMatch = volumeOutput.match(/max_volume: ([-\d.]+)/);
    if (maxVolMatch) {
      const maxVol = parseFloat(maxVolMatch[1]);
      if (maxVol > -0.5) {
        issues.push(`Possible audio clipping (max volume: ${maxVol.toFixed(1)} dB)`);
      }
    }
  } catch {
    // Volume detection is best-effort
  }

  const pass = issues.filter(i => !i.includes('deviation')).length === 0;
  // Duration deviation alone is a warning, not a failure

  return { pass, issues, duration, wordCount, actualWPM: Math.round(actualWPM) };
}

// ── Whisper-based subtitle synchronization ─────────────────────────────────

/**
 * Local Whisper via whisper.cpp (Phase 4 replacement for OpenAI whisper-1).
 *
 * Calls the Python helper at local_models/scripts/whisper-transcribe.py which
 * wraps pywhispercpp + auto-resamples the audio to 16 kHz mono.
 *
 * Returns: [{ text, atMs }] or null on failure.
 */
async function extractSentenceTimestampsLocal(audioPath, narration) {
  if (!narration) return null;
  try {
    const result = execFileSync(VENV_PYTHON, [
      WHISPER_SCRIPT,
      '--audio', audioPath,
      '--model', process.env.LOCAL_WHISPER_MODEL || 'base.en',
    ], { encoding: 'utf-8' });

    const data = JSON.parse(result.trim());
    const segments = data.segments || [];
    if (segments.length === 0) return null;

    // Align our narration sentences to whisper.cpp's segments (which are
    // typically full sentences). The simplest mapping: each whisper segment
    // becomes one subtitle entry at its t0.
    const sentences = splitNarrationSentences(narration);

    // If sentence count matches, use our text + whisper's timestamps.
    if (sentences.length === segments.length) {
      return sentences.map((text, i) => ({
        text,
        atMs: Math.round(segments[i].t0 * 1000),
      }));
    }
    // Otherwise fall back: emit one entry per whisper segment with its own text.
    return segments.map(seg => ({
      text: seg.text || '',
      atMs: Math.round(seg.t0 * 1000),
    }));
  } catch (err) {
    console.log(`   ⚠️  whisper.cpp failed: ${(err.message || err).toString().slice(0, 120)}`);
    return null;
  }
}

/**
 * Split narration into sentences (mirrors recorder's splitSentences).
 * Duplicated here to avoid circular dependency between tts-agent and recorder.
 */
function splitNarrationSentences(text) {
  const raw = text.match(/[^.!?]*[.!?]+["']?/g) || [text];
  const result = [];
  for (const s of raw) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (trimmed.length < 25 && result.length > 0) {
      result[result.length - 1] += ' ' + trimmed;
    } else {
      result.push(trimmed);
    }
  }
  return result.length ? result : [text];
}

/**
 * Use OpenAI Whisper to extract word-level timestamps from TTS audio,
 * then align sentence boundaries to actual speech timing.
 *
 * This is the core of subtitle synchronization: instead of guessing
 * when each sentence starts (equal intervals or word-proportional),
 * we ask Whisper exactly when each word is spoken and derive sentence
 * start times from that.
 *
 * Returns: [{ text, atMs }] or null on failure.
 */
async function extractSentenceTimestamps(audioPath, narration, apiKey) {
  if (!narration) return null;

  try {
    const audioData = await readFile(audioPath);
    const file = new File([audioData], 'audio.mp3', { type: 'audio/mpeg' });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });

    if (!resp.ok) {
      console.log(`   ⚠️  Whisper API error: ${resp.status} — falling back to word-proportional`);
      return null;
    }

    const result = await resp.json();
    const words = result.words || [];

    if (words.length === 0) {
      console.log('   ⚠️  Whisper returned no word timestamps');
      return null;
    }

    // Split narration into sentences (same logic the recorder uses)
    const sentences = splitNarrationSentences(narration);

    // Align: walk through Whisper words, advancing by each sentence's word count.
    // The start time of the first word of each sentence = that subtitle's atMs.
    const sentenceTimestamps = [];
    let wordIdx = 0;

    for (const sentence of sentences) {
      const sentenceWords = sentence.split(/\s+/).filter(Boolean).length;
      const startTime = wordIdx < words.length ? words[wordIdx].start : 0;

      sentenceTimestamps.push({
        text: sentence,
        atMs: Math.round(startTime * 1000)
      });

      wordIdx += sentenceWords;
    }

    console.log(`   🔤 Whisper sync: ${sentenceTimestamps.length} sentences aligned to ${words.length} words`);
    return sentenceTimestamps;

  } catch (err) {
    console.log(`   ⚠️  Whisper timestamp extraction failed: ${err.message} — falling back`);
    return null;
  }
}
