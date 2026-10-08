// Read-only: executor overlap per database. Shows max concurrent executors and per-task live sessions.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare(`SELECT s.id, s.task_id, s.epoch, s.pid, s.started_at, s.ended_at, s.end_reason, t.parent_id, substr(t.goal,1,40) goal
  FROM sessions s JOIN tasks t ON t.id = s.task_id ORDER BY s.started_at`).all();
for (const r of rows) console.log(`${r.task_id} parent=${r.parent_id ?? '-'} epoch=${r.epoch} pid=${r.pid} ${r.started_at.slice(11, 23)}→${r.ended_at.slice(11, 23)} ${r.end_reason} | ${r.goal}`);
const pts = rows.flatMap((r) => [[Date.parse(r.started_at), 1, r.task_id], [Date.parse(r.ended_at), -1, r.task_id]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let cur = 0, max = 0; const perTask = {}; let perTaskMax = 0;
for (const [, d, t] of pts) { cur += d; max = Math.max(max, cur); perTask[t] = (perTask[t] ?? 0) + d; perTaskMax = Math.max(perTaskMax, perTask[t]); }
const tasks = db.prepare(`SELECT t.id, t.parent_id, t.status, (SELECT COUNT(*) FROM sessions s WHERE s.task_id = t.id) sessions FROM tasks t ORDER BY created_at`).all();
console.log('tasks:', tasks.map((t) => `${t.id}${t.parent_id ? `(part of ${t.parent_id})` : ''} ${t.status} sessions=${t.sessions}`).join('; '));
console.log(`max concurrent executors: ${max}; max live sessions for a single task: ${perTaskMax}; distinct pids: ${new Set(rows.map((r) => r.pid)).size}/${rows.length}`);
