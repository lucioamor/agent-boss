import type { EventBus } from './bus.ts';
import { TERMINAL, type ExecutorKind, type Task } from './contracts.ts';
import type { Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';

export interface TaskSpec {
  goal: string;
  done: string;
  cwd: string;
  constraints?: string[];
  verify?: string;
  model?: string;
  executor?: ExecutorKind;
  // Independent pieces of a larger task. Two or more parts fan out into child tasks, each
  // with its own executor. A small task (no parts) runs with exactly one executor.
  parts?: Array<{ goal: string; done: string; verify?: string; constraints?: string[] }>;
}

// Picks runnable tasks from the queue and runs up to `parallel` of them at once.
// Each task holds at most one live executor at a time (its lease), so tasks never share one.
export class Orchestrator {
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly waiters = new Set<() => void>();
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly supervisor: Supervisor;
  parallel: number;
  // When set (run/resume/batch), only these tasks and their parts are scheduled.
  scope: Set<string> | null = null;

  constructor(store: Store, bus: EventBus, supervisor: Supervisor, parallel: number) {
    this.store = store;
    this.bus = bus;
    this.supervisor = supervisor;
    this.parallel = parallel;
  }

  submit(spec: TaskSpec, defaults: { model: string }): Task {
    const base = {
      cwd: spec.cwd,
      model: spec.model ?? defaults.model,
      executor: spec.executor ?? 'claude',
    } as const;
    const parts = spec.parts ?? [];
    if (parts.length >= 2) {
      const parent = this.store.createTask({ ...base, goal: spec.goal, doneCriteria: spec.done, verifyCmd: spec.verify, constraints: spec.constraints ?? [] });
      this.bus.emit('task.created', `Tarefa grande dividida em ${parts.length} partes independentes: ${spec.goal.slice(0, 70)}`, {
        taskId: parent.id,
        data: { parts: parts.length },
      });
      for (const p of parts) {
        const child = this.store.createTask({
          ...base,
          parentId: parent.id,
          goal: p.goal,
          doneCriteria: p.done,
          verifyCmd: p.verify,
          constraints: [...(spec.constraints ?? []), ...(p.constraints ?? [])],
        });
        this.bus.emit('task.created', `Parte na fila: ${p.goal.slice(0, 80)}`, { taskId: child.id, data: { parentId: parent.id } });
      }
      this.tick();
      return parent;
    }
    const task = this.store.createTask({ ...base, goal: spec.goal, doneCriteria: spec.done, verifyCmd: spec.verify, constraints: spec.constraints ?? [] });
    this.bus.emit('task.created', `Nova tarefa na fila: ${task.goal.slice(0, 80)}`, { taskId: task.id, data: { constraints: task.constraints } });
    this.tick();
    return task;
  }

  pause(taskId: string) {
    const ids = [taskId, ...this.store.children(taskId).map((c) => c.id)];
    let ok = false;
    for (const id of ids) ok = this.supervisor.requestPause(id) || ok;
    this.tick();
    return ok;
  }

  resume(taskId: string) {
    const ids = [taskId, ...this.store.children(taskId).map((c) => c.id)];
    for (const id of ids) {
      const t = this.store.getTask(id);
      if (!t) continue;
      this.store.setPaused(id, false);
      if (t.status === 'blocked') this.supervisor.setTaskStatus(id, 'queued', 'Tarefa bloqueada devolvida à fila pelo operador.');
    }
    this.bus.emit('task.resumed', 'Tarefa retomada; volta a ser elegível para um executor.', { taskId });
    this.tick();
  }

  // Re-queue a task explicitly (CLI `resume --task`).
  requeue(taskId: string) {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    if (t.status !== 'done') this.resume(taskId);
  }

  tick() {
    if (this.supervisor.stopping) return;
    this.rollupParents();
    const runnable = this.store
      .listTasks()
      .filter((t) => t.status === 'queued' && !t.paused && !this.running.has(t.id) && this.store.children(t.id).length === 0)
      .filter((t) => !this.scope || this.scope.has(t.id) || (t.parentId !== null && this.scope.has(t.parentId)));
    for (const t of runnable) {
      if (this.running.size >= this.parallel) break;
      const p = this.supervisor
        .runTask(t.id)
        .catch((err) => this.bus.emit('supervisor.note', `Erro ao rodar tarefa: ${(err as Error).message}`, { taskId: t.id }))
        .finally(() => {
          this.running.delete(t.id);
          this.tick();
        });
      this.running.set(t.id, p);
    }
    for (const w of this.waiters) w();
  }

  // Resolves when every running task loop has returned (used before exiting the process).
  async drain(timeoutMs = 25_000) {
    await Promise.race([Promise.allSettled([...this.running.values()]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  activeCount() {
    return this.running.size;
  }

  // Parent tasks are containers: their status is derived from their parts.
  private rollupParents() {
    for (const t of this.store.listTasks()) {
      const kids = this.store.children(t.id);
      if (!kids.length) continue;
      const next = kids.every((k) => k.status === 'done')
        ? 'done'
        : kids.some((k) => k.status === 'blocked') && kids.every((k) => TERMINAL.has(k.status))
          ? 'blocked'
          : kids.some((k) => k.status === 'running' || k.status === 'validating')
            ? 'running'
            : 'queued';
      if (next !== t.status) {
        const n = kids.filter((k) => k.status === 'done').length;
        this.supervisor.setTaskStatus(t.id, next, next === 'done' ? `Todas as ${kids.length} partes concluídas.` : `Partes concluídas: ${n}/${kids.length}.`);
      }
    }
  }

  // Resolves when every listed task is terminal or paused and nothing of it is running.
  waitFor(ids: string[]): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const all = ids.flatMap((id) => [id, ...this.store.children(id).map((c) => c.id)]);
        const settled = all.every((id) => {
          const t = this.store.getTask(id);
          return !t || ((TERMINAL.has(t.status) || t.paused) && !this.running.has(id));
        });
        if (settled) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
  }
}
