// Read-only evidence dump from a supervisor database (never writes: single-writer rule).
// usage: node scripts/evidence.mjs <db> [taskId] [workdir]
import { DatabaseSync } from 'node:sqlite';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [dbPath, taskArg, workdir] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);
const tasks = taskArg ? q(`SELECT * FROM tasks WHERE id = ?`, taskArg) : q(`SELECT * FROM tasks ORDER BY created_at`);

for (const t of tasks) {
  console.log(`\n=== task ${t.id}  status=${t.status}  lease_epoch=${t.lease_epoch}  parent=${t.parent_id ?? '-'}`);
  console.log('constraints:');
  for (const c of JSON.parse(t.constraints)) console.log(`  ${c.id}: ${c.text}`);
  if (t.last_verify) {
    const v = JSON.parse(t.last_verify);
    console.log(`last_verify: ok=${v.ok} cmd=${v.command}\n  ${v.output.split('\n').at(-1)}`);
  }
  console.log('sessions:');
  for (const s of q(`SELECT * FROM sessions WHERE task_id = ? ORDER BY epoch`, t.id)) {
    const ack = s.ack ? JSON.parse(s.ack) : null;
    console.log(
      `  epoch ${s.epoch} ${s.id} pid=${s.pid} ctx=${s.ctx_tokens}/${s.ctx_window} ack=${s.ack_status}` +
        `${ack ? ` [cp=${ack.checkpoint_id} ids=${ack.constraint_ids.join(',')}${ack.uncertain_ops_plan ? ' uncertain_plan=yes' : ''}]` : ''}` +
        ` ${s.started_at.slice(11, 19)}→${(s.ended_at ?? '').slice(11, 19)} end=${s.end_reason}`,
    );
  }
  const ops = q(`SELECT * FROM ops WHERE task_id = ? ORDER BY started_at, rowid`, t.id);
  const byStatus = {};
  for (const o of ops) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  console.log(`ops: ${ops.length} ${JSON.stringify(byStatus)}`);
  const unc = ops.filter((o) => o.uncertain_at);
  for (const o of unc) console.log(`  uncertain op ${o.tool_use_id} epoch ${o.epoch} ${o.tool} ${o.input.slice(0, 120)} status_now=${o.status} uncertain_at=${o.uncertain_at}`);
  const writes = {};
  for (const o of ops.filter((o) => ['Write', 'Edit', 'MultiEdit'].includes(o.tool))) {
    const f = JSON.parse(o.input).file_path;
    (writes[f] ??= []).push(`${o.tool}@e${o.epoch}:${o.status}`);
  }
  const multi = Object.entries(writes).filter(([, v]) => v.filter((x) => x.endsWith(':done')).length > 1);
  console.log(`write ops: ${Object.keys(writes).length} files; files with >1 successful write: ${multi.length}`);
  for (const [f, v] of Object.entries(writes)) console.log(`  ${f.split(/[\/]/).at(-1)}: ${v.join(' ')}`);
  const cps = q(`SELECT id, epoch, data FROM checkpoints WHERE task_id = ? ORDER BY created_at, rowid`, t.id);
  console.log(`checkpoints: ${cps.length} (last ${cps.at(-1)?.id ?? '-'}: ${cps.at(-1) ? JSON.parse(cps.at(-1).data).status : '-'})`);
  const denied = q(`SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'tool.denied'`, t.id)[0].n;
  const rejected = q(`SELECT COUNT(*) n FROM events WHERE task_id = ? AND type = 'handoff.rejected'`, t.id)[0].n;
  console.log(`events: tool.denied=${denied} handoff.rejected=${rejected}`);
}

if (workdir) {
  console.log(`\nfiles in ${workdir} (birthtime vs mtime; equal ⇒ written once):`);
  for (const f of readdirSync(workdir).filter((f) => /\.(md|txt)$/.test(f)).sort()) {
    const st = statSync(join(workdir, f));
    const delta = Math.abs(st.mtimeMs - st.birthtimeMs);
    console.log(`  ${f.padEnd(14)} born ${st.birthtime.toISOString().slice(11, 23)} mtime ${st.mtime.toISOString().slice(11, 23)} Δ=${delta.toFixed(0)}ms`);
  }
}
