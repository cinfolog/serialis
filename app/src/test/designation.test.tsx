import type { Unit } from '@serialis/contract';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DesignationInput, resolveDesignation } from '../ui/DesignationInput';
import { I18nProvider } from '../i18n';
import { flush, pressKey, screen, typeIn, waitFor, press, button } from './utils';

function unit(ref: string): Unit {
  return {
    id: ref, variantGid: 'gid://shopify/ProductVariant/1', locationId: 'loc', state: 'AVAILABLE', ref, orderGid: null, version: 1, receivedAt: null,
    identifiers: [{ id: `${ref}-i`, type: 'serial', value: ref, primary: true }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}
const units = [unit('SN-UR500-M-51203'), unit('SN-UR500-M-51204'), unit('SN-UR500-M-61203')];

describe('Règle de désignation (15.5)', () => {
  it('accepts a full ref (case and spaces ignored)', () => {
    expect(resolveDesignation(' sn-ur500-m-51203 ', units).kind).toBe('exact');
  });
  it('accepts the last 4 characters only when unique among the proposed units', () => {
    expect(resolveDesignation('1204', units)).toMatchObject({ kind: 'suffix' });
    expect(resolveDesignation('1203', units).kind).toBe('ambiguous');
  });
  it('never accepts a partial ref of another length', () => {
    expect(resolveDesignation('51204', units).kind).toBe('none');
    expect(resolveDesignation('204', units).kind).toBe('none');
    expect(resolveDesignation('', units).kind).toBe('none');
  });
});

function setup(onDesignate = vi.fn(async () => undefined)) {
  render(
    <I18nProvider locale="fr">
      <DesignationInput candidates={units} onDesignate={onDesignate} lookup={async () => null} />
    </I18nProvider>,
  );
  return { onDesignate, input: screen.getByTestId('designation-input') };
}

describe('Saisie de désignation', () => {
  it('suggests from 3 characters but Enter never validates a suggestion', async () => {
    const { onDesignate, input } = setup();
    typeIn(input, 'SN-U');
    await waitFor(() => expect(screen.getByTestId('designation-suggestions')).toBeInTheDocument());
    expect(screen.getByTestId('designation-suggestions').children).toHaveLength(3);
    pressKey(input, 'Enter');
    await flush();
    expect(onDesignate).not.toHaveBeenCalled();
    expect(screen.getByTestId('designation-message').textContent).toContain('Aucune unité proposée ne correspond');
  });

  it('suggestions are not interactive (a click cannot designate)', async () => {
    const { onDesignate, input } = setup();
    typeIn(input, 'SN-UR');
    await waitFor(() => expect(screen.getByTestId('designation-suggestions')).toBeInTheDocument());
    press(screen.getByTestId('designation-suggestions').children[0] as HTMLElement);
    await flush();
    expect(onDesignate).not.toHaveBeenCalled();
  });

  it('Enter validates a typed full ref and the 4 last characters when unique', async () => {
    const { onDesignate, input } = setup();
    typeIn(input, 'SN-UR500-M-51203');
    pressKey(input, 'Enter');
    await waitFor(() => expect(onDesignate).toHaveBeenCalledWith('SN-UR500-M-51203'));
    typeIn(input, '1204');
    await waitFor(() => expect(screen.getByTestId('designation-status').textContent).toContain('Unité reconnue : SN-UR500-M-51204'));
    press(button('Valider la ref'));
    await waitFor(() => expect(onDesignate).toHaveBeenCalledWith('1204'));
  });

  it('asks for the full ref when the last 4 characters are ambiguous', async () => {
    const { onDesignate, input } = setup();
    typeIn(input, '1203');
    pressKey(input, 'Enter');
    await flush();
    expect(onDesignate).not.toHaveBeenCalled();
    expect(screen.getByTestId('designation-message').textContent).toContain('Saisissez la ref en entier');
  });
});
