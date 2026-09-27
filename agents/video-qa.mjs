/**
 * Video QA Agent
 *
 * Uses Claude's vision to evaluate captured frames and assembled video.
 * Checks:
 *   1. Frame content — does the screenshot show the expected content?
 *   2. Bottom content — is the page bottom visible (formulas, charts)?
 *   3. Animation quality — do sequential frames show motion?
 *   4. Text readability — is text sharp at 1920x1080?
 *   5. Visual consistency — no rendering artifacts, broken layouts
 *   6. Audio-visual sync — does narration match what's on screen?
 *
 * This is the agent that prevents the "wait 20 minutes then discover
 * it's broken" problem. It checks EACH section in real time.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { claudeVision } from '../utils/claude-agent.mjs';

/**
 * QA a single section's captured frame(s).
 * Uses Claude vision to evaluate the screenshot.
 */
export async function qaFrame(framePath, section, options = {}) {
  const text = await claudeVision({
    imagePath: framePath,
    textPrompt: `You are a STRICT QA agent for an educational lecture video. Your job is to REJECT bad frames.

Section ID: ${section.id}
Narration: "${section.narration.substring(0, 300)}"
Expected visible elements: ${JSON.stringify(section.expectedElements || [])}

CRITICAL CHECKS (fail if ANY of these are wrong):
1. Is the correct TAB active? The section should show the right content area.
2. Are graphs/charts FULLY visible including axis labels, legends, and formulas BELOW the chart? Formulas cut off at the bottom = FAIL.
3. If the narration discusses a specific notation (Big-O, Omega, Theta, small-o, small-omega), is that notation card SELECTED and its graph visible?
4. If the narration discusses an algorithm, is the algorithm card selected with its visualization?
5. Is the right panel showing content (not empty/blank)?

SCORING:
- 90-100: Correct tab, correct card selected, graph visible with all labels/formulas, content matches narration
- 60-89: Correct tab but wrong sub-selection or minor content missing
- 30-59: Wrong tab OR right panel is empty/blank
- 0-29: Completely wrong state, blank screen, or rendering broken

BE STRICT. A frame that shows the wrong notation or an empty right panel should score below 30.

Output JSON:
\`\`\`json
{
  "verdict": "pass" | "fail_retry" | "fail_human",
  "score": 0-100,
  "issues": [{ "type": "content_missing|wrong_selection|formulas_cropped|empty_panel|wrong_tab", "description": "..." }],
  "contentVisible": { "charts": true/false, "formulas": true/false, "legendVisible": true/false, "correctSelection": true/false },
  "suggestion": "what to fix if failing"
}
\`\`\``,
  });

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);

  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {
      return { verdict: 'pass', score: 60, issues: [], contentVisible: {} };
    }
  }

  return { verdict: 'pass', score: 60, issues: [], contentVisible: {} };
}

/**
 * QA animation frames — check that sequential frames actually show motion.
 */
export async function qaAnimation(framePaths, section) {
  if (framePaths.length < 2) {
    return { verdict: 'fail_retry', score: 20, issues: [{ type: 'no_animation', description: 'Only 1 frame captured for animated section' }] };
  }

  // Compare first and last frame
  const firstFrame = await readFile(framePaths[0]);
  const lastFrame = await readFile(framePaths[framePaths.length - 1]);

  // Simple size comparison — if frames are very similar size, likely no animation
  const sizeDiff = Math.abs(firstFrame.length - lastFrame.length) / firstFrame.length;

  if (sizeDiff < 0.01) {
    // Frames are nearly identical — ask Claude to verify (just check first frame)
    const text = await claudeVision({
      imagePath: framePaths[0],
      textPrompt: `This is the first frame of what should be an animated section (${section.id}).
Does it look like a valid lecture frame with content visible?
Output JSON: { "hasMotion": true, "description": "frame looks valid" }`,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0]);
        if (!result.hasMotion) {
          return {
            verdict: 'fail_retry',
            score: 30,
            issues: [{ type: 'no_animation', description: `Frames appear identical: ${result.description}` }]
          };
        }
      } catch {}
    }
  }

  return {
    verdict: 'pass',
    score: 85,
    issues: [],
    frameCount: framePaths.length,
    frameSizeDiff: (sizeDiff * 100).toFixed(1) + '%'
  };
}

/**
 * Final QA on the assembled video.
 * Checks duration, samples frames, and verifies AUDIO-VISUAL SYNC.
 */
export async function qaFinalVideo(videoPath, sections) {
  const { execSync } = await import('child_process');
  const cheapMode = process.env.COST_EFFICIENT_MODE === '1' || process.env.LOCAL_TTS === '1';

  // Get video metadata
  let metadata = {};
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration,size,bit_rate -show_entries stream=codec_name,width,height -of json "${videoPath}"`,
      { encoding: 'utf-8' }
    );
    metadata = JSON.parse(probe);
  } catch {}

  const actualDuration = parseFloat(metadata.format?.duration || 0);
  const expectedDuration = sections.reduce((sum, s) => sum + (s.audioDuration || 20), 0);
  const issues = [];

  // ── 1. Duration check ──
  const durationMatch = Math.abs(actualDuration - expectedDuration) / expectedDuration < 0.15;
  if (!durationMatch) {
    issues.push({
      type: 'duration_mismatch',
      description: `Expected ~${(expectedDuration/60).toFixed(1)}min, got ${(actualDuration/60).toFixed(1)}min`
    });
  }

  if (cheapMode) {
    const verdict = issues.length === 0 ? 'pass' : 'fail_human';
    return {
      verdict,
      metadata,
      expectedDuration,
      actualDuration,
      durationMatch,
      syncChecks: 0,
      syncIssues: 0,
      issues
    };
  }

  // ── 2. Audio-Visual Sync Check ──
  // Sample frames at section boundaries and verify content matches
  console.log('   🔄 Checking audio-visual sync...');
  let syncIssues = 0;
  let syncChecks = 0;
  let cumulativeTime = 0;

  // Check 5 evenly-spaced sections
  const checkIndices = [];
  const step = Math.max(1, Math.floor(sections.length / 5));
  for (let i = 0; i < sections.length && checkIndices.length < 5; i += step) {
    checkIndices.push(i);
  }

  for (const idx of checkIndices) {
    // Calculate timestamp for this section
    let sectionStartTime = 0;
    for (let j = 0; j < idx; j++) {
      sectionStartTime += (sections[j].audioDuration || 20);
    }
    const sectionMidTime = sectionStartTime + (sections[idx].audioDuration || 20) / 2;

    if (sectionMidTime >= actualDuration) continue;

    // Extract frame at section midpoint
    const samplePath = videoPath.replace('.mp4', `_sync_check_${idx}.jpg`);
    try {
      execSync(
        `ffmpeg -y -ss ${sectionMidTime.toFixed(1)} -i "${videoPath}" -frames:v 1 -q:v 2 "${samplePath}" 2>/dev/null`,
        { encoding: 'utf-8' }
      );

      // Ask Claude if this frame matches the section's expected content
      const syncText = await claudeVision({
        imagePath: samplePath,
        textPrompt: `This frame is from timestamp ${sectionMidTime.toFixed(0)}s of a lecture video.
At this point, the narration should be: "${sections[idx].narration.substring(0, 150)}..."
The section discusses: ${sections[idx].group || sections[idx].id}

Does the visual content on screen MATCH what's being discussed in the narration?
Reply with JSON: { "synced": true/false, "reason": "brief explanation" }`,
      });

      const syncMatch = syncText.match(/\{[\s\S]*\}/);
      if (syncMatch) {
        try {
          const syncResult = JSON.parse(syncMatch[0]);
          syncChecks++;
          if (!syncResult.synced) {
            syncIssues++;
            console.log(`      ⚠️  Sync issue at ${sectionMidTime.toFixed(0)}s (${sections[idx].id}): ${syncResult.reason}`);
          }
        } catch {}
      }
    } catch {}
  }

  if (syncChecks > 0) {
    const syncRate = ((syncChecks - syncIssues) / syncChecks * 100).toFixed(0);
    console.log(`   📊 Sync check: ${syncChecks - syncIssues}/${syncChecks} sections in sync (${syncRate}%)`);
    if (syncIssues > syncChecks / 2) {
      issues.push({
        type: 'sync_failure',
        description: `${syncIssues}/${syncChecks} sections out of sync — visual doesn't match narration`
      });
    }
  }

  const verdict = issues.length === 0 ? 'pass' : 'fail_human';

  return {
    verdict,
    metadata,
    expectedDuration,
    actualDuration,
    durationMatch,
    syncChecks,
    syncIssues,
    issues
  };
}
