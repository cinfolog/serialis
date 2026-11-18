import { describe, expect, it } from 'vitest';
import { IdempotencyKeeper } from '../src';

describe('IdempotencyKeeper', () => {
  it('reuses the key for the same payload until the action succeeds', () => {
    let n = 0;
    const keeper = new IdempotencyKeeper(() => `k${++n}`);
    expect(keeper.keyFor({ refs: ['A'] })).toBe('k1');
    expect(keeper.keyFor({ refs: ['A'] })).toBe('k1');
    keeper.done();
    expect(keeper.keyFor({ refs: ['A'] })).toBe('k2');
  });

  it('starts a new key when the payload changes', () => {
    let n = 0;
    const keeper = new IdempotencyKeeper(() => `k${++n}`);
    expect(keeper.keyFor({ refs: ['A'] })).toBe('k1');
    expect(keeper.keyFor({ refs: ['A', 'B'] })).toBe('k2');
  });
});
