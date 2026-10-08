import { EventEmitter } from 'node:events';
import type { Executor, ExecutorAdapter, ExecutorEvents, ExecutorOptions } from './types.ts';

// Stub for the Codex App Server backend (`codex app-server`, JSON-RPC 2.0 over stdio).
// The supervisor contract is the same as for Claude Code; only the wire protocol differs.
//
// Planned mapping (not implemented yet):
//   start()      -> spawn `codex app-server`; `initialize`; `thread/start` { cwd, model }
//                   (always a NEW thread per epoch: never `thread/resume` or fork)
//   send(text)   -> `turn/start` { threadId, input: [{ type: 'text', text }] }
//   interrupt()  -> `turn/interrupt`
//   gate         -> answer `item/commandExecution/requestApproval` and
//                   `item/fileChange/requestApproval` server requests by POSTing to
//                   `${gate.url}/hook/pretool` (same fail-closed rule as the Claude hook)
//   context      -> `thread/tokenUsage/updated` notifications (main thread only)
//   tool_use     -> `item/started` (commandExecution | fileChange | mcpToolCall)
//   tool_result  -> `item/completed`
//   result       -> `turn/completed`; checkpoint parsed from the final agent message
//   close()      -> close stdin, then kill the process tree
//
// Auth must stay on the user's ChatGPT/Codex login; no API keys, same rule as Claude.

export class CodexAppServerExecutor extends EventEmitter<ExecutorEvents> implements Executor {
  readonly kind = 'codex' as const;
  readonly pid = null;
  readonly alive = false;
  constructor(_opts: ExecutorOptions) {
    super();
  }
  start(): void {
    throw new Error('Codex App Server executor is a stub: not implemented yet');
  }
  send(): void {}
  interrupt(): void {}
  async close(): Promise<void> {}
  kill(): void {}
}

export const codexAppServerAdapter: ExecutorAdapter = {
  kind: 'codex',
  available: false,
  create: (opts) => new CodexAppServerExecutor(opts),
};
