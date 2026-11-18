/** Structured logs (spec 17.1): shop and task context on every line, order ids never in clear. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEvent, redactOrders, withLogContext } from '../src/log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('structured logs (17.1)', () => {
  it('carries shop and task ids, replaces order ids by a keyed digest', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((l: string) => void lines.push(l));
    withLogContext({ shop: 'demo.myshopify.com', orderKey: 'secret-a' }, () =>
      withLogContext({ task: 'sync_order:gid://shopify/Order/12345', task_kind: 'sync_order' }, () => logEvent('warn', 'x.y', { order: 'gid://shopify/Order/12345', n: 1 })),
    );
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'warn', event: 'x.y', shop: 'demo.myshopify.com', task_kind: 'sync_order', n: 1 });
    expect(lines[0]).not.toContain('12345');
    expect(lines[0]).not.toContain('secret-a');
    expect(line.order).toBe(redactOrders('gid://shopify/Order/12345', 'secret-a'));
    expect(line.task).toBe(`sync_order:${line.order as string}`);
    // Another shop's secret gives another digest: useless without the shop's base.
    expect(redactOrders('gid://shopify/Order/12345', 'secret-b')).not.toBe(line.order);
  });
});
