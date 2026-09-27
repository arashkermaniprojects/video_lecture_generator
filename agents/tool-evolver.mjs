/**
 * Tool Evolver Agent
 *
 * The agent that MODIFIES the interactive HTML tool based on
 * pedagogical feedback from the Teaching Evaluator + Student Simulator.
 *
 * This is NOT simple bug-fixing (that's tool-qa.mjs / tool-generator.mjs).
 * This is PEDAGOGICAL EVOLUTION — the tool gets smarter as a teaching aid.
 *
 * Evolution types:
 *
 *   ADD_FEATURE
 *     "Sam (struggling) can't see which line is f(n) — add labels"
 *     "Jordan (average) needs to see n=100 to understand — add concrete example mode"
 *
 *   ADD_ANIMATION
 *     "Students can't see the algorithm working — add step-by-step animation"
 *     "The recursion tree should grow node by node, not appear all at once"
 *
 *   ADD_INTERACTION
 *     "Add a slider for n so students can see how complexity grows"
 *     "Let students click on a node in the recursion tree to see its computation"
 *
 *   MODIFY_VIEW
 *     "Show the formula AND the graph side by side, not in separate tabs"
 *     "The proof steps should highlight which part of the graph they correspond to"
 *
 *   ADD_SCAFFOLD
 *     "Before showing the formal definition, show 3 concrete examples"
 *     "Add a 'why does this matter?' callout before the proof"
 *
 *   SIMPLIFY
 *     "Too many elements on screen — progressive disclosure"
 *     "Break this complex view into two simpler sub-views"
 *
 * The evolver:
 *   1. Reads the current HTML tool source
 *   2. Reads the evolution requirements (from Teaching Evaluator)
 *   3. Plans the minimal changes needed
 *   4. Makes the changes
 *   5. The updated tool goes back through Tool QA + Teaching Eval
 *
 * Evolution is INCREMENTAL — each pass makes targeted improvements.
 * The pipeline runs evolution cycles until:
 *   - All sections pass pedagogy eval, OR
 *   - Max evolution cycles reached (default: 3), OR
 *   - Human decides to stop
 */

import { readFile, writeFile, copyFile } from 'fs/promises';
import { join } from 'path';
import { runAgent, parseVerdict } from '../utils/claude-agent.mjs';

/**
 * Plan tool evolution changes based on aggregated feedback.
 * Groups related requirements and prioritizes.
 */
export async function planEvolution(toolPath, evolutionRequirements, currentVersion = 1) {
  const toolSource = await readFile(toolPath, 'utf-8');

  console.log(`\n🧬 Planning tool evolution (v${currentVersion} → v${currentVersion + 1})...`);
  console.log(`   ${evolutionRequirements.length} evolution requirement(s) from pedagogy eval`);

  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
    systemPrompt: `You are a senior educational software architect. You plan MINIMAL,
TARGETED changes to an interactive HTML teaching tool based on classroom feedback.

Principles:
1. MINIMAL CHANGES — Don't rewrite the whole tool. Touch only what's needed.
2. BACKWARD COMPATIBLE — Existing sections must still work after changes.
3. ADDITIVE — Prefer adding new views/modes over modifying existing ones.
4. SELECTOR STABLE — Don't change CSS class names or IDs that navigation depends on.
5. PEDAGOGICALLY MOTIVATED — Every change must serve a teaching purpose.

For each change, specify:
- What HTML/CSS/JS to add or modify
- Where in the file (which section/component)
- What existing behavior to preserve
- What new navigation actions become available`,

    userMessage: `Plan evolution for this tool:

Current tool: ${toolPath} (${toolSource.length} chars, v${currentVersion})

Evolution requirements (from student simulation + teaching evaluation):
${JSON.stringify(evolutionRequirements, null, 2)}

Tool structure (first 3000 chars):
${toolSource.substring(0, 3000)}

Output a JSON evolution plan:
\`\`\`json
{
  "version": ${currentVersion + 1},
  "changes": [
    {
      "id": "change_1",
      "type": "add_feature|add_animation|add_interaction|modify_view|add_scaffold|simplify",
      "description": "what changes",
      "reason": "which student need it serves",
      "affectedSections": ["section_ids"],
      "newNavActions": [{ "action": "...", "target": "..." }],
      "risk": "low|medium|high",
      "estimatedLines": 50
    }
  ],
  "totalEstimatedLines": 200,
  "breakingChanges": ["list of nav actions that might break"],
  "newCapabilities": ["list of new things the tool can now demonstrate"]
}
\`\`\``
  });

  return parseVerdict(result.text) || {
    version: currentVersion + 1,
    changes: [],
    totalEstimatedLines: 0,
    breakingChanges: [],
    newCapabilities: []
  };
}

/**
 * Execute tool evolution — apply the planned changes.
 */
export async function evolveTool(toolPath, evolutionPlan, runDir) {
  const currentVersion = evolutionPlan.version - 1;
  const newVersion = evolutionPlan.version;

  console.log(`\n🧬 Evolving tool: v${currentVersion} → v${newVersion}`);
  console.log(`   ${evolutionPlan.changes.length} change(s) planned`);

  // Backup current version
  const backupPath = join(runDir, `tool_v${currentVersion}.html`);
  await copyFile(toolPath, backupPath);
  console.log(`   📦 Backed up v${currentVersion} to ${backupPath}`);

  const toolSource = await readFile(toolPath, 'utf-8');

  // Apply changes via Claude
  const result = await runAgent({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 32768,
    systemPrompt: `You are implementing specific, planned changes to an interactive HTML educational tool.

CRITICAL RULES:
1. Output the COMPLETE HTML file — do not truncate or use "..." placeholders
2. Preserve ALL existing functionality — nothing should break
3. Keep all existing CSS class names and IDs — navigation scripts depend on them
4. Add new features as NEW elements/modes, don't replace existing ones
5. Use progressive disclosure — new features should be accessible but not overwhelming
6. All new interactive elements need unique, descriptive CSS selectors
7. New animations must use requestAnimationFrame or CSS transitions
8. Dark theme (dark backgrounds) must be maintained for video recording quality
9. Content must work in a 1920x1080 viewport

Output only the HTML. No explanations before or after.`,

    userMessage: `Apply these evolution changes to the tool:

Evolution plan:
${JSON.stringify(evolutionPlan.changes, null, 2)}

Current HTML source (${toolSource.length} chars):
${toolSource}

Apply ALL planned changes. Output the COMPLETE updated HTML file.`
  });

  // Extract the HTML
  let newHtml = null;
  const htmlMatch = result.text.match(/```html\s*([\s\S]*?)```/);
  if (htmlMatch) {
    newHtml = htmlMatch[1].trim();
  } else if (result.text.includes('<!DOCTYPE') || result.text.includes('<html')) {
    newHtml = result.text.trim();
  }

  if (!newHtml) {
    console.log('   ❌ Could not extract evolved HTML');
    return { success: false, path: toolPath, version: currentVersion };
  }

  // Save evolved version
  const evolvedPath = toolPath.replace('.html', `_v${newVersion}.html`);
  await writeFile(evolvedPath, newHtml);

  console.log(`   ✅ Evolved tool saved: ${evolvedPath}`);
  console.log(`   📏 Size: ${currentVersion}: ${toolSource.length} → v${newVersion}: ${newHtml.length} chars`);

  return {
    success: true,
    path: evolvedPath,
    version: newVersion,
    sizeChange: newHtml.length - toolSource.length,
    backupPath
  };
}

/**
 * Update section navigation actions after tool evolution.
 * Some sections may need new nav actions to use new features.
 */
export async function updateSectionsForEvolution(sections, evolutionPlan) {
  const updatedSections = [...sections];

  for (const change of evolutionPlan.changes) {
    if (change.newNavActions && change.affectedSections) {
      for (const sectionId of change.affectedSections) {
        const section = updatedSections.find(s => s.id === sectionId);
        if (section) {
          // Append new nav actions (don't replace existing ones)
          section.navActions = [
            ...section.navActions,
            ...change.newNavActions
          ];
          section._evolutionNote = `Updated by change ${change.id}: ${change.description}`;
        }
      }
    }
  }

  return updatedSections;
}

/**
 * Run the full evolution cycle:
 *   evaluate → plan → evolve → re-evaluate
 *
 * Returns when pedagogy passes or max cycles exhausted.
 */
export async function runEvolutionCycle(state, page, evaluateCallback, maxCycles = 3) {
  let currentCycle = 0;
  let toolPath = state.data.toolPath;

  while (currentCycle < maxCycles) {
    currentCycle++;
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  🧬 EVOLUTION CYCLE ${currentCycle}/${maxCycles}`);
    console.log(`${'═'.repeat(50)}`);

    // Step 1: Evaluate current tool
    const evalResult = await evaluateCallback(toolPath);

    if (evalResult.summary.evolveTool === 0) {
      console.log(`\n   ✅ All sections pass pedagogy evaluation!`);
      return { toolPath, cycles: currentCycle, success: true };
    }

    console.log(`   ${evalResult.summary.evolveTool} section(s) need tool evolution`);

    // Step 2: Plan evolution
    const plan = await planEvolution(
      toolPath,
      evalResult.evolutionRequirements,
      currentCycle
    );

    if (plan.changes.length === 0) {
      console.log(`   ℹ️ No actionable changes identified. Stopping evolution.`);
      return { toolPath, cycles: currentCycle, success: false, reason: 'no_changes' };
    }

    // Step 3: Evolve tool
    const evolution = await evolveTool(toolPath, plan, state.runDir);

    if (!evolution.success) {
      console.log(`   ❌ Evolution failed. Keeping v${currentCycle}.`);
      return { toolPath, cycles: currentCycle, success: false, reason: 'evolution_failed' };
    }

    // Step 4: Update state
    toolPath = evolution.path;
    state.data.toolPath = toolPath;
    state.addLog('tool_evolved', {
      cycle: currentCycle,
      version: evolution.version,
      changes: plan.changes.length
    });
    await state.save();

    // Step 5: Reload tool in browser
    await page.goto(`file://${toolPath}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    console.log(`   🔄 Tool evolved to v${evolution.version}. Re-evaluating...`);
  }

  console.log(`\n   ⚠️ Max evolution cycles (${maxCycles}) reached.`);
  return { toolPath, cycles: maxCycles, success: false, reason: 'max_cycles' };
}
