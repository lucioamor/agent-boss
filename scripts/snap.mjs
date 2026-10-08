// Screenshot the board in headless Chrome (DevTools protocol, no deps).
// usage: node scripts/snap.mjs <out.png> [width] [height] [jsBeforeShot]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [out, w = '1440', h = '900', js = ''] = process.argv.slice(2);
const URL = process.env.BOARD_URL ?? 'http://127.0.0.1:7777';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'agent-boss-snap-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const x = JSON.parse(m.data); if (x.id) pending.get(x.id)?.(x); });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, (x) => res(x.result ?? x)); ws.send(JSON.stringify({ id, method, params })); });
try {
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 700 });
  await send('Page.navigate', { url: URL });
  await sleep(3000);
  if (js) console.log(JSON.stringify((await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true, replMode: true })).result?.value, null, 1));
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`saved ${out}`);
} finally {
  ws.close(); chrome.kill(); await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
