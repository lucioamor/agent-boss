import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { EventBus } from './bus.ts';

// Read-only observer of agent sessions the supervisor does NOT own: the user's own Claude
// Code sessions (desktop, terminal, IDE) and Codex sessions on the same machine. It tails
// the transcripts each harness already writes:
//   Claude Code: ~/.claude/projects/<project>/<session>.jsonl
//   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  (+ ~/.codex/session_index.jsonl for titles)
// It never writes there, never touches settings, and cannot control those sessions.
// Supervisor executors run with --no-session-persistence, so they never show up here.

export type Harness = 'claude-code' | 'codex';
export type ExternalActivity = 'active' | 'stopped' | 'idle';
export type ExternalTurn = 'tool' | 'thinking' | 'waiting' | 'unknown';

export interface ExternalSession {
  harness: Harness;
  sessionId: string;
  file: string;
  title: string | null;
  cwd: string | null;
  repo: string | null; // git top-level of cwd (or cwd), used to spot parallel work on one repo
  gitBranch: string | null;
  origin: string | null; // claude-desktop / cli / vscode / Codex Desktop …
  version: string | null;
  model: string | null;
  ctxTokens: number;
  ctxWindow: number;
  windowEstimated: boolean;
  turn: ExternalTurn;
  lastTool: { name: string; target: string; at: string } | null;
  toolCalls: number;
  prompts: number;
  subagents: number; // subagent transcripts touched in the last 2 minutes
  rateLimitPct: number | null; // Codex: primary subscription window used %
  lastActivityAt: string;
  activity: ExternalActivity;
}

interface FileState {
  offset: number;
  rest: string;
  size: number;
  mtimeMs: number;
  grewAt: number; // when we saw the file grow (NTFS may not bump mtime while a writer keeps it open)
  s: ExternalSession;
  pendingTools: Set<string>;
  hasExplicitTitle: boolean;
  announced: { active: boolean; half: boolean };
}

export interface ObserverOptions {
  claudeDir: string | null; // ~/.claude/projects
  codexDir: string | null; // ~/.codex
  intervalMs: number;
  horizonMs: number; // only transcripts modified within this window are tracked
  activeMs: number; // modified within this ⇒ "active"
  stoppedMs: number; // within this ⇒ "stopped", older ⇒ "idle"
  knownWindow: (model: string) => number | null;
}

const MAX_INITIAL_READ = 16 * 1024 * 1024;
const HARNESS_PT: Record<Harness, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export class TranscriptObserver {
  private readonly files = new Map<string, FileState>();
  private readonly codexTitles = new Map<string, string>();
  private codexIndex = { offset: 0, rest: '' };
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: ObserverOptions;
  private readonly bus: EventBus;
  private readonly repoCache = new Map<string, string>();
  private readonly maxSeen = new Map<string, number>(); // largest context seen per Claude model

  constructor(bus: EventBus, opts: ObserverOptions) {
    this.bus = bus;
    this.opts = opts;
  }

  start() {
    this.scan(true);
    this.timer = setInterval(() => this.scan(false), this.opts.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  sources() {
    return {
      'claude-code': !!this.opts.claudeDir && existsSync(this.opts.claudeDir),
      codex: !!this.opts.codexDir && existsSync(join(this.opts.codexDir, 'sessions')),
    };
  }

  list(): ExternalSession[] {
    return [...this.files.values()]
      .map((f) => f.s)
      .filter((s) => s.prompts > 0)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  repoOf(cwd: string | null): string | null {
    if (!cwd) return null;
    const key = resolve(cwd); // normalizes separators and trailing slashes
    const hit = this.repoCache.get(key);
    if (hit) return hit;
    let dir = key;
    let found = key;
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, '.git'))) {
        found = dir;
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    this.repoCache.set(key, found);
    return found;
  }

  // --- scanning ---

  private scan(initial: boolean) {
    const now = Date.now();
    const seen = new Set<string>();
    const subagents = new Map<string, number>(); // parent session id -> recent child files
    for (const c of this.candidates(now)) {
      seen.add(c.file);
      let fs = this.files.get(c.file);
      if (!fs) {
        fs = newState(c.harness, c.file, c.sessionId);
        this.files.set(c.file, fs);
        if (c.size > MAX_INITIAL_READ) fs.offset = c.size - MAX_INITIAL_READ;
      }
      if (c.size !== fs.size || c.mtimeMs !== fs.mtimeMs) {
        if (fs.size && c.size > fs.size) fs.grewAt = now;
        this.readNew(fs, c.size);
        fs.size = c.size;
        fs.mtimeMs = c.mtimeMs;
      }
      if (c.harness === 'claude-code') fs.s.subagents = c.subagents;
    }
    // Codex child threads are separate rollouts named <parent>_<child>; fold them into the parent.
    for (const c of this.codexChildren(now)) subagents.set(c, (subagents.get(c) ?? 0) + 1);
    this.readCodexIndex();
    for (const fs of this.files.values()) {
      if (fs.s.harness === 'codex') {
        fs.s.subagents = subagents.get(fs.s.sessionId) ?? 0;
        const t = this.codexTitles.get(fs.s.sessionId);
        if (t) fs.s.title = t;
      }
      fs.s.repo = this.repoOf(fs.s.cwd);
      if (fs.s.harness === 'claude-code') this.claudeWindow(fs.s);
      this.classify(fs, now, initial);
    }
    for (const file of [...this.files.keys()]) if (!seen.has(file)) this.files.delete(file);
  }

  private *candidates(now: number) {
    const fresh = (p: string) => {
      try {
        const st = statSync(p);
        // Keep files we already track even if mtime looks stale (open writers on NTFS).
        return now - st.mtimeMs <= this.opts.horizonMs || this.files.has(p) ? st : null;
      } catch {
        return null;
      }
    };
    const { claudeDir, codexDir } = this.opts;
    if (claudeDir && existsSync(claudeDir)) {
      for (const project of safeDirs(claudeDir)) {
        const pdir = join(claudeDir, project);
        for (const name of safeFiles(pdir, '.jsonl')) {
          const file = join(pdir, name);
          const st = fresh(file);
          if (!st) continue;
          const sessionId = name.slice(0, -'.jsonl'.length);
          const sub = join(pdir, sessionId, 'subagents');
          const subagents = safeFiles(sub, '.jsonl').filter((n) => (fresh(join(sub, n))?.mtimeMs ?? 0) >= now - 120_000).length;
          yield { harness: 'claude-code' as Harness, file, sessionId, size: st.size, mtimeMs: st.mtimeMs, subagents };
        }
      }
    }
    if (codexDir) {
      for (const day of this.codexDays(now)) {
        for (const name of safeFiles(day, '.jsonl')) {
          const id = codexId(name);
          if (!id || id.child) continue;
          const file = join(day, name);
          const st = fresh(file);
          if (!st) continue;
          yield { harness: 'codex' as Harness, file, sessionId: id.parent, size: st.size, mtimeMs: st.mtimeMs, subagents: 0 };
        }
      }
    }
  }

  private codexDays(now: number): string[] {
    const root = join(this.opts.codexDir!, 'sessions');
    const out = new Set<string>();
    for (let t = now - this.opts.horizonMs - 86_400_000; t <= now + 86_400_000; t += 3_600_000 * 6) {
      const d = new Date(t);
      const p = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      if (existsSync(p)) out.add(p);
    }
    return [...out];
  }

  private codexChildren(now: number): string[] {
    if (!this.opts.codexDir) return [];
    const parents: string[] = [];
    for (const day of this.codexDays(now)) {
      for (const name of safeFiles(day, '.jsonl')) {
        const id = codexId(name);
        if (!id?.child) continue;
        try {
          if (statSync(join(day, name)).mtimeMs >= now - 120_000) parents.push(id.parent);
        } catch {}
      }
    }
    return parents;
  }

  // Titles live in an append-only index; the last line for an id wins.
  private readCodexIndex() {
    if (!this.opts.codexDir) return;
    const file = join(this.opts.codexDir, 'session_index.jsonl');
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < this.codexIndex.offset) this.codexIndex = { offset: 0, rest: '' };
    if (size === this.codexIndex.offset) return;
    const { text, rest } = readRange(file, this.codexIndex.offset, size, this.codexIndex.rest);
    this.codexIndex = { offset: size, rest };
    for (const line of text) {
      try {
        const m = JSON.parse(line);
        if (m.id && m.thread_name) this.codexTitles.set(m.id, String(m.thread_name));
      } catch {}
    }
  }

  private readNew(fs: FileState, size: number) {
    if (size < fs.offset) Object.assign(fs, newState(fs.s.harness, fs.s.file, fs.s.sessionId));
    if (size <= fs.offset) return;
    const { text, rest } = readRange(fs.s.file, fs.offset, size, fs.rest);
    fs.offset = size;
    fs.rest = rest;
    for (const line of text) {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (fs.s.harness === 'claude-code') this.applyClaude(fs, m);
      else this.applyCodex(fs, m);
    }
    const s = fs.s;
    if (s.harness === 'claude-code' && s.model) {
      this.maxSeen.set(s.model, Math.max(this.maxSeen.get(s.model) ?? 0, s.ctxTokens));
    }
  }

  // Claude transcripts don't record the window. Use what the CLI reported to the supervisor;
  // otherwise, any session of the same model past 200k proves the 1M window.
  private claudeWindow(s: ExternalSession) {
    const w = s.model ? this.opts.knownWindow(s.model) : null;
    s.ctxWindow = w ?? ((this.maxSeen.get(s.model ?? '') ?? 0) > 200_000 ? 1_000_000 : 200_000);
    s.windowEstimated = w === null;
  }

  // --- Claude Code transcript records ---

  private applyClaude(fs: FileState, m: any) {
    const s = fs.s;
    if (m.cwd) s.cwd = m.cwd;
    if (m.gitBranch) s.gitBranch = m.gitBranch;
    if (m.entrypoint) s.origin = m.entrypoint;
    if (m.version) s.version = m.version;
    if (m.timestamp && m.timestamp > s.lastActivityAt) s.lastActivityAt = m.timestamp;
    if (m.type === 'custom-title' && m.customTitle) (s.title = m.customTitle), (fs.hasExplicitTitle = true);
    if (m.type === 'agent-name' && m.agentName && !fs.hasExplicitTitle) s.title = m.agentName;
    if (m.type === 'summary' && m.summary && !fs.hasExplicitTitle) s.title = m.summary;
    if (m.isSidechain) return; // subagent traffic lives in its own window

    if (m.type === 'assistant' && m.message) {
      if (m.message.model && m.message.model !== '<synthetic>') s.model = m.message.model;
      const u = m.message.usage;
      if (u) s.ctxTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      for (const b of m.message.content ?? []) {
        if (b.type === 'tool_use') {
          fs.pendingTools.add(b.id);
          s.toolCalls++;
          s.lastTool = { name: b.name, target: describeTarget(b.input), at: m.timestamp ?? s.lastActivityAt };
        }
      }
      s.turn = m.message.stop_reason === 'end_turn' ? 'waiting' : fs.pendingTools.size ? 'tool' : 'thinking';
    } else if (m.type === 'user' && m.message) {
      const c = m.message.content;
      if (typeof c === 'string' || (Array.isArray(c) && c.some((b: any) => b.type === 'text'))) {
        if (m.turnOrigin === 'human' || m.userType === 'external') {
          s.prompts++;
          if (!s.title) s.title = firstText(c);
        }
        s.turn = 'thinking';
      }
      if (Array.isArray(c) && c.some((b: any) => b.type === 'tool_result')) {
        for (const b of c) if (b.type === 'tool_result') fs.pendingTools.delete(b.tool_use_id);
        s.turn = fs.pendingTools.size ? 'tool' : 'thinking';
      }
    }
  }

  // --- Codex rollout records ---

  private applyCodex(fs: FileState, m: any) {
    const s = fs.s;
    const p = m.payload ?? {};
    if (m.timestamp && m.timestamp > s.lastActivityAt) s.lastActivityAt = m.timestamp;
    if (m.type === 'session_meta') {
      s.cwd = p.cwd ?? s.cwd;
      s.origin = p.originator ?? p.source ?? s.origin;
      s.version = p.cli_version ?? s.version;
      if (p.git?.branch) s.gitBranch = p.git.branch;
      return;
    }
    if (m.type === 'turn_context') {
      if (p.cwd) s.cwd = p.cwd;
      if (p.model) s.model = p.effort ? `${p.model} (${p.effort})` : p.model;
      return;
    }
    if (m.type === 'event_msg') {
      switch (p.type) {
        case 'task_started':
          s.turn = 'thinking';
          if (p.model_context_window) (s.ctxWindow = p.model_context_window), (s.windowEstimated = false);
          break;
        case 'task_complete':
        case 'turn_aborted':
          s.turn = 'waiting';
          fs.pendingTools.clear();
          break;
        case 'token_count': {
          const last = p.info?.last_token_usage;
          // OpenAI input_tokens already include cached input: that is the occupied context.
          if (last) s.ctxTokens = last.input_tokens ?? s.ctxTokens;
          if (p.info?.model_context_window) (s.ctxWindow = p.info.model_context_window), (s.windowEstimated = false);
          const used = p.rate_limits?.primary?.used_percent;
          if (typeof used === 'number') s.rateLimitPct = used;
          break;
        }
        case 'item_completed':
          if (p.item?.type === 'UserMessage') {
            s.prompts++;
            if (!s.title) s.title = firstText(p.item.content);
          }
          break;
      }
      return;
    }
    if (m.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        if (p.call_id) fs.pendingTools.add(p.call_id);
        s.toolCalls++;
        s.lastTool = { name: p.name ?? p.type, target: describeCodexCall(p), at: m.timestamp ?? s.lastActivityAt };
        s.turn = 'tool';
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
        fs.pendingTools.delete(p.call_id);
        s.turn = fs.pendingTools.size ? 'tool' : 'thinking';
      }
    }
  }

  // --- activity & narration ---

  private classify(fs: FileState, now: number, initial: boolean) {
    const s = fs.s;
    const age = now - Math.max(fs.mtimeMs, fs.grewAt, Date.parse(s.lastActivityAt) || 0);
    const prev = s.activity;
    s.activity = age <= this.opts.activeMs ? 'active' : age <= this.opts.stoppedMs ? 'stopped' : 'idle';
    if (s.prompts === 0) return;
    const who = `${HARNESS_PT[s.harness]} ${s.title ? `"${truncate(s.title, 60)}"` : s.sessionId.slice(0, 8)}`;
    const ctx = { data: { external: true, harness: s.harness, sessionId: s.sessionId, cwd: s.cwd, repo: s.repo, activity: s.activity } };
    if (s.activity === 'active' && !fs.announced.active && !initial) {
      this.bus.emit('external.session', `Sessão externa ativa: ${who} em ${s.cwd ?? '?'}.`, ctx);
    }
    if (prev === 'active' && s.activity !== 'active' && fs.announced.active) {
      this.bus.emit('external.session', `Sessão externa parou: ${who}.`, ctx);
    }
    fs.announced.active = s.activity === 'active';
    const half = s.ctxTokens >= s.ctxWindow * 0.5;
    if (half && !fs.announced.half && !initial) {
      this.bus.emit('external.session', `Sessão externa ${who} passou de 50% do contexto (${s.ctxTokens.toLocaleString('pt-BR')} tokens).`, ctx);
    }
    fs.announced.half = half;
  }
}

function newState(harness: Harness, file: string, sessionId: string): FileState {
  return {
    offset: 0,
    rest: '',
    size: 0,
    mtimeMs: 0,
    grewAt: 0,
    pendingTools: new Set(),
    hasExplicitTitle: false,
    announced: { active: false, half: false },
    s: {
      harness,
      sessionId,
      file,
      title: null,
      cwd: null,
      repo: null,
      gitBranch: null,
      origin: null,
      version: null,
      model: null,
      ctxTokens: 0,
      ctxWindow: 200_000,
      windowEstimated: true,
      turn: 'unknown',
      lastTool: null,
      toolCalls: 0,
      prompts: 0,
      subagents: 0,
      rateLimitPct: null,
      lastActivityAt: new Date(0).toISOString(),
      activity: 'idle',
    },
  };
}

function readRange(file: string, from: number, to: number, carry: string): { text: string[]; rest: string } {
  const len = to - from;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, from);
  } finally {
    closeSync(fd);
  }
  const lines = (carry + buf.toString('utf8')).split('\n');
  const rest = lines.pop() ?? '';
  return { text: lines.filter((l) => l.trim()), rest };
}

// rollout-2026-10-08T11-27-59-<parent>[_<child>].jsonl
function codexId(name: string): { parent: string; child: string | null } | null {
  const m = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/i.exec(name);
  return m ? { parent: m[1], child: m[2] ?? null } : null;
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function safeFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(ext));
  } catch {
    return [];
  }
}

function firstText(c: unknown): string | null {
  let t: string | null = null;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = (c.find((b: any) => b?.type === 'text' || b?.type === 'input_text') as any)?.text ?? null;
  if (!t) return null;
  // Slash-command wrappers carry the useful text in <command-args>; skip pasted-file preambles.
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1];
  const clean = (args ?? t).replace(/<[^>]+>/g, ' ').replace(/^#\s*Files pasted by the user:[\s\S]*?\n\n/, '').replace(/\s+/g, ' ').trim();
  return clean ? truncate(clean, 90) : null;
}

function describeTarget(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.notebook_path ?? input.command ?? input.cmd ?? input.pattern ?? input.url ?? input.description ?? input.prompt ?? '';
  const str = String(v);
  const short = /[\\/]/.test(str) && !/\s/.test(str) ? basename(str) : str;
  return truncate(short.replace(/\s+/g, ' '), 70);
}

function describeCodexCall(p: any): string {
  if (p.type === 'custom_tool_call') {
    // Code-mode calls wrap commands: pull the first cmd/path literal out of the script.
    const src = String(p.input ?? '');
    const m = /(?:cmd|command|path)\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(src);
    return truncate((m ? m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : src).replace(/\s+/g, ' '), 70);
  }
  try {
    return describeTarget(JSON.parse(p.arguments ?? '{}'));
  } catch {
    return truncate(String(p.arguments ?? ''), 70);
  }
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
