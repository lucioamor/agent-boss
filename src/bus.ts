import type { EventType, SupervisorEvent } from './contracts.ts';
import type { Store } from './store.ts';

type Listener = (ev: SupervisorEvent) => void;

// Every state change goes through here: persisted first, then pushed to SSE subscribers.
export class EventBus {
  private listeners = new Set<Listener>();
  private readonly store: Store;
  private readonly log: (line: string) => void;

  constructor(store: Store, log: (line: string) => void = (l) => console.log(l)) {
    this.store = store;
    this.log = log;
  }

  emit(type: EventType, narration: string, ctx: { taskId?: string | null; sessionId?: string | null; data?: Record<string, unknown> } = {}) {
    const ev: SupervisorEvent = {
      ts: new Date().toISOString(),
      taskId: ctx.taskId ?? null,
      sessionId: ctx.sessionId ?? null,
      type,
      narration,
      data: ctx.data ?? {},
    };
    ev.id = this.store.addEvent(ev);
    this.log(`[${ev.ts.slice(11, 19)}] ${type.padEnd(18)} ${narration}`);
    for (const l of this.listeners) l(ev);
    return ev;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
