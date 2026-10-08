import type { EventEmitter } from 'node:events';
import type { ExecutorKind } from '../contracts.ts';

// An executor is one disposable agent process. The supervisor never reuses one across
// epochs: every handoff starts a brand new executor from the continuity package.

export interface ExecutorOptions {
  cwd: string;
  model: string;
  systemPrompt: string; // appended to the executor's own system prompt
  // Gate consulted before every tool call. For Claude Code this is the PreToolUse hook
  // (an HTTP call back into the supervisor); other backends map it to their approval hook.
  gate: { url: string; token: string; epoch: number; hookScript: string };
  permissionMode: string;
  tools: string[]; // tools the executor may use at all
  allowedTools: string[]; // permission rules pre-approved for the CLI (e.g. "Bash(npm test:*)")
}

export interface TurnResult {
  text: string;
  isError: boolean;
  subtype: string;
  contextWindow: number | null;
  model: string | null; // concrete model id the CLI reported (e.g. claude-sonnet-5-5)
}

export interface ExecutorEvents {
  init: [nativeSessionId: string];
  // Occupied context of the main thread, measured from the last assistant message.
  context: [tokens: number];
  tool_use: [tool: { id: string; name: string; input: unknown }];
  tool_result: [result: { id: string; isError: boolean }];
  result: [result: TurnResult];
  stderr: [line: string];
  exit: [code: number | null];
}

export interface Executor extends EventEmitter<ExecutorEvents> {
  readonly kind: ExecutorKind;
  readonly pid: number | null;
  readonly alive: boolean;
  start(): void;
  send(text: string): void;
  interrupt(): void;
  // Graceful stop (close stdin), then kill the whole process tree if still alive.
  close(timeoutMs?: number): Promise<void>;
  kill(): void;
}

export interface ExecutorAdapter {
  readonly kind: ExecutorKind;
  readonly available: boolean;
  create(opts: ExecutorOptions): Executor;
}
