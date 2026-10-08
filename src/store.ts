import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Checkpoint,
  CheckpointData,
  Constraint,
  ExecutorKind,
  Op,
  OpStatus,
  ResumeAck,
  SessionPhase,
  SessionRecord,
  SupervisorEvent,
  Task,
  TaskStatus,
  VerifyResult,
} from './contracts.ts';

const now = () => new Date().toISOString();

// Single writer: only the supervisor process opens this database for writing (see lock.ts).
// Readers (verification scripts) open it with { readOnly: true }.
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, parent_id TEXT, goal TEXT NOT NULL, done_criteria TEXT NOT NULL, cwd TEXT NOT NULL,
        model TEXT NOT NULL, executor TEXT NOT NULL DEFAULT 'claude', verify_cmd TEXT,
        status TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, lease_epoch INTEGER NOT NULL DEFAULT 0,
        constraints TEXT NOT NULL, last_verify TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, epoch INTEGER NOT NULL, executor TEXT NOT NULL DEFAULT 'claude',
        pid INTEGER, claude_session_id TEXT, phase TEXT NOT NULL,
        ctx_tokens INTEGER NOT NULL DEFAULT 0, ctx_window INTEGER NOT NULL DEFAULT 0,
        ack_status TEXT NOT NULL DEFAULT 'n/a', ack TEXT, handoff_md TEXT,
        started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT,
        UNIQUE (task_id, epoch)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops (
        tool_use_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        tool TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        uncertain_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, task_id TEXT, session_id TEXT,
        type TEXT NOT NULL, narration TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ops_task ON ops(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
    `);
  }

  // --- tasks ---

  createTask(input: {
    goal: string;
    doneCriteria: string;
    cwd: string;
    model: string;
    executor?: ExecutorKind;
    verifyCmd?: string | null;
    parentId?: string | null;
    constraints: (string | Constraint)[];
  }): Task {
    const t = now();
    const task: Task = {
      id: `t_${randomUUID().slice(0, 8)}`,
      parentId: input.parentId ?? null,
      goal: input.goal,
      doneCriteria: input.doneCriteria,
      cwd: input.cwd,
      model: input.model,
      executor: input.executor ?? 'claude',
      verifyCmd: input.verifyCmd ?? null,
      status: 'queued',
      paused: false,
      leaseEpoch: 0,
      constraints: input.constraints.map((c, i) => (typeof c === 'string' ? { id: `C${i + 1}`, text: c } : c)),
      lastVerify: null,
      createdAt: t,
      updatedAt: t,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, parent_id, goal, done_criteria, cwd, model, executor, verify_cmd, status, paused, lease_epoch,
           constraints, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?)`,
      )
      .run(task.id, task.parentId, task.goal, task.doneCriteria, task.cwd, task.model, task.executor, task.verifyCmd,
        JSON.stringify(task.constraints), t, t);
    return task;
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, any> | undefined;
    return r && rowToTask(r);
  }

  listTasks(): Task[] {
    return (this.db.prepare(`SELECT * FROM tasks ORDER BY created_at, rowid`).all() as Record<string, any>[]).map(rowToTask);
  }

  children(parentId: string): Task[] {
    return (this.db.prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at, rowid`).all(parentId) as Record<string, any>[]).map(
      rowToTask,
    );
  }

  setTaskStatus(id: string, status: TaskStatus) {
    this.db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
  }

  setPaused(id: string, paused: boolean) {
    this.db.prepare(`UPDATE tasks SET paused = ?, updated_at = ? WHERE id = ?`).run(paused ? 1 : 0, now(), id);
  }

  setLastVerify(id: string, v: VerifyResult) {
    this.db.prepare(`UPDATE tasks SET last_verify = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(v), now(), id);
  }

  // Lease = epoch number. Only the session holding the current epoch may act on the task.
  acquireLease(id: string): number {
    this.db.prepare(`UPDATE tasks SET lease_epoch = lease_epoch + 1, updated_at = ? WHERE id = ?`).run(now(), id);
    return this.getTask(id)!.leaseEpoch;
  }

  addLearnedConstraints(id: string, texts: string[]): Constraint[] {
    const task = this.getTask(id)!;
    const known = new Set(task.constraints.map((c) => normalize(c.text)));
    let n = task.constraints.filter((c) => c.id.startsWith('L')).length;
    const added: Constraint[] = [];
    for (const text of texts) {
      if (!text.trim() || known.has(normalize(text))) continue;
      known.add(normalize(text));
      added.push({ id: `L${++n}`, text: text.trim() });
    }
    if (added.length) {
      this.db
        .prepare(`UPDATE tasks SET constraints = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify([...task.constraints, ...added]), now(), id);
    }
    return added;
  }

  // --- sessions ---

  createSession(taskId: string, epoch: number, executor: ExecutorKind): SessionRecord {
    const id = `s_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(`INSERT INTO sessions (id, task_id, epoch, executor, phase, started_at) VALUES (?, ?, ?, ?, 'starting', ?)`)
      .run(id, taskId, epoch, executor, now());
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, any> | undefined;
    return r && rowToSession(r);
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, 'claudeSessionId' | 'phase' | 'ctxTokens' | 'ctxWindow' | 'pid' | 'ackStatus' | 'ack' | 'handoffMd'>>,
  ) {
    const cols: Record<string, string> = {
      claudeSessionId: 'claude_session_id',
      phase: 'phase',
      ctxTokens: 'ctx_tokens',
      ctxWindow: 'ctx_window',
      pid: 'pid',
      ackStatus: 'ack_status',
      ack: 'ack',
      handoffMd: 'handoff_md',
    };
    for (const [k, v] of Object.entries(patch)) {
      const val = k === 'ack' ? JSON.stringify(v) : v;
      this.db.prepare(`UPDATE sessions SET ${cols[k]} = ? WHERE id = ?`).run(val as any, id);
    }
  }

  endSession(id: string, reason: string) {
    this.db
      .prepare(`UPDATE sessions SET phase = 'closed', ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`)
      .run(now(), reason, id);
  }

  openSessions(): SessionRecord[] {
    return (this.db.prepare(`SELECT * FROM sessions WHERE ended_at IS NULL`).all() as Record<string, any>[]).map(rowToSession);
  }

  listSessions(taskId: string): SessionRecord[] {
    return (this.db.prepare(`SELECT * FROM sessions WHERE task_id = ? ORDER BY epoch`).all(taskId) as Record<string, any>[]).map(
      rowToSession,
    );
  }

  // --- checkpoints ---

  addCheckpoint(taskId: string, sessionId: string, epoch: number, data: CheckpointData): Checkpoint {
    const cp: Checkpoint = { id: `cp_${randomUUID().slice(0, 8)}`, taskId, sessionId, epoch, createdAt: now(), data };
    this.db
      .prepare(`INSERT INTO checkpoints (id, task_id, session_id, epoch, created_at, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(cp.id, taskId, sessionId, epoch, cp.createdAt, JSON.stringify(data));
    return cp;
  }

  listCheckpoints(taskId: string): Checkpoint[] {
    return (
      this.db.prepare(`SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at, rowid`).all(taskId) as Record<string, any>[]
    ).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      sessionId: r.session_id,
      epoch: r.epoch,
      createdAt: r.created_at,
      data: JSON.parse(r.data),
    }));
  }

  // --- ops (tool calls with side effects we may need to reconcile) ---

  opStarted(op: Pick<Op, 'toolUseId' | 'taskId' | 'sessionId' | 'epoch' | 'tool' | 'input'>) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ops (tool_use_id, task_id, session_id, epoch, tool, input, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'started', ?)`,
      )
      .run(op.toolUseId, op.taskId, op.sessionId, op.epoch, op.tool, op.input, now());
  }

  opFinished(toolUseId: string, isError: boolean) {
    this.db
      .prepare(`UPDATE ops SET status = ?, ended_at = ? WHERE tool_use_id = ? AND status = 'started'`)
      .run(isError ? 'error' : 'done', now(), toolUseId);
  }

  // The gate refused this call: it never ran, so it is neither a side effect nor uncertain.
  opDenied(toolUseId: string) {
    this.db.prepare(`UPDATE ops SET status = 'denied', ended_at = ? WHERE tool_use_id = ? AND status = 'started'`).run(now(), toolUseId);
  }

  markSessionOpsUncertain(sessionId: string): number {
    return Number(
      this.db.prepare(`UPDATE ops SET status = 'uncertain', uncertain_at = ? WHERE session_id = ? AND status = 'started'`).run(now(), sessionId)
        .changes,
    );
  }

  listOps(taskId: string, status?: OpStatus): Op[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM ops WHERE task_id = ? AND status = ? ORDER BY started_at, rowid`).all(taskId, status)
      : this.db.prepare(`SELECT * FROM ops WHERE task_id = ? ORDER BY started_at, rowid`).all(taskId);
    return (rows as Record<string, any>[]).map(rowToOp);
  }

  acknowledgeUncertainOps(taskId: string) {
    this.db.prepare(`UPDATE ops SET status = 'acknowledged' WHERE task_id = ? AND status = 'uncertain'`).run(taskId);
  }

  // --- events ---

  addEvent(ev: SupervisorEvent): number {
    const r = this.db
      .prepare(`INSERT INTO events (ts, task_id, session_id, type, narration, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(ev.ts, ev.taskId, ev.sessionId, ev.type, ev.narration, JSON.stringify(ev.data));
    return Number(r.lastInsertRowid);
  }

  lastEvent(taskId: string, type: string): SupervisorEvent | undefined {
    const r = this.db.prepare(`SELECT * FROM events WHERE task_id = ? AND type = ? ORDER BY id DESC LIMIT 1`).get(taskId, type) as Record<string, any> | undefined;
    return r && { id: r.id, ts: r.ts, taskId: r.task_id, sessionId: r.session_id, type: r.type, narration: r.narration, data: JSON.parse(r.data) };
  }

  recentEvents(limit = 200, afterId = 0): SupervisorEvent[] {
    return (
      this.db.prepare(`SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?`).all(afterId, limit) as Record<string, any>[]
    )
      .reverse()
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        taskId: r.task_id,
        sessionId: r.session_id,
        type: r.type,
        narration: r.narration,
        data: JSON.parse(r.data),
      }));
  }
}

function normalize(s: string) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function rowToTask(r: Record<string, any>): Task {
  return {
    id: r.id,
    parentId: r.parent_id,
    goal: r.goal,
    doneCriteria: r.done_criteria,
    cwd: r.cwd,
    model: r.model,
    executor: r.executor,
    verifyCmd: r.verify_cmd,
    status: r.status,
    paused: !!r.paused,
    leaseEpoch: r.lease_epoch,
    constraints: JSON.parse(r.constraints),
    lastVerify: r.last_verify ? JSON.parse(r.last_verify) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToSession(r: Record<string, any>): SessionRecord {
  return {
    id: r.id,
    taskId: r.task_id,
    epoch: r.epoch,
    executor: r.executor,
    pid: r.pid,
    claudeSessionId: r.claude_session_id,
    phase: r.phase as SessionPhase,
    ctxTokens: r.ctx_tokens,
    ctxWindow: r.ctx_window,
    ackStatus: r.ack_status,
    ack: r.ack ? (JSON.parse(r.ack) as ResumeAck) : null,
    handoffMd: r.handoff_md,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
  };
}

function rowToOp(r: Record<string, any>): Op {
  return {
    toolUseId: r.tool_use_id,
    taskId: r.task_id,
    sessionId: r.session_id,
    epoch: r.epoch,
    tool: r.tool,
    input: r.input,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    uncertainAt: r.uncertain_at,
  };
}
