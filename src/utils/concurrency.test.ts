import { describe, test, expect } from 'bun:test';
import { all } from './concurrency.js';

async function* fromValues<T>(...values: T[]): AsyncGenerator<T, void> {
  for (const value of values) {
    yield value;
  }
}

async function collect<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) {
    out.push(value);
  }
  return out;
}

describe('all (concurrent async generators)', () => {
  test('yields every value from every generator', async () => {
    const result = await collect(all([fromValues(1, 2), fromValues(3, 4)]));
    expect(new Set(result)).toEqual(new Set([1, 2, 3, 4]));
    expect(result.length).toBe(4);
  });

  test('preserves order within a single generator', async () => {
    const result = await collect(all([fromValues(1, 2, 3)]));
    expect(result).toEqual([1, 2, 3]);
  });

  test('drains all generators even when the concurrency cap is 1', async () => {
    const result = await collect(all([fromValues('a', 'b'), fromValues('c', 'd')], 1));
    expect(new Set(result)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  test('yields nothing for an empty generator list', async () => {
    expect(await collect(all<number>([]))).toEqual([]);
  });

  test('skips undefined values', async () => {
    const result = await collect(all([fromValues(undefined, 1, undefined)]));
    expect(result).toEqual([1]);
  });
});
