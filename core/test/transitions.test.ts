import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNIT_STATES, type UnitState } from '../src/states.js';
import { allowedTransitionsSql, checkTransition } from '../src/transitions.js';

describe('transitions — forbidden cases of spec 7.3', () => {
  it('ALLOCATED can only be reached from AVAILABLE, HELD or (guarded) SHIPPED', () => {
    const sources = UNIT_STATES.filter((s) => checkTransition(s, 'ALLOCATED').ok);
    expect(sources.sort()).toEqual(['AVAILABLE', 'HELD', 'SHIPPED']);
    expect(checkTransition('SHIPPED', 'ALLOCATED')).toEqual({ ok: true, guarded: true });
    expect(checkTransition(null, 'ALLOCATED').ok).toBe(false);
  });

  it('every exit from SCRAPPED is guarded (undo within S-42 only)', () => {
    for (const to of UNIT_STATES) {
      const c = checkTransition('SCRAPPED', to);
      if (c.ok) expect(c.guarded).toBe(true);
    }
    expect(checkTransition('SCRAPPED', 'ALLOCATED').ok).toBe(false);
    expect(checkTransition('SCRAPPED', 'SHIPPED').ok).toBe(false);
  });

  it('creation only in the states listed in 7.2', () => {
    const created = UNIT_STATES.filter((s) => checkTransition(null, s).ok);
    expect(created.sort()).toEqual(
      (['DAMAGED', 'INCOMING', 'AVAILABLE', 'LOST', 'QUALITY_CONTROL', 'SCRAPPED', 'SHIPPED'] as UnitState[]).sort(),
    );
  });

  it('a shipped unit coming back goes through a return or a buy-back, never straight to HELD', () => {
    expect(checkTransition('SHIPPED', 'HELD').ok).toBe(false);
    expect(checkTransition('SHIPPED', 'RETURN_PENDING').ok).toBe(true);
  });

  it('UNTRACKED never comes back to ALLOCATED or HELD directly', () => {
    expect(checkTransition('UNTRACKED', 'ALLOCATED').ok).toBe(false);
    expect(checkTransition('UNTRACKED', 'HELD').ok).toBe(false);
  });
});

describe('transitions — database seed', () => {
  it('db/shop/0002_allowed_transitions.sql matches transitions.ts (run `pnpm gen:transitions`)', () => {
    const path = fileURLToPath(new URL('../../db/shop/0002_allowed_transitions.sql', import.meta.url));
    expect(readFileSync(path, 'utf8')).toBe(allowedTransitionsSql());
  });
});
