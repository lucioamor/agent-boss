// Pairing + sync test for src/cloud.ts against a fake hosted board (local HTTP server).
// Covers: PKCE exchange, state check, token saved, push, command long-poll + ack, revoke on 401.
// usage: node --disable-warning=ExperimentalWarning tests/cloud.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudLink, type CloudCommand } from '../src/cloud.ts';

const TOKEN = 'abk_' + 'a'.repeat(64);
let challenge = '';
let tokenValid = true;
const pushes: Array<{ state: Record<string, unknown>; events: unknown[] }> = [];
const acks: Array<{ id: string; ok: boolean; result: string }> = [];
let queued: CloudCommand[] = [{ id: 'c1', kind: 'pause', task_id: 't1', payload: {} }];

const cloud = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const send = (s: number, o: unknown) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
  const authed = req.headers.authorization === `Bearer ${TOKEN}` && tokenValid;
  if (req.url === '/api/public/bridge/claim') {
    const { code, verifier } = JSON.parse(body);
    const ok = code === 'CODE1234567890ab' && createHash('sha256').update(verifier).digest('base64url') === challenge;
    return ok ? send(200, { token: TOKEN, email: 'me@example.com' }) : send(400, { error: 'invalid code' });
  }
  if (!authed) return send(401, { error: 'invalid bridge token' });
  if (req.url === '/api/public/bridge/push') return (pushes.push(JSON.parse(body)), send(200, { ok: true }));
  if (req.url === '/api/public/bridge/commands' && req.method === 'GET') {
    const cmds = queued;
    queued = [];
    if (!cmds.length) await new Promise((r) => setTimeout(r, 300));
    return send(200, { commands: cmds });
  }
  if (req.url === '/api/public/bridge/commands') return (acks.push(JSON.parse(body)), send(200, { ok: true }));
  if (req.url === '/api/public/bridge/revoke') return send(200, { ok: true });
  send(404, {});
});
await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(cloud.address() as { port: number }).port}`;

const dir = mkdtempSync(join(tmpdir(), 'agent-boss-cloud-'));
const file = join(dir, 'cloud.json');
const notes: string[] = [];
const ran: string[] = [];
const link = new CloudLink(
  { file, defaultUrl: base, port: 7777 },
  {
    state: () => ({ tasks: [{ id: 't1' }] }),
    health: () => ({ ok: true }),
    recentEvents: () => [{ id: 1, ts: 'x', taskId: null, sessionId: null, type: 'supervisor.note', narration: 'hi', data: {} }],
    subscribe: () => () => {},
    runCommand: async (c) => (ran.push(`${c.kind}:${c.task_id}`), { ok: true, result: '{"paused":true}' }),
    note: (n) => void notes.push(n),
  },
);
const wait = async (cond: () => boolean, ms = 5_000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

assert.equal(link.status().connected, false);

// consent URL carries callback, state, PKCE challenge and machine name
const u = new URL(link.beginConnect());
assert.equal(u.origin + u.pathname, `${base}/connect`);
assert.equal(u.searchParams.get('callback'), 'http://127.0.0.1:7777/cloud/callback');
const state = u.searchParams.get('state')!;
challenge = u.searchParams.get('challenge')!;
assert.ok(state.length >= 40 && challenge.length >= 40 && u.searchParams.get('name'));

// wrong state is refused and consumes nothing
await assert.rejects(link.finishConnect('CODE1234567890ab', 'wrong-state-wrong-state'), /desconhecido/);
// a state can be used once: after this success, the same state is unknown
const st = await link.finishConnect('CODE1234567890ab', state);
assert.equal(st.connected, true);
assert.equal(st.email, 'me@example.com');
assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, TOKEN);
await assert.rejects(link.finishConnect('CODE1234567890ab', state), /desconhecido/);

// push + command loop
await wait(() => pushes.length > 0 && acks.length > 0);
assert.deepEqual(pushes[0].state.tasks, [{ id: 't1' }]);
assert.equal(pushes[0].state.online, true);
assert.equal(pushes[0].events.length, 1);
assert.deepEqual(ran, ['pause:t1']);
assert.deepEqual(acks[0], { id: 'c1', ok: true, result: '{"paused":true}' });

// reload from disk: a new instance is already connected
const again = new CloudLink({ file, defaultUrl: base, port: 7777 }, { state: () => ({}), health: () => ({}), recentEvents: () => [], subscribe: () => () => {}, runCommand: async () => ({ ok: true, result: '' }), note: () => {} });
assert.equal(again.status().connected, true);

// token revoked in the cloud: the link drops itself and deletes the saved token
tokenValid = false;
await wait(() => !link.status().connected);
assert.equal(existsSync(file), false);
assert.ok(notes.some((n) => /recusou o token/.test(n)));

await link.disconnect();
cloud.close();
rmSync(dir, { recursive: true, force: true });
console.log('cloud.test: ok');
process.exit(0);
