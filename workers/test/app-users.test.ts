/**
 * Access rights (spec 15.8): app users known by the `sub` of the session token, the first user is the
 * owner and administrator, administrators designate others; administration routes answer 403
 * problem+json to an operator.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addRefs, anomalies, createHarness, json, track, type Harness } from './e2e-harness.js';
import { sessionToken } from './helpers.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

async function setup(name: string) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const { variantIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: 0 } }]);
  return { h, loc, variant: variantIds[0]! };
}

async function as(h: Harness, sub: string) {
  return { Authorization: `Bearer ${await sessionToken(h.shop, { sub })}` };
}

describe('app users and roles (15.8)', () => {
  it('the first user is owner and admin, the next ones operators; /me returns the real role', async () => {
    const { h } = await setup('users-roles');
    expect(await json(await h.api('GET', '/me', undefined, await as(h, '7')), 200)).toMatchObject({ role: 'admin' });
    expect(await json(await h.api('GET', '/me', undefined, await as(h, '200')), 200)).toMatchObject({ role: 'operator' });
    const list = await json(await h.api('GET', '/app-users', undefined, await as(h, '7')), 200);
    expect(list.items.map((u: { userId: string; role: string; owner: boolean }) => [u.userId, u.role, u.owner])).toEqual([
      ['7', 'admin', true],
      ['200', 'operator', false],
    ]);
    // No e-mail, no personal data beyond the optional first name.
    expect(Object.keys(list.items[0]).sort()).toEqual(['designatedBy', 'firstName', 'firstSeenAt', 'lastSeenAt', 'owner', 'role', 'userId']);
  });

  it('administration routes answer 403 problem+json to an operator, and work once designated', async () => {
    const { h, variant } = await setup('users-admin');
    await h.api('GET', '/me', undefined, await as(h, '7'));
    const op = await as(h, '200');
    await h.api('GET', '/me', undefined, op);

    const refusals = [
      await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-08': 'last' } }, op),
      await h.api('POST', '/settings/simulate', { scope: 'shop', values: { 'S-38': false } }, op),
      await h.api('POST', '/automation/pause', {}, op),
      await h.api('POST', '/automation/resume', {}, op),
      await h.api('POST', '/imports/x/confirm', {}, op),
      await h.api('POST', '/tracked-items', { variantGids: [variant] }, op),
      await h.api('GET', '/app-users', undefined, op),
      await h.api('PATCH', '/app-users', { userId: '200', role: 'admin' }, op),
      await h.api('GET', '/health', undefined, op),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expect(res.headers.get('Content-Type')).toContain('application/problem+json');
      expect(await res.json()).toMatchObject({ code: 'forbidden', detail: 'admin_required' });
    }
    // Operations stay open to operators.
    expect((await h.api('GET', '/units', undefined, op)).status).toBe(200);
    expect((await h.api('GET', '/stats/home', undefined, op)).status).toBe(200);

    const designated = await json(await h.api('PATCH', '/app-users', { userId: '200', role: 'admin', firstName: '  Camille ' }, await as(h, '7')), 200);
    expect(designated).toMatchObject({ userId: '200', role: 'admin', owner: false, designatedBy: '7', firstName: 'Camille' });
    expect((await h.api('POST', '/automation/pause', {}, op)).status).toBe(200);
    await track(h, [variant]);
    const audit = await h.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'app_user.%' ORDER BY id");
    expect(audit.map((a) => a.action)).toEqual(['app_user.owner', 'app_user.update']);
  });

  it('refuses to withdraw the owner, the last admin, or to designate a user who never opened the app', async () => {
    const { h } = await setup('users-guards');
    const owner = await as(h, '7');
    await h.api('GET', '/me', undefined, owner);
    expect(await json(await h.api('PATCH', '/app-users', { userId: '7', role: 'operator' }, owner), 422)).toMatchObject({ detail: 'owner_is_admin' });
    expect(await json(await h.api('PATCH', '/app-users', { userId: '999', role: 'admin' }, owner), 404)).toMatchObject({ code: 'not_found' });
    await h.api('GET', '/me', undefined, await as(h, '200'));
    await json(await h.api('PATCH', '/app-users', { userId: '200', role: 'admin' }, owner), 200);
    expect(await json(await h.api('PATCH', '/app-users', { userId: '200', role: 'operator' }, owner), 200)).toMatchObject({ role: 'operator', designatedBy: null });
    expect(await json(await h.api('PATCH', '/app-users', { userId: '200', role: 'superuser' }, owner), 422)).toMatchObject({ code: 'validation_failed' });
  });

  it('a stock-writing anomaly resolution is refused to an operator; one without stock write is allowed', async () => {
    const { h, loc, variant } = await setup('users-resolve');
    await h.api('GET', '/me', undefined, await as(h, '7'));
    const op = await as(h, '200');
    await h.api('GET', '/me', undefined, op);
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['V-1']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    // Cancelled without restock: the unit is to verify (F5).
    order.cancel({ restock: false });
    await h.drain();
    const id = (await anomalies(h, 'unit_to_verify'))[0]!.id;
    expect(await json(await h.api('POST', `/anomalies/${id}/resolve`, { action: 'restock' }, op), 403)).toMatchObject({ code: 'forbidden' });
    expect(await json(await h.api('POST', `/anomalies/${id}/resolve`, { action: 'lose' }, op), 200)).toMatchObject({ status: 'resolved' });
  });
});
