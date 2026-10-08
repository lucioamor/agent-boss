import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { killTree } from '../proc.ts';
import type { Executor, ExecutorAdapter, ExecutorEvents, ExecutorOptions } from './types.ts';

// Drives the locally installed `claude` CLI in headless stream-json mode.
// Auth is whatever the CLI is logged in with (subscription OAuth). Never pass --bare
// (it forces API-key auth) and never set ANTHROPIC_API_KEY for the child.

export class ClaudeCodeExecutor extends EventEmitter<ExecutorEvents> implements Executor {
  readonly kind = 'claude' as const;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private exited = false;
  private readonly opts: ExecutorOptions;
  private readonly bin: string;

  constructor(opts: ExecutorOptions, bin = 'claude') {
    super();
    this.opts = opts;
    this.bin = bin;
  }

  get pid() {
    return this.proc?.pid ?? null;
  }

  get alive() {
    return this.proc !== null && !this.exited;
  }

  start() {
    const o = this.opts;
    const hookCmd = `node --disable-warning=ExperimentalWarning "${o.gate.hookScript.replaceAll('\\', '/')}"`;
    const settings = {
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] }] },
    };
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', o.model,
      '--append-system-prompt', o.systemPrompt,
      // Hooks only via --settings on the child; global settings are never touched.
      '--settings', JSON.stringify(settings),
      // Skip user-level settings/MCP/skills so personal config doesn't leak into executors
      // (and keeps the baseline context small and predictable).
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--tools', o.tools.join(','),
      '--permission-mode', o.permissionMode,
      '--permission-prompts', 'none',
    ];
    if (o.allowedTools.length) args.push('--allowedTools', o.allowedTools.join(','));

    const env: Record<string, string | undefined> = {
      ...process.env,
      SUPERVISOR_URL: o.gate.url,
      SUPERVISOR_TOKEN: o.gate.token,
      SUPERVISOR_EPOCH: String(o.gate.epoch),
    };
    // Subscription auth only.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDECODE;

    const proc = spawn(this.bin, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;

    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr }).on('line', (line) => this.emit('stderr', line));
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => {
      this.exited = true;
      this.emit('exit', code);
    });
    proc.on('error', (err) => {
      this.emit('stderr', `spawn error: ${err.message}`);
      this.exited = true;
      this.emit('exit', null);
    });
  }

  send(text: string) {
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  interrupt() {
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  async close(timeoutMs = 10_000): Promise<void> {
    if (!this.proc) return;
    if (!this.exited) {
      const exited = new Promise<void>((resolve) => this.once('exit', () => resolve()));
      this.proc.stdin.end();
      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref());
      if ((await Promise.race([exited, timer])) === 'timeout') {
        this.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000).unref())]);
      }
    }
    // The CLI may leave children behind (Bash tool). Take whatever is left of the tree down.
    this.kill();
  }

  kill() {
    if (this.proc?.pid) killTree(this.proc.pid);
  }

  private write(obj: unknown) {
    if (!this.proc || this.exited || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  private onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && m.session_id) this.emit('init', m.session_id);
        break;
      case 'assistant': {
        // Subagent traffic lives in the subagent's own window; only the main thread counts.
        if (m.parent_tool_use_id) break;
        const u = m.message?.usage;
        if (u) {
          // Occupied context = what the model had to read for this message.
          const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          this.emit('context', tokens);
        }
        for (const block of m.message?.content ?? []) {
          if (block.type === 'tool_use') this.emit('tool_use', { id: block.id, name: block.name, input: block.input });
        }
        break;
      }
      case 'user':
        if (m.parent_tool_use_id) break;
        for (const block of m.message?.content ?? []) {
          if (block.type === 'tool_result') this.emit('tool_result', { id: block.tool_use_id, isError: !!block.is_error });
        }
        break;
      case 'result': {
        const usage = Object.entries(m.modelUsage ?? {}) as Array<[string, { contextWindow?: number }]>;
        const main = usage.find(([, x]) => x.contextWindow);
        this.emit('result', {
          text: typeof m.result === 'string' ? m.result : '',
          isError: !!m.is_error,
          subtype: m.subtype ?? '',
          contextWindow: main?.[1].contextWindow ?? null,
          model: main?.[0] ?? null,
        });
        break;
      }
    }
  }
}

export const claudeCodeAdapter: ExecutorAdapter = {
  kind: 'claude',
  available: true,
  create: (opts) => new ClaudeCodeExecutor(opts),
};
