// Supervisor-side checks for the orchestration batch. usage: node verify.mjs <primes|fib|squares|hello>
import { readFileSync } from 'node:fs';
const kind = process.argv[2];
const expected = {
  primes: [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71].join('\n'),
  fib: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765].join('\n'),
  squares: Array.from({ length: 20 }, (_, i) => (i + 1) ** 2).join('\n'),
  hello: 'ok',
}[kind];
const file = { primes: 'primes.txt', fib: 'fib.txt', squares: 'squares.txt', hello: 'hello.txt' }[kind];
let got = '';
try { got = readFileSync(file, 'utf8').trim().replace(/\r\n/g, '\n'); } catch { console.log(`FAIL ${file} missing`); process.exit(1); }
if (got !== expected) { console.log(`FAIL ${file} content mismatch`); process.exit(1); }
console.log(`OK ${file}`);
