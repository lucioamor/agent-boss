import type { Checkpoint, CheckpointData, Op, ResumeAck, Task } from './contracts.ts';

export const DENY_PREFIX = 'SUPERVISOR:';

export const EXECUTOR_SYSTEM_PROMPT = `
# Executor protocol (agent-boss supervisor)

You are an EXECUTOR session run by a local supervisor. Your context window is disposable:
the supervisor persists your progress and will replace you with a fresh session when the
context budget is reached. The next session sees ONLY what you put in checkpoints plus the
supervisor's own operation log.

Rules:
1. Work only on the assigned task. Obey every constraint (ids C* and L*).
2. Work in increments. After each meaningful deliverable, end your turn. The supervisor
   will tell you to continue.
3. EVERY final reply of a turn MUST end with exactly one fenced block tagged \`checkpoint\`
   containing JSON with these keys:
   - "status": "in_progress" | "done" | "blocked"
   - "summary": one or two sentences on the current state
   - "decisions": [{"what": "...", "why": "..."}]  (decisions taken this turn, short)
   - "evidence": ["file paths, commands, outputs supporting your conclusions"]
   - "pending": ["open hypotheses or questions"]
   - "discarded": ["alternatives ruled out, with the reason"]
   - "changes": ["side effects made this turn: files written, commands run that changed state"]
   - "verified": ["checks actually executed, with result"]
   - "learned_constraints": ["NEW hard rules discovered during the work that every future session must obey"]
   - "next_action": "one concrete next step"
   Record conclusions, not your thought process. Be compact.
4. "done" only when the done criteria are met AND verified (list the checks in "verified").
5. If a tool call is denied with a reason starting "${DENY_PREFIX}", obey that reason exactly
   and do not retry the call.
`.trim();

export function initialPrompt(task: Task): string {
  return [
    `# Task ${task.id}`,
    `## Goal`,
    task.goal,
    `## Done criteria`,
    task.doneCriteria,
    `## Constraints`,
    formatConstraints(task),
    ``,
    `Start working. Remember: end every turn with the \`checkpoint\` block.`,
  ].join('\n');
}

export function formatConstraints(task: Task): string {
  return task.constraints.length ? task.constraints.map((c) => `- [${c.id}] ${c.text}`).join('\n') : '- (none)';
}

const SIDE_EFFECT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);

// Ground truth from the supervisor's op log: side effects that completed, in order.
function completedSideEffects(ops: Op[]): string[] {
  return ops
    .filter((o) => SIDE_EFFECT_TOOLS.has(o.tool) && (o.status === 'done' || o.status === 'error'))
    .map((o) => `[epoch ${o.epoch}] ${o.tool} ${describeOp(o)}${o.status === 'error' ? ' (returned error)' : ''}`);
}

export function describeOp(o: Pick<Op, 'tool' | 'input'>): string {
  try {
    const i = JSON.parse(o.input) as Record<string, unknown>;
    const v = i.file_path ?? i.notebook_path ?? i.command ?? i.path ?? '';
    return truncate(String(v), 200);
  } catch {
    return truncate(o.input, 200);
  }
}

// The selected, small package a fresh session receives. Never the transcript.
// Generated from SQLite on demand (board "inspect handoff" uses the same function).
export function buildContinuityPackage(task: Task, checkpoints: Checkpoint[], ops: Op[], epoch: number): string {
  const last = checkpoints.at(-1);
  const uncertain = ops.filter((o) => o.status === 'uncertain');
  const decisions = dedupe(checkpoints.flatMap((c) => c.data.decisions.map((d) => (d.why ? `${d.what} — ${d.why}` : d.what)))).slice(-20);
  const changes = dedupe(checkpoints.flatMap((c) => c.data.changes)).slice(-40);
  const verified = dedupe(checkpoints.flatMap((c) => c.data.verified)).slice(-20);
  const discarded = dedupe(checkpoints.flatMap((c) => c.data.discarded)).slice(-15);
  const applied = completedSideEffects(ops).slice(-60);

  const lines = [
    `# Handoff — task ${task.id}, session epoch ${epoch}`,
    `You are a fresh session replacing a previous one (its context budget ran out, it was paused,`,
    `or the supervisor restarted). Everything known about prior work is below. Do not redo listed changes.`,
    ``,
    `## Goal`,
    task.goal,
    `## Done criteria`,
    task.doneCriteria,
    `## Constraints (all mandatory, C* = user, L* = learned and permanent)`,
    formatConstraints(task),
    ``,
    `## Latest checkpoint: ${last ? last.id : 'none'}`,
  ];
  if (last) {
    const d = last.data;
    lines.push(`- status: ${d.status}`, `- summary: ${d.summary}`, `- next action: ${d.next_action}`, ...section('Pending', d.pending), ...section('Evidence', d.evidence));
  } else {
    lines.push(`(No checkpoint yet. Inspect the working directory to establish state.)`);
  }
  if (task.lastVerify) {
    lines.push(``, `## Last supervisor verification`, `- ${task.lastVerify.ok ? 'PASSED' : 'FAILED'}: \`${task.lastVerify.command}\``, '```', truncate(task.lastVerify.output, 800), '```');
  }
  lines.push(
    ...section('Decisions so far', decisions),
    ...section('Changes reported by previous sessions (do NOT repeat)', changes),
    ...section('Side effects confirmed by the supervisor op log (do NOT repeat)', applied),
    ...section('Verified so far', verified),
    ...section('Discarded alternatives', discarded),
  );
  if (uncertain.length) {
    lines.push(
      ``,
      `## Operations with UNCERTAIN outcome`,
      `These started but the session ended before their result was seen (budget handoff or supervisor crash).`,
      `Verify their effect read-only before doing anything that depends on them. Do not blindly re-run them.`,
      ...uncertain.map((o) => `- [${o.toolUseId}] epoch ${o.epoch} ${o.tool}: ${describeOp(o)}`),
    );
  }
  lines.push(
    ``,
    `## Your first reply`,
    `Writes are LOCKED until the supervisor validates your understanding. You may use read-only tools`,
    `(Read, Grep, Glob) to check state. Then reply with ONLY a fenced block tagged \`resume_ack\`:`,
    '```resume_ack',
    JSON.stringify(
      {
        checkpoint_id: last?.id ?? 'none',
        goal: '<goal in your own words>',
        constraint_ids: task.constraints.map((c) => c.id),
        next_action: '<the concrete next step you will take>',
        uncertain_ops_plan: uncertain.length ? '<how you will verify each uncertain operation>' : '',
      },
      null,
      2,
    ),
    '```',
  );
  return lines.join('\n');
}

export function extractBlock(text: string, tag: string): unknown | null {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)\\n\\s*```', 'g');
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1];
  if (last === null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

export function parseCheckpoint(text: string): { value: CheckpointData | null; errors: string[] } {
  const raw = extractBlock(text, 'checkpoint') as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return { value: null, errors: ['missing or invalid ```checkpoint JSON block'] };
  const errors: string[] = [];
  if (!['in_progress', 'done', 'blocked'].includes(raw.status as string)) errors.push('status must be in_progress|done|blocked');
  if (!str(raw.summary)) errors.push('summary is required');
  if (!str(raw.next_action) && raw.status !== 'done') errors.push('next_action is required');
  const arr = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);
  const decisions = Array.isArray(raw.decisions)
    ? (raw.decisions as any[]).map((d) => (typeof d === 'string' ? { what: d, why: '' } : { what: String(d?.what ?? ''), why: String(d?.why ?? '') }))
    : [];
  const value: CheckpointData = {
    status: raw.status as CheckpointData['status'],
    summary: String(raw.summary ?? ''),
    decisions,
    evidence: arr('evidence'),
    pending: arr('pending'),
    discarded: arr('discarded'),
    changes: arr('changes'),
    verified: arr('verified'),
    learned_constraints: arr('learned_constraints'),
    next_action: String(raw.next_action ?? ''),
  };
  if (value.status === 'done' && value.verified.length === 0) errors.push('status "done" requires at least one entry in "verified"');
  return { value: errors.length ? null : value, errors };
}

// Structural check, not persuasion: ids must match what the supervisor actually sent.
export function validateResumeAck(
  text: string,
  task: Task,
  checkpointId: string,
  hasUncertainOps: boolean,
): { ack: ResumeAck | null; errors: string[] } {
  const raw = extractBlock(text, 'resume_ack') as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return { ack: null, errors: ['missing or invalid ```resume_ack JSON block'] };
  const errors: string[] = [];
  if (raw.checkpoint_id !== checkpointId) errors.push(`checkpoint_id must be "${checkpointId}", got "${String(raw.checkpoint_id)}"`);
  if (!str(raw.goal) || placeholder(raw.goal)) errors.push('goal is required (in your own words)');
  if (!str(raw.next_action) || placeholder(raw.next_action)) errors.push('next_action must be a concrete step');
  const expected = task.constraints.map((c) => c.id).sort();
  const got = Array.isArray(raw.constraint_ids) ? (raw.constraint_ids as unknown[]).map(String).sort() : [];
  const missing = expected.filter((id) => !got.includes(id));
  const unknown = got.filter((id) => !expected.includes(id));
  if (missing.length) errors.push(`constraint_ids missing: ${missing.join(', ')}`);
  if (unknown.length) errors.push(`constraint_ids unknown: ${unknown.join(', ')}`);
  if (hasUncertainOps && (!str(raw.uncertain_ops_plan) || placeholder(raw.uncertain_ops_plan))) {
    errors.push('uncertain_ops_plan is required: say how you will verify the uncertain operations');
  }
  const ack: ResumeAck = {
    checkpoint_id: String(raw.checkpoint_id),
    goal: String(raw.goal ?? ''),
    constraint_ids: got,
    next_action: String(raw.next_action ?? ''),
    uncertain_ops_plan: raw.uncertain_ops_plan ? String(raw.uncertain_ops_plan) : '',
  };
  return { ack: errors.length ? null : ack, errors };
}

const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const placeholder = (v: unknown) => /^<.*>$/s.test(String(v).trim());
const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const section = (title: string, items: string[]) => (items.length ? [``, `## ${title}`, ...items.map((i) => `- ${i}`)] : []);
