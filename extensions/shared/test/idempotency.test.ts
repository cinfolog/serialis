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

describe('newUuid', () => {
  it('falls back to getRandomValues when crypto.randomUUID is missing (non-secure extension sandbox)', async () => {
    const { newUuid } = await import('../src');
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const a = newUuid();
      const b = newUuid();
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(a).not.toBe(b);
      // The default keeper no longer throws in that context.
      expect(new IdempotencyKeeper().keyFor({ track: 'v' })).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
