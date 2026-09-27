/**
 * Audiobook generator for agentic_system_theory.tex
 *
 * 1. Parses the LaTeX source into sections
 * 2. Cleans each section for speech (removes code, math, TikZ, citations)
 * 3. Generates TTS audio per section using OpenAI nova voice
 * 4. Concatenates all segments into a single MP3 audiobook
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { generateTTS } from '../agents/tts-agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEX_PATH  = join(__dirname, 'agentic_system_theory.tex');
const OUT_DIR   = join(__dirname, 'audiobook_segments');
const FINAL_MP3 = join(__dirname, 'agentic_system_audiobook.mp3');

// ── Step 1: Parse LaTeX into sections ──────────────────────────────────────

function parseLatexSections(tex) {
  const sections = [];

  // Strip preamble (everything before \begin{document})
  const docStart = tex.indexOf('\\begin{document}');
  if (docStart === -1) throw new Error('No \\begin{document} found');
  tex = tex.slice(docStart + '\\begin{document}'.length);

  // Strip title page, TOC
  tex = tex.replace(/\\begin\{titlepage\}[\s\S]*?\\end\{titlepage\}/g, '');
  tex = tex.replace(/\\tableofcontents[\s\S]*?\\newpage/g, '');
  tex = tex.replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, '');
  tex = tex.replace(/\\end\{document\}/g, '');

  // Split on \section, \subsection etc.
  const sectionRe = /\\(section|subsection|subsubsection)\*?\{([^}]+)\}/g;
  let lastIndex = 0;
  let lastTitle = 'Introduction';
  let lastLevel = 'section';
  let match;

  while ((match = sectionRe.exec(tex)) !== null) {
    const body = tex.slice(lastIndex, match.index);
    if (body.trim()) {
      sections.push({ title: lastTitle, level: lastLevel, body });
    }
    lastTitle = match[2];
    lastLevel = match[1];
    lastIndex = match.index + match[0].length;
  }
  // Last section
  const tail = tex.slice(lastIndex);
  if (tail.trim()) {
    sections.push({ title: lastTitle, level: lastLevel, body: tail });
  }

  return sections;
}

// ── Step 2: Clean LaTeX for speech ─────────────────────────────────────────

function cleanForSpeech(title, body) {
  let text = body;

  // Remove entire environments not suitable for audio
  const removeEnvs = [
    'tikzpicture', 'figure', 'lstlisting', 'table', 'tabular',
    'mdframed', 'thebibliography'
  ];
  for (const env of removeEnvs) {
    const re = new RegExp(
      `\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, 'g'
    );
    text = text.replace(re, '');
  }

  // Replace common LaTeX constructs with readable equivalents
  text = text
    .replace(/\\textbf\{([^}]+)\}/g, '$1')
    .replace(/\\textit\{([^}]+)\}/g, '$1')
    .replace(/\\emph\{([^}]+)\}/g, '$1')
    .replace(/\\texttt\{([^}]+)\}/g, '$1')
    .replace(/\\small\b/g, '')
    .replace(/\\normalsize\b/g, '')
    .replace(/\\large\b/g, '')
    .replace(/\\Large\b/g, '')
    .replace(/\\caption\{([^}]+)\}/g, 'Figure caption: $1.')
    .replace(/\\label\{[^}]+\}/g, '')
    .replace(/\\ref\{[^}]+\}/g, 'the referenced section')
    .replace(/\\cite\{[^}]+\}/g, '')
    .replace(/\\footnote\{([^}]+)\}/g, '. Note: $1.')
    .replace(/\\item\s*/g, '. ')
    .replace(/\\begin\{(itemize|enumerate|description)\}/g, '')
    .replace(/\\end\{(itemize|enumerate|description)\}/g, '')
    .replace(/\\begin\{[^}]+\}/g, '')
    .replace(/\\end\{[^}]+\}/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, ' — see the written formula — ')
    .replace(/\$[^$]+\$/g, (m) => {
      // Try to make simple math readable
      return m
        .replace(/\$/g, '')
        .replace(/\\times/g, 'times')
        .replace(/\\approx/g, 'approximately')
        .replace(/\\leq/g, 'less than or equal to')
        .replace(/\\geq/g, 'greater than or equal to')
        .replace(/\\text\{([^}]+)\}/g, '$1')
        .replace(/\^/g, ' to the power of ')
        .replace(/_/g, ' sub ')
        .replace(/\{|\}/g, '');
    })
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')   // generic \cmd{arg} → arg
    .replace(/\\[a-zA-Z]+/g, '')                  // remaining commands
    .replace(/\{|\}/g, '')                         // bare braces
    .replace(/~~/g, ' ')
    .replace(/~/g, ' ')
    .replace(/``|''/g, '"')
    .replace(/`|'/g, "'")
    .replace(/---/g, ' — ')
    .replace(/--/g, ' to ')
    .replace(/\\\\/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  // Add section heading as spoken intro
  const levelIntro = {
    section:       'Section: ',
    subsection:    'Sub-section: ',
    subsubsection: '',
  };
  const intro = (levelIntro[title.level] || '') + title;
  return `${intro}.\n\n${text}`;
}

// ── Step 3: Main ────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  await mkdir(OUT_DIR, { recursive: true });

  console.log('📖 Parsing LaTeX source...');
  const tex = await readFile(TEX_PATH, 'utf-8');
  const rawSections = parseLatexSections(tex);
  console.log(`   Found ${rawSections.length} sections`);

  const segments = [];

  for (let i = 0; i < rawSections.length; i++) {
    const sec = rawSections[i];
    const slug = sec.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 40);
    const segPath = join(OUT_DIR, `${String(i+1).padStart(2,'0')}_${slug}.mp3`);

    if (existsSync(segPath)) {
      console.log(`   ⏭️  ${i+1}/${rawSections.length}: ${sec.title} (cached)`);
      segments.push(segPath);
      continue;
    }

    const spoken = cleanForSpeech(sec.title, sec.body);
    const wordCount = spoken.split(/\s+/).length;

    if (wordCount < 10) {
      console.log(`   ⏭️  ${i+1}/${rawSections.length}: ${sec.title} (too short, skipping)`);
      continue;
    }

    console.log(`   🎙️  ${i+1}/${rawSections.length}: ${sec.title} (~${wordCount} words)`);

    const result = await generateTTS(spoken, segPath, { apiKey, voice: 'onyx' });

    if (result.audioPath && existsSync(result.audioPath)) {
      console.log(`   ✅ ${result.duration?.toFixed(1) ?? '?'}s`);
      segments.push(segPath);
    } else {
      console.log(`   ❌ TTS failed for: ${sec.title}`);
    }
  }

  // ── Step 4: Concatenate all segments ──────────────────────────────────────
  console.log(`\n🔗 Concatenating ${segments.length} segments...`);
  const concatFile = join(OUT_DIR, 'concat.txt');
  const concatContent = segments.map(p => `file '${p}'`).join('\n');
  await writeFile(concatFile, concatContent);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -q:a 2 "${FINAL_MP3}"`,
    { stdio: 'pipe' }
  );

  const stat = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${FINAL_MP3}"`,
    { encoding: 'utf-8' }
  ).trim();
  const totalMin = (parseFloat(stat) / 60).toFixed(1);

  console.log(`\n✅ Audiobook complete!`);
  console.log(`   File:     ${FINAL_MP3}`);
  console.log(`   Segments: ${segments.length}`);
  console.log(`   Duration: ${totalMin} minutes`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
