import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, 'agentic_system_theory.html');
const pdfPath  = resolve(__dirname, 'agentic_system_theory.pdf');

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--no-sandbox']
});
const page = await browser.newPage();
await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '2cm', bottom: '2cm', left: '2.5cm', right: '2.5cm' }
});

await browser.close();
console.log(`PDF written to: ${pdfPath}`);
