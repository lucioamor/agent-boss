import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { EventBus } from './bus.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';
import type { TranscriptObserver } from './observer.ts';
import { runRemote, type RemoteDeps } from './remote.ts';
import { CloudLink, type CloudCommand } from './cloud.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function startServer(opts: {
  port: number;
  store: Store;
  bus: EventBus;
  supervisor: Supervisor;
  orchestrator: Orchestrator;
  publicDir: string;
  observer: TranscriptObserver | null;
  defaults: { model: string };
  // Directories where commands from the hosted board may enqueue tasks. Empty disables enqueue_task.
  remoteRoots: string[];
  // Hosted board link: where the token is saved and which board to pair with.
  cloud: { file: string; url: string };
  // daemonPid is set when running under src/daemon.ts: the board can then restart its own server.
  admin: { daemonPid: number | null; request: (action: 'restart' | 'stop') => void };
  startedAt: string;
}) {
  const { store, bus, supervisor, orchestrator } = opts;

  const state = () => {
    const live = new Map(supervisor.liveSessions().map((l) => [l.taskId, l]));
    return {
      external: opts.observer ? { sources: opts.observer.sources(), sessions: opts.observer.list() } : null,
      parallel: orchestrator.parallel,
      budgetFor1M: supervisor.budgetFor(1_000_000),
      tasks: store.listTasks().map((t) => {
        const cps = store.listCheckpoints(t.id);
        const sessions = store.listSessions(t.id).map(({ handoffMd, ...s }) => ({ ...s, hasHandoff: !!handoffMd }));
        const lastSession = sessions.at(-1);
        return {
          ...t,
          children: store.children(t.id).map((c) => c.id),
          sessions,
          live: live.get(t.id) ?? null,
          repo: opts.observer?.repoOf(t.cwd) ?? t.cwd,
          budget: supervisor.budgetFor(live.get(t.id)?.ctxWindow ?? lastSession?.ctxWindow ?? 1_000_000),
          lastCheckpoint: cps.at(-1) ?? null,
          checkpointCount: cps.length,
          uncertainOps: store.listOps(t.id, 'uncertain').length,
          statusNote: store.lastEvent(t.id, 'task.status')?.narration ?? null,
        };
      }),
    };
  };

  const health = () => ({ ok: true, pid: process.pid, daemonPid: opts.admin.daemonPid, startedAt: opts.startedAt, liveExecutors: supervisor.liveCount() });

  const remoteDeps: RemoteDeps = {
    getTask: (id) => store.getTask(id) ?? undefined,
    pause: (id) => orchestrator.pause(id),
    resume: (id) => orchestrator.resume(id),
    requestDrain: (id) => supervisor.requestDrain(id),
    addOperatorConstraint: (id, text) => store.addOperatorConstraint(id, text),
    countOperatorConstraints: (id) => store.getTask(id)?.constraints.filter((c) => c.id.startsWith('O')).length ?? 0,
    submit: (spec) => orchestrator.submit(spec, opts.defaults),
    note: (taskId, type, narration, data) => void bus.emit(type, narration, { taskId, data }),
    roots: opts.remoteRoots,
    defaultModel: opts.defaults.model,
  };

  // Commands from the hosted board, executed in-process by the cloud link.
  const runCloudCommand = async (c: CloudCommand) => {
    if (c.kind === 'handoff') {
      const epoch = (c.payload as { epoch?: unknown } | null)?.epoch;
      if (!c.task_id || !store.getTask(c.task_id)) return { ok: false, result: JSON.stringify({ error: 'task not found' }) };
      const md = epoch != null
        ? (store.listSessions(c.task_id).find((s) => s.epoch === Number(epoch))?.handoffMd ?? `(sessão ${epoch} não começou de um handoff)`)
        : supervisor.handoffFor(c.task_id);
      return { ok: true, result: md };
    }
    if (c.kind === 'restart' || c.kind === 'stop') {
      if (c.kind === 'restart' && !opts.admin.daemonPid) return { ok: false, result: JSON.stringify({ error: 'restart needs the daemon: start with "Agent Boss.cmd"' }) };
      // Ack first, then act: the process is about to go away.
      setTimeout(() => opts.admin.request(c.kind as 'restart' | 'stop'), 1_500);
      return { ok: true, result: JSON.stringify({ action: c.kind, liveExecutors: supervisor.liveCount() }) };
    }
    const r = runRemote(remoteDeps, { kind: c.kind, taskId: c.task_id, payload: c.payload });
    return { ok: r.ok, result: JSON.stringify(r.result) };
  };

  const cloud = new CloudLink(
    { file: opts.cloud.file, defaultUrl: opts.cloud.url, port: opts.port },
    {
      state,
      health,
      recentEvents: () => store.recentEvents(150, 0),
      subscribe: (l) => bus.subscribe(l),
      runCommand: runCloudCommand,
      note: (narration) => void bus.emit('supervisor.note', narration),
    },
  );

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;

      // Local-only guard. The Host check defeats DNS rebinding. State-changing requests need a
      // custom header (forces a CORS preflight we never approve) and a same-origin Origin, so
      // other web pages open in the browser cannot create tasks or stop the server.
      const local = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
      if (!local.has(String(req.headers.host ?? ''))) return json(res, 403, { error: 'host not allowed' });
      if (req.method !== 'GET' && p !== '/hook/pretool') {
        const origin = req.headers.origin;
        if (req.headers['x-agent-boss'] !== '1' || (origin && !local.has(origin.replace(/^https?:\/\//, '')))) {
          return json(res, 403, { error: 'cross-site request refused' });
        }
      }

      const m =/^\/api\/tasks\/([\w-]+)(?:\/(\w+))?$/.exec(p);

      if (req.method === 'POST' && p === '/hook/pretool') {
        const body = JSON.parse(await readBody(req));
        return json(res, 200, supervisor.decide(String(body.token ?? ''), Number(body.epoch ?? -1), String(body.tool_name ?? ''), body.tool_use_id ? String(body.tool_use_id) : undefined));
      }
      if (req.method === 'GET' && p === '/api/state') return json(res, 200, state());
      if (req.method === 'GET' && p === '/api/health') {
        return json(res, 200, health());
      }
      if (req.method === 'POST' && (p === '/api/admin/restart' || p === '/api/admin/stop')) {
        const action = p.endsWith('restart') ? 'restart' : 'stop';
        if (action === 'restart' && !opts.admin.daemonPid) {
          return json(res, 409, { error: 'restart needs the daemon: start with "Agent Boss.cmd" (or node src/daemon.ts)' });
        }
        json(res, 202, { ok: true, action, liveExecutors: supervisor.liveCount() });
        setImmediate(() => opts.admin.request(action));
        return;
      }
      if (req.method === 'GET' && p === '/api/external') return json(res, 200, opts.observer?.list() ?? []);
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
        const write = (ev: { id?: number }) => res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
        for (const ev of store.recentEvents(after ? 1000 : 150, after)) write(ev);
        const unsub = bus.subscribe(write);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          unsub();
          clearInterval(ping);
        });
        return;
      }
      if (req.method === 'GET' && p === '/api/cloud') return json(res, 200, cloud.status());
      if (req.method === 'POST' && p === '/api/cloud/connect') return json(res, 200, { url: cloud.beginConnect() });
      if (req.method === 'POST' && p === '/api/cloud/disconnect') {
        await cloud.disconnect();
        return json(res, 200, cloud.status());
      }
      if (req.method === 'GET' && p === '/cloud/callback') {
        // Browser redirect from the hosted /connect page (RFC 8252 loopback redirect).
        const code = url.searchParams.get('code') ?? '';
        const st = url.searchParams.get('state') ?? '';
        const denied = url.searchParams.get('error');
        try {
          if (denied) throw new Error(denied === 'access_denied' ? 'conexão cancelada no board online' : denied.slice(0, 100));
          if (!/^[\w-]{16,128}$/.test(code) || !/^[\w-]{16,128}$/.test(st)) throw new Error('resposta inválida do board online');
          await cloud.finishConnect(code, st);
          return redirect(res, '/?cloud=connected');
        } catch (err) {
          return redirect(res, `/?cloud=error&reason=${encodeURIComponent((err as Error).message)}`);
        }
      }
      if (req.method === 'POST' && p === '/api/tasks') {
        const spec = JSON.parse(await readBody(req));
        if (!spec.goal || !spec.done || !spec.cwd) return json(res, 400, { error: 'goal, done and cwd are required' });
        const t = orchestrator.submit(spec, opts.defaults);
        return json(res, 201, { id: t.id });
      }
      if (m) {
        const [, id, action] = m;
        const task = store.getTask(id);
        if (!task) return json(res, 404, { error: 'task not found' });
        if (req.method === 'POST' && action === 'pause') return json(res, 200, { ok: orchestrator.pause(id) });
        if (req.method === 'POST' && action === 'resume') {
          orchestrator.resume(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && action === 'handoff') {
          // ?epoch=N returns the package session N actually started from; default previews the next one.
          const epoch = url.searchParams.get('epoch');
          const md = epoch
            ? (store.listSessions(id).find((s) => s.epoch === Number(epoch))?.handoffMd ?? `(sessão ${epoch} não começou de um handoff)`)
            : supervisor.handoffFor(id);
          return send(res, 200, md, 'text/markdown; charset=utf-8');
        }
        if (req.method === 'GET' && !action) {
          return json(res, 200, {
            task,
            sessions: store.listSessions(id),
            checkpoints: store.listCheckpoints(id),
            ops: store.listOps(id),
          });
        }
      }
      if (req.method === 'GET') {
        const rel = p === '/' ? 'index.html' : normalize(p).replace(/^[\\/]+/, '');
        const file = join(opts.publicDir, rel);
        if (file.startsWith(opts.publicDir) && existsSync(file)) {
          return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  return new Promise<typeof server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      cloud.start(); // no-op until this machine has been paired with the hosted board
      resolve(server);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

function json(res: ServerResponse, status: number, obj: unknown) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}
