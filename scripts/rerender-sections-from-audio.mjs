#!/usr/bin/env node

import { createServer } from 'http';
import { createReadStream, existsSync } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { parseArgs } from 'util';
import { chromium } from 'playwright';

import { PipelineState, SectionStatus } from '../utils/state.mjs';
import { recordSectionLive } from '../agents/recorder.mjs';
import { buildAnimationSegment, buildStaticSegment } from '../agents/assembler.mjs';

const { values } = parseArgs({
  options: {
    'run-dir': { type: 'string' },
    sections: { type: 'string' }
  }
});

if (!values['run-dir'] || !values.sections) {
  console.error('Usage: node scripts/rerender-sections-from-audio.mjs --run-dir <run-dir> --sections <id1,id2,...>');
  process.exit(1);
}

function startToolServer(toolPath) {
  const toolDir = dirname(toolPath);
  const toolFile = basename(toolPath);

  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      const urlPath = String(req.url || '/').split('?')[0].split('#')[0];
      const filePath = urlPath === '/' || urlPath === `/${toolFile}`
        ? toolPath
        : join(toolDir, urlPath.replace(/^\//, ''));
      const ext = filePath.split('.').pop().toLowerCase();
      const mimeTypes = {
        html: 'text/html',
        js: 'application/javascript',
        css: 'text/css',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        svg: 'image/svg+xml'
      };

      try {
        await stat(filePath);
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'text/plain',
          'Cache-Control': 'no-store'
        });
        createReadStream(filePath).pipe(res);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveServer({ server, url: `http://127.0.0.1:${port}/${toolFile}` });
    });
  });
}

async function main() {
  const runDir = resolve(values['run-dir']);
  const requestedIds = values.sections.split(',').map(id => id.trim()).filter(Boolean);
  const state = await PipelineState.resume(runDir);

  const toolServer = await startToolServer(state.data.toolPath);
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-infobars', '--hide-scrollbars']
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  await page.goto(toolServer.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  for (const sectionId of requestedIds) {
    const section = state.getSection(sectionId);
    if (!section) {
      console.warn(`Skipping unknown section: ${sectionId}`);
      continue;
    }
    if (!section.audioPath || !existsSync(section.audioPath)) {
      console.warn(`Skipping ${sectionId}: missing audio at ${section.audioPath}`);
      continue;
    }

    console.log(`Re-rendering ${sectionId} from existing audio...`);
    const recording = await recordSectionLive(
      page,
      section,
      join(runDir, 'frames'),
      Math.round((section.audioDuration || 15) * 1000)
    );

    const segmentPath = join(runDir, 'segments', `seg_${section.id}.mp4`);
    await mkdir(dirname(segmentPath), { recursive: true });

    if (recording.framePaths.length > 1) {
      buildAnimationSegment(recording.framePaths, section.audioPath, segmentPath, {});
    } else {
      buildStaticSegment(recording.framePaths[0], section.audioPath, segmentPath, {});
    }

    await state.updateSection(section.id, {
      framePath: recording.framePaths[0] || null,
      framePaths: recording.framePaths,
      segmentPath,
      status: SectionStatus.QA_PASS
    });
  }

  await browser.close();
  await new Promise(resolveClose => toolServer.server.close(resolveClose));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
