/**
 * Assembly Agent
 *
 * Takes all section frames + audio and assembles the final MP4.
 * Handles two types of sections:
 *   1. Static — single screenshot + audio → still image video
 *   2. Animated — multiple frames + audio → real video with motion
 *
 * Uses ffmpeg for all encoding:
 *   - Per-section segments (image+audio or frames+audio)
 *   - Concatenation into final video
 *   - Audio normalization
 *   - Faststart for web playback
 */

import { execSync } from 'child_process';
import { writeFile, readFile, access } from 'fs/promises';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Subtitle helpers ────────────────────────────────────────────────────────

/**
 * Return the best available ffmpeg binary — prefers ffmpeg-full (has drawtext/libfreetype)
 * over the standard ffmpeg which may lack libfreetype.
 */
let _ffmpegBin = null;
function ffmpegBin() {
  if (_ffmpegBin) return _ffmpegBin;
  // Check for ffmpeg-full first (Homebrew formula with full codec/filter set)
  for (const candidate of [
    '/opt/homebrew/Cellar/ffmpeg-full/8.1/bin/ffmpeg',  // Homebrew Cellar (not linked)
    '/opt/homebrew/bin/ffmpeg-full',
    'ffmpeg-full',
    '/usr/local/bin/ffmpeg-full'
  ]) {
    try {
      execSync(`${candidate} -version`, { stdio: 'pipe' });
      _ffmpegBin = candidate;
      return _ffmpegBin;
    } catch {}
  }
  _ffmpegBin = 'ffmpeg';
  return _ffmpegBin;
}

/** Detect once whether Apple VideoToolbox H.264 encoder is available. */
let _vtAvailable = null;
function isVideoToolboxAvailable() {
  if (_vtAvailable !== null) return _vtAvailable;
  try {
    const out = execSync(`${ffmpegBin()} -encoders 2>&1 | grep h264_videotoolbox || true`, { encoding: 'utf-8', shell: true });
    _vtAvailable = out.includes('h264_videotoolbox');
  } catch {
    _vtAvailable = false;
  }
  return _vtAvailable;
}

/** Return the best video codec args: VideoToolbox if available, libx264 otherwise. */
function videoCodecArgs(crf = 20, tune = null) {
  if (isVideoToolboxAvailable()) {
    // VideoToolbox quality: -q:v 1-100 (higher = better). ~65 ≈ libx264 CRF 20.
    const q = Math.round(100 - crf * 2.5);  // crf 18→55, crf 20→50, crf 22→45
    return `-c:v h264_videotoolbox -q:v ${q} -pix_fmt yuv420p`;
  }
  return `-c:v libx264${tune ? ` -tune ${tune}` : ''} -crf ${crf} -pix_fmt yuv420p`;
}

/** Detect once whether the chosen ffmpeg has the drawtext filter (needs libfreetype). */
let _drawtextAvailable = null;
function isDrawtextAvailable() {
  if (_drawtextAvailable !== null) return _drawtextAvailable;
  try {
    const out = execSync(`${ffmpegBin()} -filters 2>&1 | grep drawtext || true`, { encoding: 'utf-8', shell: true });
    _drawtextAvailable = out.includes('drawtext');
  } catch {
    _drawtextAvailable = false;
  }
  return _drawtextAvailable;
}

/**
 * Wrap narration text to at most `maxLines` lines of `maxChars` chars each.
 * Returns the lines array.
 */
function wrapNarration(text, maxChars = 82, maxLines = 2) {
  const words = text.trim().split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

  // Append ellipsis if more content was cut
  const totalText = words.join(' ');
  if (lines.join(' ').length < totalText.length - 2) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.substring(0, maxChars - 3).trimEnd() + '...';
  }

  return lines;
}

/**
 * Write narration as a text file (used by ffmpeg drawtext=textfile=).
 * Returns the tmp path.  Uses /tmp to avoid paths-with-spaces issues.
 */
function writeSubtitleFile(narration, tag) {
  const lines = wrapNarration(narration);
  const path = `/tmp/lecture_sub_${tag}.txt`;
  writeFileSync(path, lines.join('\n'), 'utf8');
  return { path, lineCount: lines.length };
}

/**
 * Build the ffmpeg drawtext filter string for the subtitle bar.
 */
function buildDrawtextFilter(textFilePath, lineCount) {
  // Each rendered line: fontsize(26) + 2*boxborderw(10) + line_spacing(8) ≈ 54px
  // Position the top of the text block so the bottom sits ~20px above the frame edge.
  const lineH = 54;
  const bottomMargin = 20;
  const y = `h-${bottomMargin + lineCount * lineH}`;

  return (
    `drawtext=textfile='${textFilePath}'` +
    `:fontcolor=white` +
    `:fontsize=26` +
    `:box=1` +
    `:boxcolor=black@0.75` +
    `:boxborderw=10` +
    `:x=(w-text_w)/2` +
    `:y=${y}` +
    `:line_spacing=8`
  );
}

/**
 * Build a single segment from a static frame + audio.
 */
export function buildStaticSegment(framePath, audioPath, outputPath, options = {}) {
  const { fps = 5, crf = 18, narration } = options;

  let subtitlePath = null;
  let vfFilter = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2`;

  if (narration && isDrawtextAvailable()) {
    const tag = outputPath.replace(/[^a-z0-9]/gi, '_').slice(-30);
    const sub = writeSubtitleFile(narration, tag);
    subtitlePath = sub.path;
    vfFilter += `,${buildDrawtextFilter(sub.path, sub.lineCount)}`;
  } else if (narration) {
    console.log('   ℹ️  drawtext not available (ffmpeg missing libfreetype) — skipping subtitle overlay');
  }

  execSync(`${ffmpegBin()} -y \
    -loop 1 -i "${framePath}" \
    -i "${audioPath}" \
    ${videoCodecArgs(crf, 'stillimage')} \
    -c:a aac -b:a 192k \
    -vf "${vfFilter}" \
    -r ${fps} \
    -shortest \
    "${outputPath}"`,
    { stdio: 'pipe' }
  );

  if (subtitlePath) { try { unlinkSync(subtitlePath); } catch {} }
  return outputPath;
}

/**
 * Build a segment from animation frames + audio.
 * The frames are combined into a video at the specified fps,
 * then muxed with the audio track.
 */
export function buildAnimationSegment(framePaths, audioPath, outputPath, options = {}) {
  const { crf = 20, narration } = options;

  // Get audio duration
  let audioDuration = 10;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration -of json "${audioPath}"`,
      { encoding: 'utf-8' }
    );
    audioDuration = parseFloat(JSON.parse(probe).format.duration) || 10;
  } catch {}

  // Create a concat demuxer file with explicit frame durations
  // This ensures frames span exactly the audio duration
  const frameDuration = audioDuration / framePaths.length;
  const concatFile = outputPath.replace('.mp4', '_frames.txt');
  const concatContent = framePaths.map(p =>
    `file '${p}'\nduration ${frameDuration.toFixed(4)}`
  ).join('\n') + `\nfile '${framePaths[framePaths.length - 1]}'`;  // last frame repeated for concat demuxer

  writeFileSync(concatFile, concatContent);

  let subtitlePath = null;
  let vfFilter = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2`;

  if (narration && isDrawtextAvailable()) {
    const tag = outputPath.replace(/[^a-z0-9]/gi, '_').slice(-30);
    const sub = writeSubtitleFile(narration, tag);
    subtitlePath = sub.path;
    vfFilter += `,${buildDrawtextFilter(sub.path, sub.lineCount)}`;
  }

  execSync(`${ffmpegBin()} -y \
    -f concat -safe 0 -i "${concatFile}" \
    -i "${audioPath}" \
    ${videoCodecArgs(crf)} \
    -c:a aac -b:a 192k \
    -vf "${vfFilter}" \
    -shortest \
    "${outputPath}"`,
    { stdio: 'pipe' }
  );

  if (subtitlePath) { try { unlinkSync(subtitlePath); } catch {} }
  return outputPath;
}

/**
 * Concatenate all segments into the final video.
 */
export async function concatenateSegments(segmentPaths, outputPath) {
  // Create concat file
  const concatFile = outputPath.replace('.mp4', '_concat.txt');
  const concatContent = segmentPaths.map(p => `file '${p}'`).join('\n');
  await writeFile(concatFile, concatContent);

  execSync(`${ffmpegBin()} -y \
    -f concat -safe 0 -i "${concatFile}" \
    -c:v copy \
    -c:a copy \
    -movflags +faststart \
    "${outputPath}"`,
    { stdio: 'pipe' }
  );

  // Verify output
  const probe = execSync(
    `ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height -of json "${outputPath}"`,
    { encoding: 'utf-8' }
  );

  return {
    outputPath,
    metadata: JSON.parse(probe),
    segmentCount: segmentPaths.length
  };
}

/**
 * Assemble the complete lecture from pipeline state.
 */
export async function assembleFullLecture(state) {
  const sections = state.data.sections.filter(s =>
    s.status === 'qa_pass' || s.status === 'approved'
  );

  console.log(`🎬 Assembling ${sections.length} sections...`);
  const segmentPaths = [];

  for (const section of sections) {
    const segmentPath = section.segmentPath || join(state.runDir, 'segments', `seg_${section.id}.mp4`);

    // Skip segments already built during per-section recording
    if (existsSync(segmentPath)) {
      segmentPaths.push(segmentPath);
      console.log(`   ⏭️  Segment ${section.id} cached`);
      continue;
    }

    // Subtitles are rendered into the DOM during recording — no ffmpeg drawtext needed
    if (section.framePaths && section.framePaths.length > 1) {
      // Animated section
      buildAnimationSegment(section.framePaths, section.audioPath, segmentPath, {});
    } else {
      // Static section
      const framePath = section.framePath || (section.framePaths && section.framePaths[0]);
      buildStaticSegment(framePath, section.audioPath, segmentPath, {});
    }

    segmentPaths.push(segmentPath);
    console.log(`   ✅ Segment ${section.id} built`);
  }

  // Concatenate — use absolute paths to avoid relative path issues
  const { resolve, basename } = await import('path');
  const absSegmentPaths = segmentPaths.map(p => resolve(p));
  // Derive output name from the tool HTML filename (e.g. "Approximation_Algorithms.html" → "Approximation_Algorithms_Lecture.mp4")
  const toolName = basename(state.data.toolPath || 'Lecture', '.html').replace(/\s+/g, '_');
  const outputPath = resolve(join(state.runDir, '..', `${toolName}_Lecture.mp4`));
  const result = await concatenateSegments(absSegmentPaths, outputPath);

  console.log(`   🎬 Final video: ${outputPath}`);
  console.log(`   📊 Duration: ${(parseFloat(result.metadata.format?.duration || 0) / 60).toFixed(1)} min`);
  console.log(`   📊 Size: ${(parseInt(result.metadata.format?.size || 0) / 1024 / 1024).toFixed(1)} MB`);

  // PERMANENT FIX (2026-04-10): SRT sidecar generation is OPT-IN.
  //
  // Why: most video players (VLC, mpv, QuickTime+VLC, etc.) auto-load any
  // .srt with the same basename as the video and render it on top using
  // their own (large, hard-coded) font. That created a "double subtitle"
  // bug — the carefully-sized in-video DOM caption AT THE BOTTOM, plus a
  // huge player-rendered overlay IN THE MIDDLE. The DOM caption is the
  // canonical subtitle now (it's burned into the frames at the right size
  // and timed sentence-by-sentence).
  //
  // To re-enable for accessibility (e.g. when shipping to platforms that
  // need a separate caption track), set generateSrt: true in the run config.
  let srtPath = null;
  if (state.data.config?.generateSrt === true) {
    srtPath = outputPath.replace('.mp4', '.srt');
    generateSRTSidecar(sections, srtPath);
    console.log(`   📄 Subtitles (opt-in): ${srtPath}`);
  }

  return { ...result, srtPath };
}

/**
 * Generate an SRT subtitle file covering all sections.
 * The sidecar .srt file works in VLC, QuickTime with VLC, mpv, etc.
 */
function generateSRTSidecar(sections, srtPath) {
  let t = 0; // running time in seconds
  let index = 1;
  const entries = [];

  for (const section of sections) {
    const duration = section.audioDuration || 15;
    const text = section.narration || '';
    if (!text) { t += duration; continue; }

    const start = formatSRTTime(t);
    const end   = formatSRTTime(t + duration);
    entries.push(`${index}\n${start} --> ${end}\n${text}\n`);
    t += duration;
    index++;
  }

  writeFileSync(srtPath, entries.join('\n'), 'utf8');
}

function formatSRTTime(secs) {
  const h  = Math.floor(secs / 3600);
  const m  = Math.floor((secs % 3600) / 60);
  const s  = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3,'0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
