import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { EventBus } from './bus.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';
import type { TranscriptObserver } from './observer.ts';

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
        return json(res, 200, { ok: true, pid: process.pid, daemonPid: opts.admin.daemonPid, startedAt: opts.startedAt, liveExecutors: supervisor.liveCount() });
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
    server.listen(opts.port, '127.0.0.1', () => resolve(server));
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

function json(res: ServerResponse, status: number, obj: unknown) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}
