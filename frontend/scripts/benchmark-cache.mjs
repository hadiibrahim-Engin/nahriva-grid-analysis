import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
let writes = 0;
globalThis.sessionStorage = { getItem: () => null, setItem: () => { writes++; }, removeItem: () => {} };
const cache = await import(pathToFileURL(process.argv[2]).href);
const count = Number(process.argv[3] ?? 40);
const points = Number(process.argv[4] ?? 10000);
let encodings = 0;
const response = { data: Array.from({length: points}, (_, i) => ({timestamp: '2026-01-01T00:00:00Z', value: i * 0.137})),
  toJSON() { encodings++; return { data: this.data }; } };
const times = [];
for(let trial = 0; trial < 5; trial++) {
  cache.clearCache();
  const start = performance.now();
  for(let i = 0; i < count; i++) await cache.withCache(`series-${i}`, async () => response);
  times.push(performance.now() - start);
}
console.log(JSON.stringify({count, points, trial_ms: times, encodings, writes}));
cache.clearCache();
