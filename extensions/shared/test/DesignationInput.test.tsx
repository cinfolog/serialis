import { useState } from 'preact/hooks';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignationInput, type Resolution } from '../src';
import { join } from 'node:path';
import { translatorFromFile, typeInto } from '../src/testing';

const t = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'fr.json'), 'fr');

const units = [
  { id: '1', ref: 'SN-2024-0001' },
  { id: '2', ref: 'SN-2024-0002' },
  { id: '3', ref: 'SN-2025-A001' },
  { id: '4', ref: 'SN-2023-0001' },
];

function Harness(props: { onEnter?: (u: { id: string }) => void; onResolution?: (r: Resolution<{ id: string; ref: string }>) => void }) {
  const [value, setValue] = useState('');
  return (
    <DesignationInput
      t={t}
      label="Ref"
      candidates={units}
      value={value}
      onChange={(v, r) => {
        setValue(v);
        props.onResolution?.(r);
      }}
      onEnter={(u) => props.onEnter?.(u)}
    />
  );
}

const field = () => document.querySelector('s-text-field') as HTMLElement & { value: string };
const type = (text: string) => typeInto(field(), text);
const enter = () => fireEvent.keyDown(field(), { key: 'Enter' });
const status = () => screen.getByTestId('designation-status').textContent;

afterEach(cleanup);

describe('DesignationInput', () => {
  it('shows no suggestion under 3 characters, then suggestions from 3', () => {
    render(<Harness />);
    type('SN');
    expect(document.querySelectorAll('[data-suggestion]')).toHaveLength(0);
    type('SN-');
    expect(document.querySelectorAll('[data-suggestion]')).toHaveLength(4);
  });

  it('a click on a suggestion only fills the field: it never submits', () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    type('SN-2024');
    fireEvent.click(document.querySelector('[data-suggestion="SN-2024-0002"]')!);
    expect(field().value).toBe('SN-2024-0002');
    expect(onEnter).not.toHaveBeenCalled();
    expect(status()).toContain('SN-2024-0002');
  });

  it('Enter never validates a suggestion: partial text with suggestions does nothing', () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    type('SN-2024');
    expect(document.querySelectorAll('[data-suggestion]').length).toBeGreaterThan(0);
    enter();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('Enter submits a full ref typed in full', () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    type('sn-2024-0001');
    enter();
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter.mock.calls[0]![0]).toMatchObject({ id: '1' });
  });

  it('Enter submits the unique last 4 characters, announced in the aria-live status', () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    type('a001');
    expect(screen.getByTestId('designation-status').getAttribute('aria-live')).toBe('polite');
    expect(status()).toContain('4 derniers caractères');
    enter();
    expect(onEnter.mock.calls[0]![0]).toMatchObject({ id: '3' });
  });

  it('reports ambiguous and unknown input without submitting', () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    type('0001');
    expect(status()).toContain('saisissez la ref en entier');
    type('ZZZZ');
    expect(status()).toContain('Aucune unité');
    enter();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('passes the resolution to the parent on every edit', () => {
    const seen: string[] = [];
    render(<Harness onResolution={(r) => seen.push(r.kind)} />);
    type('SN');
    type('sn-2024-0002');
    expect(seen).toEqual(['too_short', 'exact']);
  });
});
