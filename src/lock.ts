import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { isAlive, processName } from './proc.ts';

// Enforces the single-writer rule: one supervisor process per database.
export function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
        } catch {}
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(path, 'utf8').trim());
      const name = pid && isAlive(pid) ? processName(pid) : null;
      if (name && /node/i.test(name)) {
        throw new Error(`another supervisor (pid ${pid}) owns this database; stop it first or use its board`);
      }
      unlinkSync(path); // stale lock left by a dead supervisor
    }
  }
  throw new Error(`could not acquire ${path}`);
}
