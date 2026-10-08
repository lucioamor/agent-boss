// Keeps `main.ts serve` alive so the board can restart its own server.
//   exit code 75 -> restart requested from the board: respawn right away
//   exit code 0  -> stop requested: the daemon exits too
//   anything else -> crash: respawn with backoff (recovery closes orphans on start)
// usage: node src/daemon.ts [serve options...]   (logs to data/agent-boss.log)
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const log = createWriteStream(join(dataDir, 'agent-boss.log'), { flags: 'a' });
const pidFile = join(dataDir, 'daemon.pid');
writeFileSync(pidFile, String(process.pid), 'utf8');
process.on('exit', () => rmSync(pidFile, { force: true }));

const RESTART = 75;
const args = process.argv.slice(2);
const crashes: number[] = [];
const say = (m: string) => log.write(`[daemon ${new Date().toISOString()}] ${m}\n`);

let child: ReturnType<typeof spawn> | null = null;
const forward = (sig: NodeJS.Signals) => () => {
  child?.kill(sig);
  process.exit(0);
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

function run() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src', 'main.ts'), 'serve', ...args], {
    cwd: root,
    env: { ...process.env, AGENT_BOSS_DAEMON: String(process.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  say(`started server pid ${child.pid}`);
  child.on('exit', (code) => {
    say(`server exited with code ${code}`);
    if (code === 0) return process.exit(0);
    if (code === RESTART) return setTimeout(run, 300);
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    if (crashes.length > 5) {
      say('server crashed more than 5 times in 60s; giving up');
      return process.exit(1);
    }
    setTimeout(run, 1000 * crashes.length);
  });
}
run();
