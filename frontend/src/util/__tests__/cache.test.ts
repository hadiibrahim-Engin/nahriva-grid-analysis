import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCache, clearCache } from '../../api/cache.ts';

test('concurrent requests deduplicate; clearing prevents stale responses repopulating the cache', async () => {
  clearCache();
  let resolve!: (value: number) => void;
  let calls = 0;
  const fetcher = () => { calls++; return new Promise<number>(done => { resolve = done; }); };
  const first = withCache('data', fetcher);
  const second = withCache('data', fetcher);
  await Promise.resolve();
  assert.equal(calls, 1);
  clearCache();
  assert.equal(await withCache('data', async () => 2), 2);
  resolve(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(await withCache('data', async () => 3), 2);
  clearCache();
});

test('LRU cache evicts the oldest entry and retries rejected requests', async () => {
  clearCache();
  for (let i = 0; i < 64; i++) await withCache(String(i), async () => i);
  assert.equal(await withCache('0', async () => -1), 0);
  await withCache('64', async () => 64);
  assert.equal(await withCache('1', async () => -1), -1);
  await assert.rejects(withCache('failure', async () => { throw Error('offline'); }));
  assert.equal(await withCache('failure', async () => 5), 5);
  clearCache();
});

test('large opt-in entries and ordinary responses avoid repeated storage serialisation', async () => {
  clearCache();
  const writes: string[] = [];
  const storage = { getItem: () => null, removeItem: () => {}, setItem: (_key: string, value: string) => { writes.push(value); } };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  let encodings = 0;
  const value = { toJSON: () => { encodings++; return 'x'.repeat(300_000); } };
  for (let i = 0; i < 5; i++) await withCache(String(i), async () => value);
  assert.equal(encodings, 0);
  await withCache('large', async () => value, { persist: true });
  await withCache('small', async () => ({ x: 1 }), { persist: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(encodings, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(writes[0])), ['small']);
  clearCache();
  Reflect.deleteProperty(globalThis, 'sessionStorage');
});
