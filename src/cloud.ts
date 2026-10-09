import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { SupervisorEvent } from './contracts.ts';

// Link to the hosted board, run inside the server process (no separate bridge script).
//
// Pairing is an OAuth-style loopback redirect with PKCE (RFC 8252), the same shape as
// `gh auth login`: the local board opens the hosted /connect page with a random state and a
// PKCE challenge; the user signs in there and confirms; the hosted app redirects the browser to
// http://127.0.0.1:<port>/cloud/callback with a single-use code; we exchange code + verifier
// for the bridge token. The verifier never leaves this process, so a leaked code is useless.
//
// Once linked, two loops run: push (state + events, every 1.5 s when something changed) and
// commands (long-poll, execute locally, ack with retry).

export interface CloudCommand {
  id: string;
  kind: string;
  task_id: string | null;
  payload: unknown;
}

export interface CloudDeps {
  state(): Record<string, unknown>;
  health(): Record<string, unknown>;
  recentEvents(): SupervisorEvent[];
  subscribe(l: (ev: SupervisorEvent) => void): () => void;
  runCommand(c: CloudCommand): Promise<{ ok: boolean; result: string }>;
  note(narration: string): void;
}

interface Saved {
  url: string;
  token: string;
  email: string | null;
  machine: string;
  connectedAt: string;
}

export interface CloudStatus {
  connected: boolean;
  url: string;
  email: string | null;
  machine: string;
  connectedAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
}

const PUSH_EVERY_MS = 1_500;
const MAX_PENDING_EVENTS = 2_000;
const PAIRING_TTL_MS = 10 * 60_000;
const b64url = (b: Buffer) => b.toString('base64url');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CloudLink {
  private saved: Saved | null = null;
  private pending: { state: string; verifier: string; expires: number } | null = null;
  private gen = 0; // bumps on start/stop so loops from an older link exit
  private events: SupervisorEvent[] = [];
  private unsub: (() => void) | null = null;
  private lastStateJson = '';
  private lastPushAt: string | null = null;
  private lastError: string | null = null;
  private readonly file: string;
  private readonly defaultUrl: string;
  private readonly port: number;
  private readonly deps: CloudDeps;

  constructor(opts: { file: string; defaultUrl: string; port: number }, deps: CloudDeps) {
    this.file = opts.file;
    this.defaultUrl = opts.defaultUrl.replace(/\/+$/, '');
    this.port = opts.port;
    this.deps = deps;
    try {
      if (existsSync(this.file)) this.saved = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
    } catch {
      this.saved = null;
    }
  }

  status(): CloudStatus {
    return {
      connected: !!this.saved,
      url: this.saved?.url ?? this.defaultUrl,
      email: this.saved?.email ?? null,
      machine: this.saved?.machine ?? hostname(),
      connectedAt: this.saved?.connectedAt ?? null,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
    };
  }

  // Step 1: URL of the hosted consent page. The board navigates the browser there.
  beginConnect(): string {
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(32));
    this.pending = { state, verifier, expires: Date.now() + PAIRING_TTL_MS };
    const q = new URLSearchParams({
      callback: `http://127.0.0.1:${this.port}/cloud/callback`,
      state,
      challenge: b64url(createHash('sha256').update(verifier).digest()),
      name: hostname(),
    });
    return `${this.defaultUrl}/connect?${q}`;
  }

  // Step 2: the hosted app redirected back here with a single-use code.
  async finishConnect(code: string, state: string): Promise<CloudStatus> {
    const p = this.pending;
    if (!p || p.state !== state) throw new Error('pedido de conexão desconhecido; clique em "Conectar" de novo no board local');
    this.pending = null;
    if (Date.now() > p.expires) throw new Error('pedido de conexão expirou; clique em "Conectar" de novo');
    const r = await fetch(`${this.defaultUrl}/api/public/bridge/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier: p.verifier, machine: hostname() }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as { token?: string; email?: string; error?: string };
    if (!r.ok || !body.token) throw new Error(`o board online recusou a conexão: ${body.error ?? `HTTP ${r.status}`}`);
    this.saved = { url: this.defaultUrl, token: body.token, email: body.email ?? null, machine: hostname(), connectedAt: new Date().toISOString() };
    writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.deps.note(`Conectado ao board online${this.saved.email ? ` como ${this.saved.email}` : ''}.`);
    this.start();
    return this.status();
  }

  async disconnect() {
    const s = this.saved;
    this.stop();
    this.saved = null;
    rmSync(this.file, { force: true });
    if (s) {
      // Best effort: tell the cloud to drop the token. Deleting the local file already unlinks us.
      await fetch(`${s.url}/api/public/bridge/revoke`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
      this.deps.note('Desconectado do board online.');
    }
  }

  start() {
    if (!this.saved) return;
    this.stop();
    const gen = ++this.gen;
    this.lastStateJson = '';
    this.lastError = null;
    this.events = this.deps.recentEvents();
    this.unsub = this.deps.subscribe((ev) => {
      this.events.push(ev);
      if (this.events.length > MAX_PENDING_EVENTS) this.events.splice(0, this.events.length - MAX_PENDING_EVENTS);
    });
    void this.pushLoop(gen);
    void this.commandLoop(gen);
  }

  stop() {
    this.gen++;
    this.unsub?.();
    this.unsub = null;
  }

  private alive(gen: number) {
    return gen === this.gen && !!this.saved;
  }

  private headers() {
    return { authorization: `Bearer ${this.saved!.token}`, 'content-type': 'application/json' };
  }

  // The cloud rejected the token (revoked in the hosted board, or rotated elsewhere).
  private revoked(gen: number) {
    if (!this.alive(gen)) return;
    this.lastError = 'token recusado pelo board online; conecte de novo';
    this.deps.note('O board online recusou o token desta máquina. Conecte de novo pelo board local.');
    this.stop();
    this.saved = null;
    rmSync(this.file, { force: true });
  }

  private async pushLoop(gen: number) {
    while (this.alive(gen)) {
      try {
        const state = { ...this.deps.state(), health: this.deps.health(), online: true };
        const json = JSON.stringify(state);
        const events = this.events.slice(0, 500);
        if (json !== this.lastStateJson || events.length) {
          const r = await fetch(`${this.saved!.url}/api/public/bridge/push`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ state, events, info: { machine: this.saved!.machine, pid: process.pid, local: `http://127.0.0.1:${this.port}` } }),
            signal: AbortSignal.timeout(20_000),
          });
          if (r.status === 401) return this.revoked(gen);
          if (!r.ok) throw new Error(`push HTTP ${r.status}`);
          this.events.splice(0, events.length);
          this.lastStateJson = json;
          this.lastPushAt = new Date().toISOString();
          this.lastError = null;
        }
      } catch (e) {
        this.lastError = (e as Error).message;
      }
      await sleep(PUSH_EVERY_MS);
    }
  }

  private async commandLoop(gen: number) {
    while (this.alive(gen)) {
      const started = Date.now();
      try {
        // The cloud holds this GET up to 25 s and answers as soon as a command is claimed.
        const r = await fetch(`${this.saved!.url}/api/public/bridge/commands`, { headers: this.headers(), signal: AbortSignal.timeout(35_000) });
        if (r.status === 401) return this.revoked(gen);
        if (!r.ok) throw new Error(`commands HTTP ${r.status}`);
        const { commands } = (await r.json()) as { commands: CloudCommand[] };
        for (const c of commands) {
          if (!this.alive(gen)) return;
          let out: { ok: boolean; result: string };
          try {
            out = await this.deps.runCommand(c);
          } catch (e) {
            out = { ok: false, result: String((e as Error).message ?? e) };
          }
          await this.ack(gen, c.id, out);
        }
        // An empty answer that came back at once means the server is not holding the request.
        if (!commands.length && Date.now() - started < 1_000) await sleep(1_000);
      } catch (e) {
        this.lastError = (e as Error).message;
        await sleep(2_000);
      }
    }
  }

  // The command already ran, so a lost ack would leave it "running" until the lease expires.
  private async ack(gen: number, id: string, out: { ok: boolean; result: string }) {
    for (let attempt = 0; attempt < 4 && this.alive(gen); attempt++) {
      if (attempt) await sleep(1_000 * 2 ** (attempt - 1));
      try {
        const r = await fetch(`${this.saved!.url}/api/public/bridge/commands`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ id, ok: out.ok, result: out.result.slice(0, 400_000) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (r.status === 401) return this.revoked(gen);
        if (r.ok || r.status < 500) return;
      } catch {
        // retry
      }
    }
  }
}
