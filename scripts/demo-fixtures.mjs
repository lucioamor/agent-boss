// Writes synthetic Claude Code transcripts and Codex rollouts so the board's "external
// sessions" strip can be demoed (and screenshotted) without exposing real sessions.
// usage: node scripts/demo-fixtures.mjs [outDir=data/demo]
//   then: node src/main.ts serve --port 7779 --observe-dir <out>/claude/projects --codex-dir <out>/codex
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'data/demo');
rmSync(out, { recursive: true, force: true });
const now = Date.now();
const iso = (secAgo) => new Date(now - secAgo * 1000).toISOString();
const jl = (xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';
const day = new Date(now);
const codexDay = join(out, 'codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
mkdirSync(codexDay, { recursive: true });

// File mtime must match the last record, or every demo session would look active.
const touch = (file, secAgo) => utimesSync(file, new Date(now - secAgo * 1000), new Date(now - secAgo * 1000));

const claude = (id, { title, cwd, branch, model, ctx, tool, ended, ago, origin = 'claude-desktop', subagents = 0 }) => {
  const dir = join(out, 'claude', 'projects', cwd.replace(/[:\\/]/g, '-'));
  mkdirSync(join(dir, id, 'subagents'), { recursive: true });
  for (let i = 0; i < subagents; i++) writeFileSync(join(dir, id, 'subagents', `agent-${i}.jsonl`), '{}\n');
  writeFileSync(
    join(dir, `${id}.jsonl`),
    jl([
      { type: 'custom-title', customTitle: title, sessionId: id },
      { type: 'user', isSidechain: false, userType: 'external', turnOrigin: 'human', timestamp: iso(ago + 300), cwd, gitBranch: branch, entrypoint: origin, version: '2.1.293', message: { role: 'user', content: title } },
      {
        type: 'assistant', isSidechain: false, timestamp: iso(ago),
        message: {
          model, stop_reason: ended ? 'end_turn' : 'tool_use',
          usage: { input_tokens: 4, cache_read_input_tokens: Math.round(ctx * 0.9), cache_creation_input_tokens: Math.round(ctx * 0.1) },
          content: ended ? [{ type: 'text', text: 'ok' }] : [{ type: 'tool_use', id: `tu-${id}`, name: tool[0], input: tool[1] }],
        },
      },
    ]),
  );
  touch(join(dir, `${id}.jsonl`), ago);
};

const codex = (id, { title, cwd, model, ctx, cmd, ended, ago, limit }) => {
  const file = join(codexDay, `rollout-2026-10-08T12-00-00-${id}.jsonl`);
  process.nextTick(() => touch(file, ago));
  writeFileSync(
    file,
    jl([
      { timestamp: iso(ago + 300), type: 'session_meta', payload: { id, cwd, originator: 'Codex Desktop', cli_version: '0.162.0' } },
      { timestamp: iso(ago + 290), type: 'turn_context', payload: { cwd, model, effort: 'medium' } },
      { timestamp: iso(ago + 280), type: 'event_msg', payload: { type: 'task_started', model_context_window: 258_400 } },
      { timestamp: iso(ago + 270), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: title }] } } },
      { timestamp: iso(ago + 10), type: 'response_item', payload: { type: 'function_call', call_id: `c-${id}`, name: 'shell', arguments: JSON.stringify({ command: cmd }) } },
      { timestamp: iso(ago + 5), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: ctx }, model_context_window: 258_400 }, rate_limits: { primary: { used_percent: limit } } } },
      ...(ended ? [{ timestamp: iso(ago), type: 'event_msg', payload: { type: 'task_complete' } }] : []),
    ]),
  );
};

claude('7f3c2a10-demo-0000-0000-000000000001', {
  title: 'Migrate payments API to the new ledger', cwd: 'C:\\src\\shop-api', branch: 'feat/ledger', model: 'claude-opus-5-5',
  ctx: 312_000, tool: ['Bash', { command: 'npm test -- ledger' }], ended: false, ago: 4, subagents: 2,
});
claude('7f3c2a10-demo-0000-0000-000000000002', {
  title: 'Fix flaky checkout e2e test', cwd: 'C:\\src\\web-store', branch: 'fix/checkout-e2e', model: 'claude-sonnet-5-5',
  ctx: 88_000, tool: ['Read', { file_path: 'C:\\src\\web-store\\e2e\\checkout.spec.ts' }], ended: true, ago: 420, origin: 'cli',
});
codex('01a11d00-0000-7000-8000-00000000d001', {
  title: 'Review ledger migration for race conditions', cwd: 'C:\\src\\shop-api', model: 'gpt-6-astra', ctx: 97_500,
  cmd: 'rg -n "SELECT .* FOR UPDATE" src', ended: false, ago: 20, limit: 38,
});
codex('01a11d00-0000-7000-8000-00000000d002', {
  title: 'Draft release notes for v2.4', cwd: 'C:\\src\\docs-site', model: 'gpt-6-astra', ctx: 41_200,
  cmd: 'git log --oneline v2.3..HEAD', ended: true, ago: 3_000, limit: 38,
});
writeFileSync(
  join(out, 'codex', 'session_index.jsonl'),
  jl([
    { id: '01a11d00-0000-7000-8000-00000000d001', thread_name: 'Review ledger migration for race conditions' },
    { id: '01a11d00-0000-7000-8000-00000000d002', thread_name: 'Draft release notes for v2.4' },
  ]),
);
console.log(`demo transcripts in ${out}`);
