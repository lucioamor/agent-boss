#!/usr/bin/env node
// agent-boss cloud bridge.
// Runs on the same machine as agent-boss. Reads the local board API (127.0.0.1),
// pushes state + events to the hosted board, and executes board commands locally.
//
// Usage:
//   AGENT_BOSS_CLOUD_URL=https://<seu-app> AGENT_BOSS_CLOUD_TOKEN=abk_... node agent-boss-cloud.mjs
// Optional: AGENT_BOSS_LOCAL=http://127.0.0.1:7777
//
// Comandos do board (long-poll em /api/public/bridge/commands):
//   pause, resume, drain, send_prompt, enqueue_task -> POST /api/remote/command (despachador local)
//   handoff                                         -> GET  /api/tasks/:id/handoff
//   restart, stop                                   -> POST /api/admin/{restart,stop}

const CLOUD = (process.env.AGENT_BOSS_CLOUD_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.AGENT_BOSS_CLOUD_TOKEN || '';
const LOCAL = (process.env.AGENT_BOSS_LOCAL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
if (!CLOUD || !TOKEN) {
  console.error('Defina AGENT_BOSS_CLOUD_URL e AGENT_BOSS_CLOUD_TOKEN.');
  process.exit(1);
}

const cloudHeaders = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const localPost = (p) => fetch(LOCAL + p, { method: 'POST', headers: { 'x-agent-boss': '1', 'content-type': 'application/json' }, body: '{}' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastEventId = 0;
let lastStateJson = '';
let pendingEvents = [];
let localUp = false;

async function push(body) {
  const r = await fetch(CLOUD + '/api/public/bridge/push', { method: 'POST', headers: cloudHeaders, body: JSON.stringify(body) });
  if (r.status === 401) throw new Error('token inválido: gere outro no board');
  if (!r.ok) throw new Error(`push ${r.status}: ${await r.text()}`);
}

async function pullState() {
  try {
    const [st, health] = await Promise.all([
      fetch(LOCAL + '/api/state').then((r) => r.json()),
      fetch(LOCAL + '/api/health').then((r) => r.json()).catch(() => null),
    ]);
    localUp = true;
    const state = { ...st, health, online: true };
    const json = JSON.stringify(state);
    const events = pendingEvents.splice(0, 500);
    if (json !== lastStateJson || events.length) {
      await push({ state, events, info: { local: LOCAL, pid: health?.pid ?? null } });
      lastStateJson = json;
    }
  } catch (err) {
    if (localUp || !lastStateJson.includes('"online":false')) {
      localUp = false;
      lastStateJson = JSON.stringify({ online: false, tasks: [], external: null });
      await push({ state: JSON.parse(lastStateJson) }).catch(() => {});
      console.warn('agent-boss local indisponível:', err.message);
    }
  }
}

// Follow the local SSE stream; events are batched into the next push.
async function followEvents() {
  for (;;) {
    try {
      const r = await fetch(`${LOCAL}/api/events${lastEventId ? `?after=${lastEventId}` : ''}`, { headers: lastEventId ? { 'last-event-id': String(lastEventId) } : {} });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (typeof ev.id === 'number') lastEventId = Math.max(lastEventId, ev.id);
            pendingEvents.push(ev);
          } catch {}
        }
      }
    } catch {}
    await sleep(2000);
  }
}

const REMOTE_KINDS = new Set(['pause', 'resume', 'drain', 'send_prompt', 'enqueue_task']);

async function runCommand(c) {
  const t = c.task_id ? encodeURIComponent(c.task_id) : '';
  let r;
  if (REMOTE_KINDS.has(c.kind)) {
    r = await fetch(LOCAL + '/api/remote/command', {
      method: 'POST',
      headers: { 'x-agent-boss': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: c.kind, taskId: c.task_id, payload: c.payload }),
    });
  } else if (c.kind === 'handoff') {
    const ep = c.payload?.epoch != null ? `?epoch=${encodeURIComponent(c.payload.epoch)}` : '';
    r = await fetch(`${LOCAL}/api/tasks/${t}/handoff${ep}`);
  } else if (c.kind === 'restart' || c.kind === 'stop') {
    r = await localPost(`/api/admin/${c.kind}`);
  } else {
    return { ok: false, result: `comando desconhecido: ${c.kind}` };
  }
  return { ok: r.ok, result: (await r.text()).slice(0, 400_000) };
}

// Long-poll: the server holds the GET up to 25 s. Each claimed command has a 5 min lease;
// the ack is sent once, at the end.
// The command already ran locally, so a lost ack would leave it "running" until the lease
// expires and then "failed". Retry network errors and 5xx a few times; 4xx are final.
async function ackCommand(id, out) {
  let last = 'sem resposta';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const r = await fetch(CLOUD + '/api/public/bridge/commands', {
        method: 'POST',
        headers: cloudHeaders,
        body: JSON.stringify({ id, ...out }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.status === 401) throw new Error('token inválido: gere outro no board');
      if (r.ok || r.status < 500) return r.status;
      last = `HTTP ${r.status}`;
    } catch (e) {
      if (/token inválido/.test(e.message)) throw e;
      last = e.message;
    }
  }
  console.warn(`ack do comando ${id} não entregue (${last}); a lease vai expirar`);
  return 0;
}

async function pollCommands() {
  const started = Date.now();
  const r = await fetch(CLOUD + '/api/public/bridge/commands', { headers: cloudHeaders, signal: AbortSignal.timeout(35000) });
  if (r.status === 401) throw new Error('token inválido: gere outro no board');
  if (!r.ok) throw new Error(`commands ${r.status}`);
  const { commands } = await r.json();
  for (const c of commands) {
    let out;
    try { out = await runCommand(c); } catch (e) { out = { ok: false, result: String(e.message || e) }; }
    const status = await ackCommand(c.id, out);
    console.log(`comando ${c.kind} ${c.task_id ?? ''}: ${out.ok ? 'ok' : 'falhou'}${status === 409 ? ' (ack recusado: lease expirada)' : ''}`);
  }
  // A long-poll that came back empty almost at once means the server is not holding the
  // request; wait so this loop never spins against the cloud.
  if (!commands.length && Date.now() - started < 1000) await sleep(1000);
}

async function stateLoop() {
  for (;;) {
    try { await pullState(); } catch (e) {
      console.warn(e.message);
      if (/token inválido/.test(e.message)) process.exit(1);
    }
    await sleep(1500);
  }
}

async function commandLoop() {
  for (;;) {
    try { await pollCommands(); } catch (e) {
      console.warn('comandos:', e.message);
      if (/token inválido/.test(e.message)) process.exit(1);
      await sleep(2000);
    }
  }
}

console.log(`bridge: ${LOCAL} -> ${CLOUD}`);
followEvents();
stateLoop();
commandLoop();
