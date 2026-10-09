import { isAbsolute, relative, resolve } from 'node:path';
import type { Constraint, Task } from './contracts.ts';
import type { TaskSpec } from './orchestrator.ts';

// Commands queued from the hosted board arrive here through the cloud bridge. The bridge is a
// dumb forwarder: every policy lives in this file, so a leaked cloud account can only do what
// this allowlist permits. Anything not listed is refused.

export const REMOTE_KINDS = ['pause', 'resume', 'drain', 'send_prompt', 'enqueue_task'] as const;
export type RemoteKind = (typeof REMOTE_KINDS)[number];

export interface RemoteCommand {
  kind: string;
  taskId?: string | null;
  payload?: unknown;
}

export interface RemoteResult {
  ok: boolean;
  status: number;
  result: unknown;
}

// The slice of Store/Orchestrator/Supervisor the dispatcher needs (keeps it unit-testable).
export interface RemoteDeps {
  getTask(id: string): Pick<Task, 'id' | 'status'> | undefined;
  pause(id: string): boolean;
  resume(id: string): void;
  requestDrain(id: string): boolean;
  addOperatorConstraint(id: string, text: string): Constraint;
  countOperatorConstraints(id: string): number;
  submit(spec: TaskSpec): { id: string };
  note(taskId: string, type: 'task.instruction', narration: string, data: Record<string, unknown>): void;
  // Directories under which remote enqueue_task may run. Empty = enqueue_task disabled.
  roots: string[];
  defaultModel: string;
}

export const LIMITS = {
  promptChars: 4_000,
  goalChars: 4_000,
  constraintChars: 1_000,
  constraints: 20,
  operatorConstraintsPerTask: 20,
};

const MODEL = /^[\w.\-\[\]]{1,64}$/;
const fail = (status: number, error: string): RemoteResult => ({ ok: false, status, result: { error } });
const ok = (result: unknown): RemoteResult => ({ ok: true, status: 200, result });
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

// A path is inside a root when the relative path does not climb out or switch drives.
export function insideRoots(cwd: string, roots: string[]): boolean {
  const abs = resolve(cwd);
  return roots.some((r) => {
    const rel = relative(resolve(r), abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

export function runRemote(deps: RemoteDeps, cmd: RemoteCommand): RemoteResult {
  const kind = cmd.kind as RemoteKind;
  if (!REMOTE_KINDS.includes(kind)) return fail(400, `unknown command: ${String(cmd.kind).slice(0, 50)}`);
  const payload = (cmd.payload && typeof cmd.payload === 'object' ? cmd.payload : {}) as Record<string, unknown>;

  if (kind === 'enqueue_task') return enqueue(deps, payload);

  const id = typeof cmd.taskId === 'string' ? cmd.taskId : '';
  const task = id ? deps.getTask(id) : undefined;
  if (!task) return fail(404, 'task not found');
  if (task.status === 'done') return fail(409, 'task already done');

  switch (kind) {
    case 'pause':
      return ok({ paused: deps.pause(id) });
    case 'resume':
      deps.resume(id);
      return ok({ resumed: true });
    case 'drain': {
      const drained = deps.requestDrain(id);
      return drained ? ok({ drained }) : fail(409, 'no live session to drain');
    }
    case 'send_prompt': {
      const text = str(payload.text, LIMITS.promptChars);
      if (!text) return fail(400, `text is required (1-${LIMITS.promptChars} chars)`);
      if (deps.countOperatorConstraints(id) >= LIMITS.operatorConstraintsPerTask) return fail(429, 'too many operator instructions on this task');
      const c = deps.addOperatorConstraint(id, text);
      deps.note(id, 'task.instruction', `Instrução do operador (${c.id}) recebida do board: ${text.slice(0, 120)}`, { constraintId: c.id });
      // The live session cannot see it, so by default rotate to a fresh session that must acknowledge it.
      const rotate = payload.rotate !== false;
      const drained = rotate ? deps.requestDrain(id) : false;
      return ok({ constraintId: c.id, drained, appliesFrom: drained ? 'next session (rotating now)' : 'next session' });
    }
  }
}

function enqueue(deps: RemoteDeps, p: Record<string, unknown>): RemoteResult {
  if (!deps.roots.length) return fail(403, 'enqueue_task is disabled: start agent-boss with --remote-root <dir>');
  const goal = str(p.goal, LIMITS.goalChars);
  const done = str(p.done, LIMITS.goalChars);
  const cwd = str(p.cwd, 1_000);
  if (!goal || !done || !cwd) return fail(400, 'goal, done and cwd are required');
  if (!isAbsolute(cwd)) return fail(400, 'cwd must be an absolute path');
  if (!insideRoots(cwd, deps.roots)) return fail(403, 'cwd is outside the allowed remote roots');
  // "verify" is a shell command and "executor"/"parts" widen what runs: not accepted remotely.
  for (const k of ['verify', 'executor', 'parts']) if (k in p) return fail(400, `${k} is not accepted from remote commands`);
  let constraints: string[] = [];
  if (p.constraints !== undefined) {
    if (!Array.isArray(p.constraints) || p.constraints.length > LIMITS.constraints) return fail(400, `constraints: up to ${LIMITS.constraints} strings`);
    const list = p.constraints.map((c) => str(c, LIMITS.constraintChars));
    if (list.some((c) => !c)) return fail(400, `constraints must be non-empty strings up to ${LIMITS.constraintChars} chars`);
    constraints = list as string[];
  }
  let model = deps.defaultModel;
  if (p.model !== undefined) {
    if (typeof p.model !== 'string' || !MODEL.test(p.model)) return fail(400, 'invalid model');
    model = p.model;
  }
  const t = deps.submit({ goal, done, cwd: resolve(cwd), constraints, model });
  return ok({ taskId: t.id });
}
