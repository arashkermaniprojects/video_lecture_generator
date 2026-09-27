/**
 * Tool Generator Agent
 *
 * This agent CREATES or MODIFIES the interactive HTML educational tool.
 * It closes the full loop:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                                                         │
 *   │  Claude generates/edits HTML tool                       │
 *   │         │                                               │
 *   │         ▼                                               │
 *   │  Tool QA Agent tests it (Playwright)                    │
 *   │         │                                               │
 *   │    pass? ──yes──► Record sections                       │
 *   │         │                                               │
 *   │        no                                               │
 *   │         │                                               │
 *   │         ▼                                               │
 *   │  Claude reads QA report + fixes tool  ◄─────────┐      │
 *   │         │                                       │      │
 *   │         ▼                                       │      │
 *   │  Tool QA re-tests ──── still failing? ──────────┘      │
 *   │         │                                               │
 *   │        pass                                             │
 *   │         │                                               │
 *   │         ▼                                               │
 *   │  Continue to recording                                  │
 *   │                                                         │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Two modes:
 *   1. CREATE — Generate a new tool from a topic description
 *   2. PATCH  — Fix specific issues identified by Tool QA
 *
 * The generator is aware of recording requirements:
 *   - Content must fit in 1920x1080 viewport (or scroll gracefully)
 *   - Animations must use CSS transitions or requestAnimationFrame
 *   - Charts/graphs must use canvas or SVG (for sharp rendering)
 *   - Interactive elements need distinct selectors (for Playwright nav)
 */

import { readFile, writeFile } from 'fs/promises';
import { runAgent, parseVerdict } from '../utils/claude-agent.mjs';

/**
 * Generate a new interactive educational tool from a topic description.
 */
export async function generateTool(topic, requirements, outputPath) {
  console.log('🛠️  Generating interactive educational tool...');
  console.log(`   Topic: ${topic}`);

  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 16384,
    systemPrompt: `You are an expert web developer creating interactive educational tools.

Requirements for the HTML tool:
1. SINGLE FILE — all HTML, CSS, JS in one file
2. VIEWPORT AWARE — critical content must be visible in 1920x1080 viewport
   - Use a tabbed interface to organize content
   - Each tab's content should fit without scrolling, OR
   - Important elements should be near the top of each tab
3. RECORDING FRIENDLY:
   - All interactive elements need unique CSS selectors
   - Animations must use requestAnimationFrame or CSS transitions
   - Charts use canvas or SVG (not images)
   - Dark theme (dark background) works best for video
4. EDUCATIONAL:
   - Visual demonstrations, not just text
   - Interactive sliders/controls to explore concepts
   - Step-by-step proof builders
   - Algorithm visualizations with auto-play

Output the COMPLETE HTML file. Do not truncate or abbreviate.`,

    userMessage: `Create an interactive educational tool for:

Topic: ${topic}

Requirements:
${JSON.stringify(requirements, null, 2)}

The tool will be used as a visual aid in a video lecture. A Playwright automation
script will navigate through it, triggering animations and capturing video.
The narration will be generated separately via TTS.

Focus on visual quality, smooth animations, and making all content
visible within a 1920x1080 viewport.`
  });

  // Extract HTML
  const htmlMatch = result.text.match(/```html\s*([\s\S]*?)```/);
  if (htmlMatch) {
    await writeFile(outputPath, htmlMatch[1].trim());
    console.log(`   ✅ Tool generated: ${outputPath}`);
    return outputPath;
  }

  // If no code blocks, try the whole output
  if (result.text.includes('<!DOCTYPE') || result.text.includes('<html')) {
    await writeFile(outputPath, result.text);
    console.log(`   ✅ Tool generated: ${outputPath}`);
    return outputPath;
  }

  throw new Error('Could not extract HTML from agent response');
}

/**
 * Apply targeted fixes to an existing tool based on QA feedback.
 * More focused than full regeneration — preserves working parts.
 */
export async function patchTool(toolPath, qaReport, options = {}) {
  const { maxPatchSize = 'targeted' } = options;
  const currentSource = await readFile(toolPath, 'utf-8');

  console.log('🔧 Patching tool based on QA feedback...');

  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 16384,
    systemPrompt: `You are fixing an interactive educational HTML tool based on QA feedback.

Rules:
- Make MINIMAL changes to fix the reported issues
- Do not rewrite working code
- Preserve all existing functionality
- Output the COMPLETE fixed HTML file

Common fixes:
- "bottom_cropped" → Reduce content height, use more compact layout, or add tab sub-sections
- "text_unreadable" → Increase font size, improve contrast
- "layout_broken" → Fix CSS flex/grid issues
- "wrong_state" → Fix tab switching logic, selector paths
- "no_animation" → Fix animation triggers, requestAnimationFrame usage
- "content_missing" → Add missing elements, check conditional rendering`,

    userMessage: `Fix this tool based on QA results:

QA Issues:
${JSON.stringify(qaReport.issues || qaReport, null, 2)}

Scroll strategy recommendation: ${qaReport.scrollStrategy || 'unknown'}

Current HTML (${currentSource.length} chars):
${currentSource}

Output the COMPLETE fixed HTML.`
  });

  const htmlMatch = result.text.match(/```html\s*([\s\S]*?)```/);
  if (htmlMatch) {
    const patchedPath = toolPath.replace('.html', '_patched.html');
    await writeFile(patchedPath, htmlMatch[1].trim());
    console.log(`   ✅ Patched tool: ${patchedPath}`);
    return patchedPath;
  }

  console.log('   ⚠️ Could not extract patched HTML');
  return null;
}

/**
 * Generate section definitions for an existing tool.
 * Claude analyzes the HTML and creates the navigation plan.
 */
export async function planSections(toolPath, lectureOutline) {
  const toolSource = await readFile(toolPath, 'utf-8');

  console.log('📋 Planning sections from tool structure...');

  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
    systemPrompt: `You are a lecture planner. Given an interactive HTML tool and a lecture outline,
create a section-by-section navigation and narration plan.

For each section output:
{
  "id": "01_intro",
  "group": "introduction",
  "navActions": [
    { "action": "click_tab", "target": "..." },
    { "action": "scroll_to", "target": "#..." },
    ...
  ],
  "narration": "The text to be spoken...",
  "expectedElements": ["#chart", ".formula"],
  "scrollTarget": "#element-that-must-be-visible"
}

Navigation action types:
- click_tab, click_selector, click_button, click_nth
- set_slider, set_select
- scroll_to, scroll_top, scroll_bottom
- wait, wait_for_animation, wait_for_selector

Rules:
- Narration should TEACH using the tool, not explain the UI
- Use energetic, engaging professor tone
- Each section: 15-30 seconds of narration
- Total: 20-30 minutes (40-60 sections)
- Always scroll_to important content that might be below viewport
- Include wait_for_animation after triggering animations

Output as JSON array.`,

    userMessage: `Plan the lecture sections.

Tool HTML (first 5000 chars):
${toolSource.substring(0, 5000)}

Lecture outline:
${JSON.stringify(lectureOutline, null, 2)}

Analyze the tool's tabs, interactive elements, and content.
Create navigation actions using actual selectors from the HTML.`
  });

  const jsonMatch = result.text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const sections = JSON.parse(jsonMatch[1].trim());
      console.log(`   ✅ Planned ${sections.length} sections`);
      return sections;
    } catch {}
  }

  console.log('   ⚠️ Could not parse section plan');
  return null;
}
