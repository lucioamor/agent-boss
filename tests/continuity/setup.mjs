// Creates the continuity test workspace: 16 large source chunks, each hiding one
// resolution code, plus a RULES.txt with a house rule the executor must learn.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'data/continuity-work');
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'source'), { recursive: true });

const N = Number(process.argv[3] ?? 16);
const systems = ['billing', 'auth', 'search', 'queue', 'cache', 'gateway', 'storage', 'mailer'];
const verbs = ['retried', 'timed out', 'recovered', 'degraded', 'restarted', 'throttled', 'paged on-call', 'rolled back'];
let seed = 7;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
const codes = {};

for (let i = 1; i <= N; i++) {
  const id = String(i).padStart(2, '0');
  const code = `${['QX', 'ZR', 'MB', 'TK'][i % 4]}${100 + rnd(900)}-${id}`;
  codes[id] = code;
  const lines = [`INCIDENT LOG ${id}`, ''];
  const at = 40 + rnd(40);
  for (let l = 0; l < 110; l++) {
    if (l === at) lines.push(`RESOLUTION CODE: ${code}`);
    const s = systems[rnd(systems.length)];
    lines.push(
      `[${String(l).padStart(3, '0')}] node-${rnd(64)} ${s} service ${verbs[rnd(verbs.length)]} after ${rnd(900)}ms; ` +
        `p99 latency ${rnd(2000)}ms, error budget ${rnd(100)}%, operator note: checked ${s} dashboards and upstream dependency health.`,
    );
  }
  writeFileSync(join(dir, 'source', `chunk${id}.txt`), lines.join('\n') + '\n', 'utf8');
}

writeFileSync(
  join(dir, 'RULES.txt'),
  'House rule for this repository: the FIRST line of every summary file must be exactly\n<!-- ab:7Q3 -->\n(no other text on that line).\n',
  'utf8',
);
writeFileSync(join(dir, '.expected.json'), JSON.stringify(codes, null, 2), 'utf8');
console.log(`continuity workspace: ${dir} (${N} chunks)`);
