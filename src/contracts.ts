// Shared contracts between supervisor, board and (future) narration extension.

export type TaskStatus = 'queued' | 'running' | 'validating' | 'done' | 'blocked';
export const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'blocked']);

export type SessionPhase =
  | 'starting'
  | 'validating' // successor proving it understood the handoff; writes locked
  | 'active'
  | 'draining' // budget reached or pause requested; all tools denied until checkpoint
  | 'closed';

export type ExecutorKind = 'claude' | 'codex';

export interface Constraint {
  id: string; // C* = from user, L* = learned during execution (permanent)
  text: string;
}

export interface VerifyResult {
  ok: boolean;
  command: string;
  output: string;
  at: string;
}

export interface Task {
  id: string;
  parentId: string | null; // set on parts of a decomposed task
  goal: string;
  doneCriteria: string;
  cwd: string;
  model: string;
  executor: ExecutorKind;
  verifyCmd: string | null; // run by the supervisor itself before accepting "done"
  status: TaskStatus;
  paused: boolean;
  leaseEpoch: number;
  constraints: Constraint[];
  lastVerify: VerifyResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  what: string;
  why: string;
}

// What a session reports at the end of every turn. Conclusions, not reasoning.
export interface CheckpointData {
  status: 'in_progress' | 'done' | 'blocked';
  summary: string;
  decisions: Decision[];
  evidence: string[];
  pending: string[];
  discarded: string[];
  changes: string[];
  verified: string[];
  learned_constraints: string[];
  next_action: string;
}

export interface Checkpoint {
  id: string;
  taskId: string;
  sessionId: string;
  epoch: number;
  createdAt: string;
  data: CheckpointData;
}

// First reply of a successor session, checked field by field before writes unlock.
export interface ResumeAck {
  checkpoint_id: string;
  goal: string;
  constraint_ids: string[];
  next_action: string;
  uncertain_ops_plan?: string;
}

export type OpStatus = 'started' | 'done' | 'error' | 'denied' | 'uncertain' | 'acknowledged';

export interface Op {
  toolUseId: string;
  taskId: string;
  sessionId: string;
  epoch: number;
  tool: string;
  input: string;
  status: OpStatus;
  startedAt: string;
  endedAt: string | null;
  uncertainAt: string | null; // kept after acknowledgement, as evidence
}

export interface SessionRecord {
  id: string;
  taskId: string;
  epoch: number;
  executor: ExecutorKind;
  pid: number | null;
  claudeSessionId: string | null;
  phase: SessionPhase;
  ctxTokens: number;
  ctxWindow: number;
  ackStatus: 'n/a' | 'pending' | 'validated' | 'rejected';
  ack: ResumeAck | null;
  handoffMd: string | null; // continuity package this session started from
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export type EventType =
  | 'task.created'
  | 'task.status'
  | 'task.paused'
  | 'task.resumed'
  | 'session.started'
  | 'session.phase'
  | 'session.context'
  | 'session.ended'
  | 'tool.started'
  | 'tool.finished'
  | 'tool.denied'
  | 'checkpoint.saved'
  | 'constraint.learned'
  | 'verify.started'
  | 'verify.finished'
  | 'handoff.started'
  | 'handoff.validated'
  | 'handoff.rejected'
  | 'supervisor.recovered'
  | 'supervisor.note'
  | 'external.session'; // read-only observation of sessions the supervisor does not own

export interface SupervisorEvent {
  id?: number;
  ts: string;
  taskId: string | null;
  sessionId: string | null;
  type: EventType;
  narration: string; // one short human sentence, consumed by the board and the narration extension
  data: Record<string, unknown>;
}

export interface HookDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}
