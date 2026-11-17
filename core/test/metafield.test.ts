import { describe, expect, it } from 'vitest';
import { buildUnitsMetafield, sameMetafieldContent, serializeMetafield } from '../src/metafield.js';
import type { Allocation } from '../src/types.js';
import { ORDER, T0, unit } from './fixtures.js';

const alloc = (id: string, unitId: string, line: string, status: Allocation['status'], at = T0): Allocation => ({
  id,
  unitId,
  variantGid: 'v',
  orderGid: ORDER,
  lineItemGid: line,
  fulfillmentOrderGid: null,
  fulfillmentOrderLineItemGid: null,
  locationId: 'loc-a',
  status,
  source: 'auto',
  returnExpected: false,
  toConfirm: false,
  allocationVersion: 1,
  allocatedAt: at,
  fulfilledAt: null,
  releasedAt: null,
  returnedAt: null,
  releaseKind: null,
  returnLineItemGid: null,
});

describe('metafield serialis.units v1 — spec 13.4', () => {
  const u1 = unit('u_01', 'item-1', 'loc-a', {
    identifiers: [
      { type: 'imei', value: '356938035643809', primary: false },
      { type: 'serial', value: 'SN-UR500-M-51203', primary: true },
    ],
  });
  const u2 = unit('u_02', 'item-1', 'loc-a');
  const u3 = unit('u_03', 'item-1', 'loc-a');
  const units = new Map([u1, u2, u3].map((u) => [u.id, u]));

  it('one element per line, one entry per unit with its status and identifiers (primary first)', () => {
    const value = buildUnitsMetafield(
      ['gid://shopify/LineItem/1', 'gid://shopify/LineItem/2'],
      [
        alloc('a2', 'u_02', 'gid://shopify/LineItem/1', 'fulfilled', T0 + 1),
        alloc('a1', 'u_01', 'gid://shopify/LineItem/1', 'active', T0),
        alloc('a3', 'u_03', 'gid://shopify/LineItem/1', 'released'),
      ],
      units,
    );
    expect(value).toEqual({
      version: 1,
      lines: [
        {
          line_item_id: 'gid://shopify/LineItem/1',
          units: [
            {
              unit_id: 'u_01',
              status: 'allocated',
              identifiers: [
                { type: 'serial', value: 'SN-UR500-M-51203', primary: true },
                { type: 'imei', value: '356938035643809', primary: false },
              ],
            },
            { unit_id: 'u_02', status: 'shipped', identifiers: [{ type: 'serial', value: 'SN-U_02', primary: true }] },
          ],
        },
      ],
    });
  });

  it('returned units are listed, released ones are not; no unit at all gives no metafield', () => {
    const value = buildUnitsMetafield(['L'], [alloc('a1', 'u_01', 'L', 'returned')], units);
    expect(value?.lines[0]?.units[0]?.status).toBe('returned');
    expect(buildUnitsMetafield(['L'], [alloc('a1', 'u_01', 'L', 'released')], units)).toBeNull();
  });

  it('compares contents, not formatting; an unreadable value differs', () => {
    const v = serializeMetafield(buildUnitsMetafield(['L'], [alloc('a1', 'u_01', 'L', 'active')], units));
    const reformatted = JSON.stringify(JSON.parse(v as string), null, 2);
    expect(sameMetafieldContent(v, reformatted)).toBe(true);
    expect(sameMetafieldContent(v, '{"version":1,"lines":[]}')).toBe(false);
    expect(sameMetafieldContent(v, 'not json')).toBe(false);
    expect(sameMetafieldContent(null, null)).toBe(true);
    expect(sameMetafieldContent(null, v)).toBe(false);
  });
});
