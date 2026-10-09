import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.ts';
import { EventBus } from './bus.ts';
import { Supervisor } from './supervisor.ts';
import { Orchestrator, type TaskSpec } from './orchestrator.ts';
import { startServer } from './server.ts';
import { TranscriptObserver } from './observer.ts';
import { homedir } from 'node:os';
import { acquireLock } from './lock.ts';
import { claudeCodeAdapter } from './executors/claude-code.ts';
import { codexAppServerAdapter } from './executors/codex-app-server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
agent-boss — keeps long agent work alive across disposable Claude Code sessions

  run     --goal <text> --done <criteria> --cwd <dir> [--constraint <text>]... [--verify <cmd>]
  resume  --task <id>                   continue an existing task from its last checkpoint
  batch   --file <tasks.json>           submit several tasks (independent ones run in parallel)
  serve                                 board + scheduler only (submit tasks via POST /api/tasks)

options:
  --model <alias>            default: sonnet
  --executor <claude|codex>  default: claude (codex is a stub)
  --handoff-ratio <0..1>     default: 0.5 of the context window reported by the CLI
  --handoff-tokens <n>       absolute budget, overrides ratio (testing)
  --parallel <n>             max executors at once, default: 3
  --permission-mode <mode>   default: acceptEdits
  --tools <list>             default: Read,Write,Edit,Glob,Grep,Bash
  --allow <rules>            pre-approved permission rules, passed to --allowedTools (e.g. "Bash(npm test:*)")
  --max-sessions <n>         per task, default: 12
  --max-turns <n>            per session, default: 30
  --db <path>                default: data/supervisor.db
  --port <n>                 default: 7777
  --keep-open                keep serving the board after the tasks settle
  --observe-dir <dir>        Claude Code transcripts to watch read-only, default: ~/.claude/projects
  --codex-dir <dir>          Codex home whose sessions/ are watched read-only, default: ~/.codex
  --no-observe               do not show external (non-supervised) Claude Code / Codex sessions
  --remote-root <dir>        allow hosted-board enqueue_task commands to run under <dir> (repeatable;
                             also AGENT_BOSS_REMOTE_ROOTS, path-delimited). Default: none, disabled.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    goal: { type: 'string' },
    done: { type: 'string' },
    cwd: { type: 'string' },
    verify: { type: 'string' },
    constraint: { type: 'string', multiple: true, default: [] },
    task: { type: 'string' },
    file: { type: 'string' },
    model: { type: 'string', default: 'sonnet' },
    executor: { type: 'string', default: 'claude' },
    'handoff-ratio': { type: 'string', default: '0.5' },
    'handoff-tokens': { type: 'string' },
    parallel: { type: 'string', default: '3' },
    'permission-mode': { type: 'string', default: 'acceptEdits' },
    tools: { type: 'string', default: 'Read,Write,Edit,Glob,Grep,Bash' },
    allow: { type: 'string', default: '' },
    'max-sessions': { type: 'string', default: '12' },
    'max-turns': { type: 'string', default: '30' },
    db: { type: 'string' },
    port: { type: 'string', default: '7777' },
    'keep-open': { type: 'boolean', default: false },
    'observe-dir': { type: 'string' },
    'codex-dir': { type: 'string' },
    'no-observe': { type: 'boolean', default: false },
    'remote-root': { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const cmd = positionals[0];
if (values.help || !cmd || !['run', 'resume', 'batch', 'serve'].includes(cmd)) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}

const port = Number(values.port);
const dbPath = resolve(values.db ?? join(root, 'data', 'supervisor.db'));
acquireLock(`${dbPath}.lock`);
const store = new Store(dbPath);
const bus = new EventBus(store);

const supervisor = new Supervisor(
  store,
  bus,
  {
    url: `http://127.0.0.1:${port}`,
    hookScript: join(root, 'src', 'hooks', 'pretool.ts'),
    handoffDir: join(dirname(dbPath), 'handoffs'),
    handoffRatio: Number(values['handoff-ratio']),
    handoffTokens: values['handoff-tokens'] ? Number(values['handoff-tokens']) : null,
    defaultWindow: 200_000,
    permissionMode: values['permission-mode']!,
    tools: values.tools!.split(',').map((s) => s.trim()).filter(Boolean),
    allowedTools: values.allow!.split(',').map((s) => s.trim()).filter(Boolean),
    maxSessions: Number(values['max-sessions']),
    maxTurnsPerSession: Number(values['max-turns']),
    turnTimeoutMs: 20 * 60_000,
    drainTimeoutMs: 3 * 60_000,
    verifyTimeoutMs: 2 * 60_000,
  },
  [claudeCodeAdapter, codexAppServerAdapter],
);

// Anything a dead predecessor left running is closed before we accept work.
supervisor.recoverAfterRestart();

const orchestrator = new Orchestrator(store, bus, supervisor, Number(values.parallel));
// Read-only view of the user's own Claude Code sessions (not supervised, not controllable).
const observer = values['no-observe']
  ? null
  : new TranscriptObserver(bus, {
      claudeDir: values['observe-dir'] ?? join(homedir(), '.claude', 'projects'),
      codexDir: values['codex-dir'] ?? join(homedir(), '.codex'),
      intervalMs: 3_000,
      horizonMs: 12 * 3_600_000,
      activeMs: 90_000,
      stoppedMs: 30 * 60_000,
      knownWindow: (m) => supervisor.windowFor(m),
    });
observer?.start();

// Under src/daemon.ts, exit code 75 means "start me again"; 0 means "stay stopped".
const RESTART_EXIT = 75;
const daemonPid = process.env.AGENT_BOSS_DAEMON ? Number(process.env.AGENT_BOSS_DAEMON) : null;
let stoppingNow = false;
async function stopServer(action: 'restart' | 'stop') {
  if (stoppingNow) return;
  stoppingNow = true;
  bus.emit('supervisor.note', action === 'restart' ? 'Reinício do servidor pedido pelo board.' : 'Parada do servidor pedida pelo board.', { data: { action } });
  observer?.stop();
  await supervisor.shutdown(action === 'restart' ? 'supervisor restart requested' : 'supervisor stop requested');
  await orchestrator.drain();
  server.close();
  server.closeAllConnections?.();
  process.exit(action === 'restart' && daemonPid ? RESTART_EXIT : 0);
}

const server = await startServer({
  port,
  store,
  bus,
  supervisor,
  orchestrator,
  observer,
  publicDir: join(root, 'public'),
  defaults: { model: values.model! },
  remoteRoots: [...(values['remote-root'] as string[]), ...(process.env.AGENT_BOSS_REMOTE_ROOTS ?? '').split(delimiter)].filter(Boolean).map((d) => resolve(d)),
  admin: { daemonPid, request: (action) => void stopServer(action) },
  startedAt: new Date().toISOString(),
});
console.log(`board: http://127.0.0.1:${port}  (pid ${process.pid}${daemonPid ? `, daemon ${daemonPid}` : ''})`);

process.on('SIGINT', () => void stopServer('stop'));
process.on('SIGTERM', () => void stopServer('stop'));

const targets: string[] = [];
// run/resume/batch only schedule their own tasks; serve schedules the whole queue.
const scope = new Set<string>();
if (cmd !== 'serve') orchestrator.scope = scope;
const track = (id: string) => (targets.push(id), scope.add(id));
if (cmd === 'run') {
  if (!values.goal || !values.done || !values.cwd) {
    console.error('run requires --goal, --done and --cwd');
    process.exit(1);
  }
  const t = orchestrator.submit(
    {
      goal: values.goal,
      done: values.done,
      cwd: resolve(values.cwd),
      constraints: values.constraint as string[],
      verify: values.verify,
      executor: values.executor as TaskSpec['executor'],
    },
    { model: values.model! },
  );
  console.log(`task ${t.id}`);
  track(t.id);
} else if (cmd === 'resume') {
  if (!values.task) {
    console.error('resume requires --task');
    process.exit(1);
  }
  track(values.task);
  orchestrator.requeue(values.task);
} else if (cmd === 'batch') {
  if (!values.file) {
    console.error('batch requires --file');
    process.exit(1);
  }
  const specs = JSON.parse(readFileSync(values.file, 'utf8')) as { tasks: TaskSpec[] };
  const base = dirname(resolve(values.file));
  for (const spec of specs.tasks) {
    const t = orchestrator.submit({ ...spec, cwd: resolve(base, spec.cwd) }, { model: values.model! });
    console.log(`task ${t.id}: ${spec.goal.slice(0, 60)}`);
    track(t.id);
  }
}

orchestrator.tick();

if (targets.length) {
  await orchestrator.waitFor(targets);
  const summary = targets.map((id) => `${id}: ${store.getTask(id)?.status}`).join(', ');
  console.log(`settled: ${summary}`);
  if (!values['keep-open']) {
    server.close();
    const ok = targets.every((id) => store.getTask(id)?.status === 'done');
    process.exit(ok ? 0 : 2);
  }
}
