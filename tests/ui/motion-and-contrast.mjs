// UI check: drives the live board in headless Chrome over the DevTools protocol
// (Node's built-in WebSocket, no dependencies). Needs `node src/main.ts serve` running.
// Measures: shader frames while idle vs after real state changes, which CSS animations fire
// and why, text contrast over the brightest shader pixel, and prefers-reduced-motion.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const BOARD = process.env.BOARD_URL ?? 'http://127.0.0.1:7777';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = join(root, 'data', 'ui-screenshots');
mkdirSync(shots, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'agent-boss-cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,900',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try {
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
  } catch {}
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
  return `data/ui-screenshots/${name}`;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const INSTRUMENT = `(() => {
  window.__anim = []; window.__evs = [];
  document.addEventListener('animationstart', (e) => window.__anim.push({ name: e.animationName, cls: String(e.target.className), id: e.target.closest('.card')?.dataset.id ?? null, t: Date.now() }));
  window.addEventListener('supervisor-event', (e) => window.__evs.push({ type: e.detail.type, taskId: e.detail.taskId, t: Date.now(), status: e.detail.data?.status ?? null, phase: e.detail.data?.phase ?? null }));
  return true;
})()`;

// Worst-case contrast: brightest shader pixel composited under the narration panel.
const CONTRAST = `(() => {
  const c = document.getElementById('bg'); const gl = c.getContext('webgl');
  const px = new Uint8Array(c.width * c.height * 4); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  let max = [0, 0, 0], maxL = -1, min = [255, 255, 255], minL = 2;
  for (let i = 0; i < px.length; i += 4) { const l = L(px[i], px[i + 1], px[i + 2]); if (l > maxL) { maxL = l; max = [px[i], px[i + 1], px[i + 2]]; } if (l < minL) { minL = l; min = [px[i], px[i + 1], px[i + 2]]; } }
  const parse = (s) => s.match(/[\\d.]+/g).map(Number);
  const panel = parse(getComputedStyle(document.querySelector('aside')).backgroundColor);
  const a = panel[3] ?? 1; const comp = max.map((v, i) => panel[i] * a + v * (1 - a));
  const ratio = (c1, c2) => { const l1 = L(...c1), l2 = L(...c2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const text = parse(getComputedStyle(document.body).color); const muted = parse(getComputedStyle(document.querySelector('.muted')).color);
  return { brightestShaderPixel: max, darkestShaderPixel: min, panelAlpha: a, compositeBehindText: comp.map(Math.round),
    contrastText: +ratio(text, comp).toFixed(2), contrastMuted: +ratio(muted, comp).toFixed(2), contrastTextOnRawShader: +ratio(text, max).toFixed(2) };
})()`;

const submit = (n) => `fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-boss': '1' }, body: JSON.stringify({
  goal: 'Write hello.txt containing exactly the word ok.', done: 'hello.txt contains ok, verified by reading it back.',
  cwd: ${JSON.stringify(join(root, 'data', 'ui-work', `run${n}`).replaceAll('\\', '/'))},
  constraints: ['Only use the Read, Write and Glob tools.'], verify: 'node ${join(root, 'tests', 'orchestration', 'verify.mjs').replaceAll('\\', '/')} hello' }) }).then((r) => r.json()).then((j) => j.id)`;

async function scenario(label, n) {
  mkdirSync(join(root, 'data', 'ui-work', `run${n}`), { recursive: true });
  await send('Page.navigate', { url: BOARD });
  await sleep(2500);
  await evaluate(INSTRUMENT);
  const info = await evaluate(`({ webgl: window.__bg.webgl, reducedMotion: window.__bg.reducedMotion, mq: matchMedia('(prefers-reduced-motion: reduce)').matches })`);
  const idle0 = await evaluate('window.__bg.animFrames');
  await sleep(5000);
  const idle1 = await evaluate('window.__bg.animFrames');
  const taskId = await evaluate(submit(n));
  const timeline = [];
  let midShot = null, contrastPeak = null, peak = -1;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const s = await evaluate(`({ f: window.__bg.animFrames, p: window.__bg.pulses })`);
    timeline.push(s.f);
    if (!midShot && i > 2 && timeline.at(-1) > timeline.at(-3)) {
      midShot = await shot(`ui-${label}-pulse.png`);
      contrastPeak = await evaluate(CONTRAST);
    }
    const status = await evaluate(`fetch('/api/state').then((r) => r.json()).then((s) => s.tasks.find((t) => t.id === '${taskId}')?.status)`);
    if (status === 'done' || status === 'blocked') {
      peak = i;
      break;
    }
  }
  await sleep(5000); // let any pulse settle
  const settled0 = await evaluate('window.__bg.animFrames');
  await sleep(5000);
  const settled1 = await evaluate('window.__bg.animFrames');
  const idleShot = await shot(`ui-${label}-idle.png`);
  const contrastIdle = await evaluate(CONTRAST);
  const anim = await evaluate('window.__anim');
  const evs = await evaluate('window.__evs');
  // Every card animation must follow a real status/phase change of that card's task.
  const cardAnims = anim.filter((a) => a.id);
  const unexplained = cardAnims.filter(
    (a) => !evs.some((e) => e.taskId === a.id && ['task.status', 'session.phase'].includes(e.type) && a.t - e.t >= 0 && a.t - e.t < 2000),
  );
  const counts = (xs, k) => xs.reduce((o, x) => ((o[x[k]] = (o[x[k]] ?? 0) + 1), o), {});
  return {
    label, taskId, ...info,
    animFramesWhileIdle5s: idle1 - idle0,
    animFramesDuringRun: settled0 - idle1,
    animFramesAfterSettle5s: settled1 - settled0,
    pulses: await evaluate('window.__bg.pulses'),
    eventsSeen: counts(evs, 'type'),
    cssAnimations: counts(anim, 'name'),
    cardAnimations: cardAnims.map((a) => `${a.name}@${a.cls.split(' ').filter((c) => c !== 'card').join('.') || 'card'}`),
    unexplainedCardAnimations: unexplained.length,
    contrastPeak, contrastIdle, screenshots: [midShot, idleShot].filter(Boolean),
  };
}

const results = [];
try {
  results.push(await scenario('motion', 1));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  results.push(await scenario('reduced', 2));
} finally {
  ws.close();
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
writeFileSync(join(root, 'data', 'ui-motion.json'), JSON.stringify(results, null, 2), 'utf8');
console.log(JSON.stringify(results, null, 2));
