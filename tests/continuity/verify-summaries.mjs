// Supervisor-side check for the continuity task: every summaryNN.md exists, starts with
// the house-rule marker and carries the right resolution code.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';
const expected = JSON.parse(readFileSync(join(dir, '.expected.json'), 'utf8'));
const bad = [];
for (const [id, code] of Object.entries(expected)) {
  const f = join(dir, `summary${id}.md`);
  if (!existsSync(f)) { bad.push(`summary${id}.md missing`); continue; }
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  if (lines[0].trim() !== '<!-- ab:7Q3 -->') bad.push(`summary${id}.md: first line is not the marker`);
  if (!lines.some((l) => l.includes(code))) bad.push(`summary${id}.md: missing code ${code}`);
}
if (bad.length) { console.log(bad.join('\n')); console.log(`FAIL ${bad.length} problem(s)`); process.exit(1); }
console.log(`OK ${Object.keys(expected).length} summaries verified`);
