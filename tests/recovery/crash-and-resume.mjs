// Recovery test: start a task whose executor runs a slow command, kill the
// supervisor process while that tool is in flight, then run `resume --task <id>`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..', '..');
const work = join(root, 'data', 'recovery-work');
const db = join(root, 'data', 'recovery.db');
for (const f of [work, db, `${db}-wal`, `${db}-shm`, `${db}.lock`]) rmSync(f, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(
  join(work, 'slow-step.mjs'),
  [
    '// Simulates a long side-effecting step: after ~45s it writes result.txt.',
    "import { writeFileSync } from 'node:fs';",
    "setTimeout(() => { writeFileSync('result.txt', '21\\n'); console.log('wrote result.txt'); }, 45000);",
    '',
  ].join('\n'),
  'utf8',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const common = ['--disable-warning=ExperimentalWarning', join(root, 'src', 'main.ts')];
const opts = ['--db', db, '--tools', 'Read,Write,Glob,Bash', '--allow', 'Bash'];

const out1 = openSync(join(root, 'data', 'recovery-run.log'), 'w');
const sup = spawn(
  process.execPath,
  [
    ...common, 'run', ...opts, '--cwd', work,
    '--goal', 'Three steps, in order: (1) Write notes.txt containing the word started. (2) Run `node slow-step.mjs` with the Bash tool and wait for it (it takes about 45 seconds and creates result.txt). (3) Write final.txt containing the integer in result.txt multiplied by 2.',
    '--done', 'notes.txt, result.txt and final.txt exist and final.txt holds twice the number in result.txt.',
    '--constraint', 'Never run slow-step.mjs if result.txt already exists. When you run it, run exactly: node slow-step.mjs',
    '--constraint', 'Do one step per turn and end each turn with the checkpoint block.',
    '--verify', 'node -e "const f=require(\'fs\');const r=+f.readFileSync(\'result.txt\',\'utf8\');const v=+f.readFileSync(\'final.txt\',\'utf8\');if(v!==2*r){console.log(\'FAIL\',r,v);process.exit(1)}console.log(\'OK final=\'+v+\' result=\'+r)"',
  ],
  { cwd: root, stdio: ['ignore', out1, out1], windowsHide: true },
);
log(`supervisor pid ${sup.pid}`);

const q = (sql, ...p) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try { return d.prepare(sql).all(...p); } finally { d.close(); }
};

let inflight = null;
for (let i = 0; i < 600 && !inflight; i++) {
  await sleep(500);
  if (!existsSync(db)) continue;
  try {
    inflight = q(`SELECT * FROM ops WHERE tool = 'Bash' AND status = 'started' AND input LIKE '%slow-step%'`)[0] ?? null;
  } catch {}
}
if (!inflight) { log('never saw the slow Bash op in flight'); sup.kill(); process.exit(1); }
log(`in-flight op ${inflight.tool_use_id}: ${inflight.input}`);
await sleep(4000);

const before = q(`SELECT id, epoch, pid, phase FROM sessions WHERE phase != 'closed'`);
const taskId = q(`SELECT id FROM tasks`)[0].id;
log(`task ${taskId}; open sessions before kill:`, JSON.stringify(before));
// Kill ONLY the supervisor process (no /T): its executor is left behind as an orphan.
const k = spawnSync('taskkill', ['/PID', String(sup.pid), '/F'], { encoding: 'utf8' });
log(`taskkill supervisor: ${k.stdout.trim()}`);
await sleep(2000);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const s of before) log(`executor pid ${s.pid} alive after supervisor death: ${alive(s.pid)}`);
log('DB right after crash:', JSON.stringify(q(`SELECT id, phase, end_reason FROM sessions`)), JSON.stringify(q(`SELECT tool_use_id, tool, status FROM ops WHERE status = 'started'`)));

log(`running: resume --task ${taskId}`);
const r = spawnSync(process.execPath, [...common, 'resume', '--task', taskId, ...opts], { cwd: root, encoding: 'utf8', timeout: 15 * 60_000 });
writeFileSync(join(root, 'data', 'recovery-resume.log'), r.stdout + r.stderr, 'utf8');
log(`resume exit code ${r.status}`);
for (const s of before) log(`orphan executor pid ${s.pid} alive after resume: ${alive(s.pid)}`);
console.log(JSON.stringify({ taskId, orphanPids: before.map((s) => s.pid), inflightOp: inflight.tool_use_id }, null, 2));
