import { spawnSync } from 'node:child_process';

// Process helpers. Windows needs taskkill /T: the CLI owns child processes (Bash tool, hooks).

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Image name of a live process ("claude.exe", "node.exe"), or null when not running.
export function processName(pid: number): string | null {
  if (process.platform !== 'win32') return isAlive(pid) ? 'unknown' : null;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout ?? '');
  return m && Number(m[2]) === pid ? m[1] : null;
}

export function killTree(pid: number): boolean {
  if (!isAlive(pid)) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return r.status === 0;
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
