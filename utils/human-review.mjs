/**
 * Human-in-the-Loop Review Interface
 *
 * When the pipeline hits a human review gate, it:
 *   1. Saves current state to disk
 *   2. Generates a review packet (screenshots, audio samples, QA reports)
 *   3. Launches a local review server OR prints to terminal
 *   4. Waits for human verdict via stdin or HTTP callback
 *
 * The pipeline can also be configured for async review:
 *   - Pipeline pauses and exits
 *   - Human reviews offline
 *   - Pipeline resumes with --resume flag
 */

import { createInterface } from 'readline';
import { writeFile } from 'fs/promises';
import { join } from 'path';

export class HumanReview {
  constructor(state, { conversationTracker } = {}) {
    this.state = state;
    this.conversationTracker = conversationTracker || null;
  }

  /**
   * Request human review for a section.
   * Returns: { approved: bool, feedback: string, action: 'approve'|'retry'|'skip'|'edit_narration' }
   */
  async reviewSection(section, qaReport) {
    const reviewPacket = {
      sectionId: section.id,
      sectionIndex: section.index,
      narration: section.narration,
      framePath: section.framePath,
      audioPath: section.audioPath,
      qaReport,
      retries: section.retries,
      retriesLeft: this.state.data.retryBudget[section.id] || 0
    };

    // Save review packet
    const packetPath = join(this.state.runDir, 'qa-reports', `review_${section.id}.json`);
    await writeFile(packetPath, JSON.stringify(reviewPacket, null, 2));

    console.log('\n' + '═'.repeat(60));
    console.log('🔍 HUMAN REVIEW REQUIRED');
    console.log('═'.repeat(60));
    console.log(`Section: ${section.id} (${section.index + 1}/${this.state.data.sections.length})`);
    console.log(`Frame:   ${section.framePath}`);
    console.log(`Audio:   ${section.audioPath}`);
    console.log(`Retries: ${section.retries} used, ${reviewPacket.retriesLeft} left`);

    if (qaReport) {
      console.log(`\nQA Issues:`);
      for (const issue of (qaReport.issues || [])) {
        console.log(`  ⚠️  ${issue.type}: ${issue.description}`);
      }
    }

    console.log(`\nNarration preview: "${section.narration.substring(0, 120)}..."`);
    console.log('');

    const result = await this.promptTerminal();

    // ── Record interaction for conversation monitoring ──
    if (this.conversationTracker) {
      this.conversationTracker.recordInteraction(
        section.id, result.action, result.feedback
      );
    }

    return result;
  }

  /**
   * Batch review at a checkpoint (every N sections).
   */
  async checkpointReview(completedSections) {
    console.log('\n' + '═'.repeat(60));
    console.log('📋 CHECKPOINT REVIEW');
    console.log('═'.repeat(60));
    console.log(`Completed ${completedSections.length} sections so far:\n`);

    for (const sec of completedSections) {
      const emoji = sec.status === 'qa_pass' || sec.status === 'approved' ? '✅' : '⚠️';
      console.log(`  ${emoji} ${sec.id} — ${sec.audioDuration?.toFixed(1)}s — retries: ${sec.retries}`);
    }

    console.log('');
    return await this.promptTerminal();
  }

  /**
   * Final review before assembly.
   */
  async preAssemblyReview() {
    const sections = this.state.data.sections;
    const passed = sections.filter(s => s.status === 'qa_pass' || s.status === 'approved');
    const failed = sections.filter(s => s.status === 'qa_fail');
    const totalDuration = sections.reduce((sum, s) => sum + (s.audioDuration || 0), 0);

    console.log('\n' + '═'.repeat(60));
    console.log('🎬 PRE-ASSEMBLY REVIEW');
    console.log('═'.repeat(60));
    console.log(`Total sections: ${sections.length}`);
    console.log(`Passed QA:      ${passed.length}`);
    console.log(`Failed QA:      ${failed.length}`);
    console.log(`Est. duration:  ${(totalDuration / 60).toFixed(1)} minutes`);

    if (failed.length > 0) {
      console.log(`\nFailed sections:`);
      for (const sec of failed) {
        console.log(`  ❌ ${sec.id}`);
      }
    }

    console.log('');
    return await this.promptTerminal();
  }

  async promptTerminal() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = (question) => new Promise(res => rl.question(question, res));

    console.log('Actions:');
    console.log('  [a] Approve and continue');
    console.log('  [r] Retry this section');
    console.log('  [s] Skip this section');
    console.log('  [e] Edit narration (opens $EDITOR)');
    console.log('  [f] Give feedback / ask a question');
    console.log('  [q] Pause pipeline (resume later with --resume)');
    console.log('');

    const answer = await ask('Your choice: ');
    const choice = answer.trim().toLowerCase();

    let action, approved, feedback;

    switch (choice) {
      case 'a': action = 'approve'; approved = true; feedback = ''; break;
      case 'r': action = 'retry'; approved = false; feedback = 'Human requested retry'; break;
      case 's': action = 'skip'; approved = true; feedback = 'Skipped by human'; break;
      case 'e': action = 'edit_narration'; approved = false; feedback = 'Narration edit requested'; break;
      case 'f': action = 'feedback'; approved = false; feedback = ''; break;
      case 'q': action = 'pause'; approved = false; feedback = 'Pipeline paused by human'; break;
      default:  action = 'approve'; approved = true; feedback = ''; break;
    }

    // For feedback, retry, or any action — offer to capture free-text
    if (choice === 'f' || choice === 'r' || choice === 'e') {
      const text = await ask('Your feedback/question (or press Enter to skip): ');
      feedback = text.trim() || feedback;
    }

    rl.close();
    return { action, approved, feedback };
  }
}
