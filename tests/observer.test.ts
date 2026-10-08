// Fixture test for the read-only observer: synthetic Claude Code + Codex transcripts in a
// temp dir, incremental appends, then assertions. Also proves it never writes: every file
// under the watched dirs has the same hash and mtime before and after.
// usage: node --disable-warning=ExperimentalWarning tests/observer.test.ts
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptObserver } from '../src/observer.ts';

const root = mkdtempSync(join(tmpdir(), 'agent-boss-observer-'));
const claudeDir = join(root, 'claude', 'projects');
const codexDir = join(root, 'codex');
const repo = join(root, 'repo');
mkdirSync(join(repo, '.git'), { recursive: true });
mkdirSync(join(repo, 'pkg'), { recursive: true });

const now = new Date();
const iso = (msAgo = 0) => new Date(now.getTime() - msAgo).toISOString();
const jl = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';

// Claude Code session in <repo>/pkg, mid-tool, with a subagent and a sidechain message.
const cproj = join(claudeDir, 'C--repo-pkg');
mkdirSync(join(cproj, 'sess-claude', 'subagents'), { recursive: true });
const cfile = join(cproj, 'sess-claude.jsonl');
writeFileSync(
  cfile,
  jl(
    { type: 'custom-title', customTitle: 'Refatorar parser', sessionId: 'sess-claude' },
    { type: 'user', isSidechain: false, userType: 'external', turnOrigin: 'human', timestamp: iso(5000), cwd: join(repo, 'pkg'), gitBranch: 'feat/x', entrypoint: 'cli', version: '2.1.293', message: { role: 'user', content: 'refatora o parser' } },
    { type: 'assistant', isSidechain: false, timestamp: iso(4000), message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 90_000, output_tokens: 500 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'assistant', isSidechain: true, timestamp: iso(3000), message: { model: 'claude-haiku', usage: { input_tokens: 999_999 }, content: [] } },
  ),
);
writeFileSync(join(cproj, 'sess-claude', 'subagents', 'agent-1.jsonl'), '{}\n');

// Codex session in the same repo root, finished turn, with a child thread rollout.
const day = join(codexDir, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
mkdirSync(day, { recursive: true });
const pid = '01a11c32-3027-7803-bcfe-fb233dde17dc';
const xfile = join(day, `rollout-2026-10-08T12-46-53-${pid}.jsonl`);
writeFileSync(
  xfile,
  jl(
    { timestamp: iso(9000), type: 'session_meta', payload: { id: pid, cwd: repo, originator: 'Codex Desktop', cli_version: '0.162.0' } },
    { timestamp: iso(8900), type: 'turn_context', payload: { cwd: repo, model: 'gpt-6-astra', effort: 'medium' } },
    { timestamp: iso(8800), type: 'event_msg', payload: { type: 'task_started', model_context_window: 258_400 } },
    { timestamp: iso(8700), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'revisar o handoff' }] } } },
    { timestamp: iso(8600), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"rg -n handoff src"}))' } },
    { timestamp: iso(8500), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 92_109, cached_input_tokens: 80_000 }, model_context_window: 258_400 }, rate_limits: { primary: { used_percent: 42 } } } },
  ),
);
writeFileSync(join(day, `rollout-2026-10-08T12-50-00-${pid}_01a11c33-0000-7000-8000-000000000001.jsonl`), '{}\n');
mkdirSync(codexDir, { recursive: true });
writeFileSync(join(codexDir, 'session_index.jsonl'), jl({ id: pid, thread_name: 'Revisar handoff', updated_at: iso() }));

const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex') + '@' + statSync(p).mtimeMs;
    }
  };
  walk(dir);
  return out;
};

const events: string[] = [];
const bus = { emit: (_t: string, narration: string) => events.push(narration) } as any;
const obs = new TranscriptObserver(bus, {
  claudeDir,
  codexDir,
  intervalMs: 60_000,
  horizonMs: 12 * 3_600_000,
  activeMs: 90_000,
  stoppedMs: 30 * 60_000,
  knownWindow: () => null,
});

const results: Array<[string, boolean, unknown]> = [];
const check = (name: string, ok: boolean, got: unknown) => results.push([name, ok, got]);

// First scan, then append to both files and scan again (incremental tail).
const beforeScan1 = snapshot(root);
(obs as any).scan(true);
const afterScan1 = snapshot(root);
appendFileSync(cfile, jl({ type: 'user', isSidechain: false, userType: 'external', timestamp: iso(1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } }));
appendFileSync(cfile, jl({ type: 'assistant', isSidechain: false, timestamp: iso(500), message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 5, cache_read_input_tokens: 240_100, cache_creation_input_tokens: 2_000 }, content: [{ type: 'text', text: 'pronto' }] } }));
appendFileSync(xfile, jl({ timestamp: iso(100), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1' } }, { timestamp: iso(50), type: 'event_msg', payload: { type: 'task_complete' } }));
const afterAppend = snapshot(root);
(obs as any).scan(false);
const afterScan = snapshot(root);

const list = obs.list();
const c = list.find((s) => s.harness === 'claude-code')!;
const x = list.find((s) => s.harness === 'codex')!;
check('two sessions, one per harness', list.length === 2 && !!c && !!x, list.map((s) => s.harness));
check('claude title from custom-title', c.title === 'Refatorar parser', c.title);
check('claude ctx = input+cache_read+cache_creation of LAST main-thread message', c.ctxTokens === 242_105, c.ctxTokens);
check('claude sidechain usage ignored', c.ctxTokens !== 999_999, c.ctxTokens);
check('claude window inferred 1M (model seen past 200k)', c.ctxWindow === 1_000_000 && c.windowEstimated, [c.ctxWindow, c.windowEstimated]);
check('claude turn waiting after end_turn', c.turn === 'waiting', c.turn);
check('claude last tool', c.lastTool?.name === 'Bash' && c.lastTool.target === 'npm test', c.lastTool);
check('claude subagents counted', c.subagents === 1, c.subagents);
check('claude repo = git root above cwd', c.repo === repo, c.repo);
check('codex title from session_index', x.title === 'Revisar handoff', x.title);
check('codex ctx = last input_tokens, real window', x.ctxTokens === 92_109 && x.ctxWindow === 258_400 && !x.windowEstimated, [x.ctxTokens, x.ctxWindow]);
check('codex model+effort', x.model === 'gpt-6-astra (medium)', x.model);
check('codex tool target from code-mode exec', x.lastTool?.target === 'rg -n handoff src', x.lastTool);
check('codex turn waiting after task_complete', x.turn === 'waiting', x.turn);
check('codex child rollout folded as subagent', x.subagents === 1, x.subagents);
check('codex rate limit', x.rateLimitPct === 42, x.rateLimitPct);
check('same repo across harnesses', c.repo === x.repo, [c.repo, x.repo]);
check('both active', c.activity === 'active' && x.activity === 'active', [c.activity, x.activity]);
check('observer wrote nothing (scan 1: hashes+mtimes unchanged by the scan)', JSON.stringify(beforeScan1) === JSON.stringify(afterScan1), Object.keys(afterScan1).length);
check('observer wrote nothing (scan 2: hashes+mtimes unchanged by the scan)', JSON.stringify(afterAppend) === JSON.stringify(afterScan), Object.keys(afterScan).length);

rmSync(root, { recursive: true, force: true });
let failed = 0;
for (const [name, ok, got] of results) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)}`}`);
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
