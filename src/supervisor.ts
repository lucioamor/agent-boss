import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus } from './bus.ts';
import type { ExecutorKind, HookDecision, SessionPhase, SessionRecord, Task, TaskStatus, VerifyResult } from './contracts.ts';
import type { Executor, ExecutorAdapter, TurnResult } from './executors/types.ts';
import { killTree, processName } from './proc.ts';
import {
  DENY_PREFIX,
  EXECUTOR_SYSTEM_PROMPT,
  buildContinuityPackage,
  describeOp,
  initialPrompt,
  parseCheckpoint,
  validateResumeAck,
} from './protocol.ts';
import type { Store } from './store.ts';

export interface SupervisorConfig {
  url: string; // base URL hooks call back into
  hookScript: string; // absolute path of src/hooks/pretool.ts
  handoffDir: string;
  handoffRatio: number; // fraction of the context window that triggers a handoff
  handoffTokens: number | null; // absolute override, mainly for testing
  defaultWindow: number; // used until the CLI reports the real window
  permissionMode: string;
  tools: string[];
  allowedTools: string[];
  maxSessions: number;
  maxTurnsPerSession: number;
  turnTimeoutMs: number;
  drainTimeoutMs: number;
  verifyTimeoutMs: number;
}

interface LiveSession {
  token: string;
  task: Task;
  rec: SessionRecord;
  phase: SessionPhase;
  drainReason: 'budget' | 'pause' | 'timeout' | null;
  exec: Executor;
  ctxTokens: number;
  ctxWindow: number;
  lastCtxBucket: number;
  stderrTail: string[];
  endReason?: string; // set when the operator stops the server
}

type Outcome = { kind: 'done' | 'blocked' | 'handoff' | 'paused'; reason: string };
type TurnOutcome = TurnResult | 'exit' | 'timeout';
export type RunResult = 'done' | 'blocked' | 'paused';

// Tools a successor may use before its resume_ack is accepted.
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

export class Supervisor {
  private readonly live = new Map<string, LiveSession>();
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly cfg: SupervisorConfig;
  private readonly adapters: Map<ExecutorKind, ExecutorAdapter>;
  // Last context window the CLI reported per model, so new sessions start with the real one.
  private readonly knownWindow = new Map<string, number>();

  constructor(store: Store, bus: EventBus, cfg: SupervisorConfig, adapters: ExecutorAdapter[]) {
    this.store = store;
    this.bus = bus;
    this.cfg = cfg;
    this.adapters = new Map(adapters.map((a) => [a.kind, a]));
    mkdirSync(cfg.handoffDir, { recursive: true });
    for (const t of store.listTasks()) {
      const w = store.listSessions(t.id).findLast((s) => s.ctxWindow > 0)?.ctxWindow;
      if (w) this.knownWindow.set(t.model, w);
    }
  }

  liveSessions() {
    return [...this.live.values()].map((s) => ({
      sessionId: s.rec.id,
      taskId: s.task.id,
      epoch: s.rec.epoch,
      phase: s.phase,
      drainReason: s.drainReason,
      pid: s.exec.pid,
      ctxTokens: s.ctxTokens,
      ctxWindow: s.ctxWindow,
      budget: this.budget(s),
    }));
  }

  // Context window the CLI reported for a model alias or concrete id, if ever seen.
  windowFor(model: string): number | null {
    const exact = this.knownWindow.get(model);
    if (exact) return exact;
    // Aliases ("sonnet") match concrete ids ("claude-sonnet-5-5").
    for (const [k, w] of this.knownWindow) if (!k.includes('-') && model.includes(k)) return w;
    return null;
  }

  budgetFor(window: number) {
    return this.cfg.handoffTokens ?? Math.floor(window * this.cfg.handoffRatio);
  }

  // A previous supervisor process died. Nothing it ran is trustworthy anymore: kill leftover
  // executors, close their sessions, and mark every in-flight operation as uncertain.
  recoverAfterRestart(): { sessions: number; killed: number; ops: number; tasks: string[] } {
    let killed = 0;
    let ops = 0;
    const tasks = new Set<string>();
    const open = this.store.openSessions();
    for (const s of open) {
      if (s.pid) {
        const name = processName(s.pid);
        if (name && /claude|node|codex/i.test(name) && killTree(s.pid)) killed++;
      }
      ops += this.store.markSessionOpsUncertain(s.id);
      this.store.endSession(s.id, 'orphaned: supervisor restarted');
      tasks.add(s.taskId);
    }
    for (const t of this.store.listTasks()) {
      if ((t.status === 'running' || t.status === 'validating') && this.store.children(t.id).length === 0) {
        this.store.setTaskStatus(t.id, 'queued');
        tasks.add(t.id);
      }
    }
    const r = { sessions: open.length, killed, ops, tasks: [...tasks] };
    if (open.length || ops || tasks.size) {
      this.bus.emit(
        'supervisor.recovered',
        `Supervisor reiniciado: ${open.length} sessão(ões) órfã(s) fechada(s), ${killed} processo(s) encerrado(s), ${ops} operação(ões) marcada(s) como incerta(s).`,
        { data: r },
      );
    }
    return r;
  }

  // Called by the PreToolUse hook of every executor, before every tool call. Fail closed.
  decide(token: string, epoch: number, toolName: string, toolUseId?: string): HookDecision {
    const s = this.live.get(token);
    const deny = (reason: string): HookDecision => {
      if (toolUseId) this.store.opDenied(toolUseId);
      this.bus.emit('tool.denied', `Supervisor bloqueou ${toolName}: ${reason.split('.')[0]}.`, {
        taskId: s?.task.id,
        sessionId: s?.rec.id,
        data: { tool: toolName, phase: s?.phase },
      });
      return { decision: 'deny', reason: `${DENY_PREFIX} ${reason}` };
    };
    if (!s) return deny('unknown or expired session. Do not call tools. End your turn.');
    const leaseEpoch = this.store.getTask(s.task.id)?.leaseEpoch;
    if (s.phase === 'closed' || epoch !== s.rec.epoch || leaseEpoch !== s.rec.epoch) {
      return deny('this session no longer owns the task lease. Do not call any tools. End your turn.');
    }
    if (s.phase === 'draining') {
      const why = s.drainReason === 'pause' ? 'pause requested by the operator' : 'context budget reached';
      return deny(
        `${why}. Do not call any more tools. End your turn NOW with the checkpoint block ` +
          '(status "in_progress" unless the task is truly done and verified).',
      );
    }
    if (s.phase === 'starting') return deny('session not ready yet. End your turn.');
    if (s.phase === 'validating' && !READ_ONLY_TOOLS.has(toolName)) {
      return deny('writes are locked until your resume_ack is validated. Use only Read/Grep/Glob, then reply with the resume_ack block.');
    }
    return { decision: 'allow' };
  }

  // Operator pause: drain the live session (tools denied), keep its checkpoint, stop it.
  requestPause(taskId: string): boolean {
    const task = this.store.getTask(taskId);
    if (!task || task.status === 'done') return false;
    this.store.setPaused(taskId, true);
    const s = [...this.live.values()].find((l) => l.task.id === taskId);
    if (s && (s.phase === 'active' || s.phase === 'validating')) {
      s.drainReason = 'pause';
      this.setPhase(s, 'draining');
    }
    this.bus.emit('task.paused', s ? `Pausa pedida: sessão ${s.rec.epoch} vai salvar checkpoint e parar.` : 'Tarefa pausada na fila.', {
      taskId,
      data: { live: !!s },
    });
    return true;
  }

  // Operator asked to stop/restart the server. Lock every gate, kill executor trees and let
  // each runSession finalize (in-flight ops -> uncertain, session closed). Tasks stay
  // queued/running in SQLite; the next process's recovery puts them back in the queue.
  stopping = false;
  async shutdown(reason: string, timeoutMs = 20_000): Promise<number> {
    this.stopping = true;
    const live = [...this.live.values()];
    for (const s of live) {
      s.endReason = reason;
      this.setPhase(s, 'closed');
      s.exec.kill();
    }
    const deadline = Date.now() + timeoutMs;
    while (this.live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (live.length) {
      this.bus.emit('supervisor.note', `Servidor parando (${reason}): ${live.length} executor(es) encerrado(s); as tarefas voltam à fila no próximo início.`, {
        data: { reason, sessions: live.map((s) => s.rec.id) },
      });
    }
    return live.length;
  }

  liveCount() {
    return this.live.size;
  }

  isRunning(taskId: string) {
    return [...this.live.values()].some((l) => l.task.id === taskId);
  }

  async runTask(taskId: string): Promise<RunResult> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.status === 'done') return 'done';
    const adapter = this.adapters.get(task.executor);
    if (!adapter?.available) {
      this.setTaskStatus(taskId, 'blocked', `Executor "${task.executor}" indisponível (adaptador ainda é stub).`);
      return 'blocked';
    }
    this.setTaskStatus(task.id, 'running', `Tarefa em execução: ${task.goal.slice(0, 80)}`);

    for (;;) {
      if (this.stopping) return 'paused'; // status stays as is; recovery requeues it
      if (this.store.getTask(taskId)!.paused) return this.pausedOut(taskId);
      const epoch = this.store.acquireLease(taskId);
      if (epoch > this.cfg.maxSessions) {
        this.setTaskStatus(taskId, 'blocked', `Limite de ${this.cfg.maxSessions} sessões atingido. Tarefa bloqueada.`);
        return 'blocked';
      }
      const out = await this.runSession(this.store.getTask(taskId)!, epoch, adapter);
      if (this.stopping) return 'paused';
      if (out.kind === 'done') {
        this.setTaskStatus(taskId, 'done', `Tarefa concluída e verificada na sessão ${epoch}.`);
        return 'done';
      }
      if (out.kind === 'blocked') {
        this.setTaskStatus(taskId, 'blocked', `Tarefa bloqueada: ${out.reason}`);
        return 'blocked';
      }
      if (out.kind === 'paused') return this.pausedOut(taskId);
      this.bus.emit('supervisor.note', `Sessão ${epoch} encerrada (${out.reason}). Iniciando sessão nova com o pacote de continuidade.`, {
        taskId,
        data: { epoch, reason: out.reason },
      });
    }
  }

  private pausedOut(taskId: string): RunResult {
    this.setTaskStatus(taskId, 'queued', 'Tarefa pausada; volta para a fila até ser retomada.');
    return 'paused';
  }

  private async runSession(task: Task, epoch: number, adapter: ExecutorAdapter): Promise<Outcome> {
    const rec = this.store.createSession(task.id, epoch, adapter.kind);
    const token = randomUUID();
    const isSuccessor = epoch > 1;

    const exec = adapter.create({
      cwd: task.cwd,
      model: task.model,
      systemPrompt: EXECUTOR_SYSTEM_PROMPT,
      gate: { url: this.cfg.url, token, epoch, hookScript: this.cfg.hookScript },
      permissionMode: this.cfg.permissionMode,
      tools: this.cfg.tools,
      allowedTools: this.cfg.allowedTools,
    });
    const s: LiveSession = {
      token,
      task,
      rec,
      phase: 'starting',
      drainReason: null,
      exec,
      ctxTokens: 0,
      ctxWindow: this.knownWindow.get(task.model) ?? this.cfg.defaultWindow,
      lastCtxBucket: -1,
      stderrTail: [],
    };
    this.live.set(token, s);
    this.wire(s);

    let reason = 'unknown';
    try {
      exec.start();
      this.store.updateSession(rec.id, { pid: exec.pid });
      this.bus.emit('session.started', `Sessão ${epoch} iniciada${isSuccessor ? ' como sucessora (nova, sem --resume)' : ''}.`, {
        taskId: task.id,
        sessionId: rec.id,
        data: { epoch, model: task.model, pid: exec.pid, executor: adapter.kind },
      });
      const out = await this.drive(s, isSuccessor);
      reason = s.endReason ?? out.reason;
      return out;
    } catch (err) {
      reason = `supervisor error: ${(err as Error).message}`;
      return { kind: 'handoff', reason };
    } finally {
      // Order matters: lock tools, stop the process tree, then classify anything in flight.
      this.setPhase(s, 'closed');
      await exec.close();
      const nUncertain = this.store.markSessionOpsUncertain(rec.id);
      this.store.endSession(rec.id, reason);
      this.live.delete(token);
      this.bus.emit(
        'session.ended',
        `Sessão ${epoch} finalizada: ${reason}.${nUncertain ? ` ${nUncertain} operação(ões) com resultado incerto.` : ''}`,
        { taskId: task.id, sessionId: rec.id, data: { epoch, reason, uncertainOps: nUncertain, stderrTail: s.stderrTail } },
      );
    }
  }

  // Handoff Markdown is always generated from SQLite; never from a transcript.
  handoffFor(taskId: string, epoch?: number): string {
    const task = this.store.getTask(taskId)!;
    return buildContinuityPackage(task, this.store.listCheckpoints(taskId), this.store.listOps(taskId), epoch ?? task.leaseEpoch + 1);
  }

  private async drive(s: LiveSession, isSuccessor: boolean): Promise<Outcome> {
    const task = s.task;
    let r: TurnOutcome;

    if (isSuccessor) {
      const checkpoints = this.store.listCheckpoints(task.id);
      const ops = this.store.listOps(task.id);
      const uncertain = ops.filter((o) => o.status === 'uncertain');
      const lastCheckpointId = checkpoints.at(-1)?.id ?? 'none';
      const pkg = buildContinuityPackage(task, checkpoints, ops, s.rec.epoch);
      writeFileSync(join(this.cfg.handoffDir, `${task.id}-epoch${s.rec.epoch}.md`), pkg, 'utf8');
      this.store.updateSession(s.rec.id, { handoffMd: pkg, ackStatus: 'pending' });
      this.setPhase(s, 'validating');
      this.setTaskStatus(task.id, 'validating', `Sessão ${s.rec.epoch} lendo o handoff; escrita bloqueada até validar o resume_ack.`);
      r = await this.turn(s, pkg);
      for (let attempt = 0; ; attempt++) {
        if (this.paused(task.id)) return { kind: 'paused', reason: 'paused by operator' };
        if (typeof r === 'string') return { kind: 'handoff', reason: `session ${r} during resume validation` };
        const { ack, errors } = validateResumeAck(r.text, task, lastCheckpointId, uncertain.length > 0);
        if (ack) {
          this.store.acknowledgeUncertainOps(task.id);
          this.store.updateSession(s.rec.id, { ackStatus: 'validated', ack });
          this.bus.emit('handoff.validated', `Retomada validada campo a campo. Próxima ação: ${ack.next_action}`, {
            taskId: task.id,
            sessionId: s.rec.id,
            data: { ack, uncertainOps: uncertain.map((o) => ({ id: o.toolUseId, tool: o.tool, input: describeOp(o) })) },
          });
          break;
        }
        this.bus.emit('handoff.rejected', `Retomada rejeitada: ${errors.join('; ')}`, {
          taskId: task.id,
          sessionId: s.rec.id,
          data: { errors, attempt },
        });
        if (attempt >= 1) {
          this.store.updateSession(s.rec.id, { ackStatus: 'rejected' });
          return { kind: 'blocked', reason: `resume validation failed: ${errors.join('; ')}` };
        }
        r = await this.turn(
          s,
          `${DENY_PREFIX} resume_ack rejected:\n${errors.map((e) => `- ${e}`).join('\n')}\nReply again with ONLY the corrected resume_ack block.`,
        );
      }
      this.setPhase(s, 'active');
      this.setTaskStatus(task.id, 'running', `Sessão ${s.rec.epoch} liberada para escrever.`);
      r = await this.turn(
        s,
        `${DENY_PREFIX} validation passed, writes unlocked. Proceed with your next_action. End every turn with the checkpoint block.`,
      );
    } else {
      this.setPhase(s, 'active');
      r = await this.turn(s, initialPrompt(task));
    }

    let nudges = 0;
    let verifyFailures = 0;
    for (let turns = 1; ; ) {
      if (r === 'timeout') {
        s.drainReason = 'timeout';
        this.setPhase(s, 'draining');
        s.exec.interrupt();
        r = await this.waitTurn(s, this.cfg.drainTimeoutMs);
        if (typeof r === 'string') return { kind: 'handoff', reason: 'turn timeout' };
      }
      if (typeof r === 'string') return { kind: 'handoff', reason: 'process exited unexpectedly' };

      const { value, errors } = parseCheckpoint(r.text);
      if (!value) {
        if (nudges++ >= 2) return { kind: 'handoff', reason: 'no valid checkpoint after 3 attempts' };
        r = await this.turn(s, `${DENY_PREFIX} your reply lacked a valid checkpoint block (${errors.join('; ')}). Reply now with ONLY the checkpoint block.`);
        continue;
      }
      nudges = 0;

      const cp = this.store.addCheckpoint(task.id, s.rec.id, s.rec.epoch, value);
      const learned = this.store.addLearnedConstraints(task.id, value.learned_constraints);
      s.task = this.store.getTask(task.id)!;
      this.bus.emit('checkpoint.saved', `Checkpoint salvo: ${value.summary}`, {
        taskId: task.id,
        sessionId: s.rec.id,
        data: { checkpointId: cp.id, status: value.status, next: value.next_action, ctxTokens: s.ctxTokens },
      });
      for (const c of learned) {
        this.bus.emit('constraint.learned', `Nova restrição permanente ${c.id}: ${c.text}`, { taskId: task.id, sessionId: s.rec.id, data: { ...c } });
      }

      if (value.status === 'done') {
        const v = await this.verify(s.task, s.rec.id);
        if (!v || v.ok) return { kind: 'done', reason: 'done' };
        if (++verifyFailures >= 3) return { kind: 'blocked', reason: 'supervisor verification failed 3 times' };
        if (s.phase === 'draining' || this.paused(task.id)) return { kind: this.paused(task.id) ? 'paused' : 'handoff', reason: 'verification failed' };
        r = await this.turn(
          s,
          `${DENY_PREFIX} you reported done, but the supervisor's own check failed:\n$ ${v.command}\n${v.output.slice(-1500)}\nFix it, then end the turn with a new checkpoint.`,
        );
        continue;
      }
      if (value.status === 'blocked') return { kind: 'blocked', reason: value.summary };
      if (this.paused(task.id)) return { kind: 'paused', reason: 'paused by operator' };
      if (s.phase === 'draining' || s.ctxTokens >= this.budget(s)) return { kind: 'handoff', reason: 'context budget' };
      if (++turns > this.cfg.maxTurnsPerSession) return { kind: 'handoff', reason: 'turn limit' };

      r = await this.turn(s, `${DENY_PREFIX} checkpoint ${cp.id} saved. Continue with your next_action.`);
    }
  }

  // The supervisor's own check: runs the task's verify command, independent of the model.
  private async verify(task: Task, sessionId: string): Promise<VerifyResult | null> {
    if (!task.verifyCmd) return null;
    this.setTaskStatus(task.id, 'validating', `Verificando a entrega: ${task.verifyCmd}`);
    this.bus.emit('verify.started', `Supervisor rodando a verificação da tarefa.`, { taskId: task.id, sessionId, data: { command: task.verifyCmd } });
    const v = await runCommand(task.verifyCmd, task.cwd, this.cfg.verifyTimeoutMs);
    this.store.setLastVerify(task.id, v);
    this.bus.emit('verify.finished', v.ok ? `Verificação passou: ${lastLine(v.output)}` : `Verificação falhou: ${lastLine(v.output)}`, {
      taskId: task.id,
      sessionId,
      data: { ...v },
    });
    if (!v.ok) this.setTaskStatus(task.id, 'running', 'Verificação falhou; executor vai corrigir.');
    return v;
  }

  private paused(taskId: string) {
    return !!this.store.getTask(taskId)?.paused;
  }

  private wire(s: LiveSession) {
    const { exec, task, rec } = s;
    exec.on('init', (id) => this.store.updateSession(rec.id, { claudeSessionId: id }));
    exec.on('context', (tokens) => this.onContext(s, tokens));
    exec.on('result', (r) => {
      if (r.contextWindow && r.contextWindow !== s.ctxWindow) {
        s.ctxWindow = r.contextWindow;
        this.knownWindow.set(task.model, r.contextWindow);
        if (r.model) this.knownWindow.set(r.model, r.contextWindow);
        this.store.updateSession(rec.id, { ctxWindow: r.contextWindow });
      }
    });
    exec.on('tool_use', (t) => {
      this.store.opStarted({ toolUseId: t.id, taskId: task.id, sessionId: rec.id, epoch: rec.epoch, tool: t.name, input: JSON.stringify(t.input ?? {}) });
      this.bus.emit('tool.started', `${t.name} ${describeOp({ tool: t.name, input: JSON.stringify(t.input ?? {}) })}`.trim(), {
        taskId: task.id,
        sessionId: rec.id,
        data: { tool: t.name, toolUseId: t.id },
      });
    });
    exec.on('tool_result', (t) => {
      this.store.opFinished(t.id, t.isError);
      this.bus.emit('tool.finished', t.isError ? 'Ferramenta retornou erro.' : 'Ferramenta concluída.', {
        taskId: task.id,
        sessionId: rec.id,
        data: { toolUseId: t.id, isError: t.isError },
      });
    });
    exec.on('stderr', (line) => {
      s.stderrTail.push(line);
      if (s.stderrTail.length > 20) s.stderrTail.shift();
    });
  }

  private onContext(s: LiveSession, tokens: number) {
    s.ctxTokens = tokens;
    this.store.updateSession(s.rec.id, { ctxTokens: tokens, ctxWindow: s.ctxWindow });
    const budget = this.budget(s);
    const bucket = Math.floor((tokens / budget) * 10);
    if (bucket !== s.lastCtxBucket) {
      s.lastCtxBucket = bucket;
      this.bus.emit(
        'session.context',
        `Contexto da sessão ${s.rec.epoch}: ${tokens.toLocaleString('pt-BR')} tokens (${Math.round((tokens / budget) * 100)}% do orçamento).`,
        { taskId: s.task.id, sessionId: s.rec.id, data: { tokens, window: s.ctxWindow, budget } },
      );
    }
    if (s.phase === 'active' && tokens >= budget) {
      s.drainReason = 'budget';
      this.setPhase(s, 'draining');
      this.bus.emit('handoff.started', `Orçamento de contexto atingido (${tokens.toLocaleString('pt-BR')} ≥ ${budget.toLocaleString('pt-BR')}). Drenando sessão para handoff.`, {
        taskId: s.task.id,
        sessionId: s.rec.id,
        data: { tokens, budget },
      });
    }
  }

  private budget(s: LiveSession) {
    return this.budgetFor(s.ctxWindow);
  }

  private setPhase(s: LiveSession, phase: SessionPhase) {
    if (s.phase === phase) return;
    s.phase = phase;
    this.store.updateSession(s.rec.id, { phase });
    this.bus.emit('session.phase', `Sessão ${s.rec.epoch}: fase ${phase}${phase === 'draining' && s.drainReason ? ` (${s.drainReason})` : ''}.`, {
      taskId: s.task.id,
      sessionId: s.rec.id,
      data: { phase, drainReason: s.drainReason },
    });
  }

  setTaskStatus(taskId: string, status: TaskStatus, narration: string) {
    const prev = this.store.getTask(taskId)?.status;
    this.store.setTaskStatus(taskId, status);
    if (prev !== status) this.bus.emit('task.status', narration, { taskId, data: { status, prev } });
  }

  private turn(s: LiveSession, text: string): Promise<TurnOutcome> {
    const p = this.waitTurn(s, this.cfg.turnTimeoutMs);
    s.exec.send(text);
    return p;
  }

  private waitTurn(s: LiveSession, timeoutMs: number): Promise<TurnOutcome> {
    return new Promise((resolve) => {
      if (!s.exec.alive) return resolve('exit');
      const done = (v: TurnOutcome) => {
        clearTimeout(timer);
        s.exec.off('result', onResult);
        s.exec.off('exit', onExit);
        resolve(v);
      };
      const onResult = (r: TurnResult) => done(r);
      const onExit = () => done('exit');
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      s.exec.on('result', onResult);
      s.exec.on('exit', onExit);
    });
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const p = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = '';
    const add = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 20_000) out = out.slice(-10_000);
    };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => {
      out += `\n[timeout after ${timeoutMs}ms]`;
      if (p.pid) killTree(p.pid);
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, command, output: out.trim().slice(-4000), at: new Date().toISOString() });
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, command, output: err.message, at: new Date().toISOString() });
    });
  });
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).at(-1)?.slice(0, 160) ?? '';
