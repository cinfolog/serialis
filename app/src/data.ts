import type { Location, UnitState } from '@serialis/contract';
import { useMemo } from 'react';
import { useClient } from './context';
import { useAsync } from './ui/hooks';

export interface LocationsState {
  list: Location[];
  name: (id: string | null | undefined) => string;
  loading: boolean;
}

export function useLocations(): LocationsState {
  const client = useClient();
  const { data, loading } = useAsync(() => client.listLocations(), [client]);
  return useMemo(() => {
    const list = data?.items ?? [];
    return { list, loading, name: (id) => (id ? (list.find((l) => l.id === id)?.name ?? id) : '—') };
  }, [data, loading]);
}

export const UNIT_STATES: UnitState[] = [
  'AVAILABLE', 'ALLOCATED', 'HELD', 'QUALITY_CONTROL', 'TO_VERIFY', 'DAMAGED', 'INCOMING', 'IN_TRANSIT',
  'RETURN_PENDING', 'SHIPPED', 'LOST', 'SCRAPPED', 'UNTRACKED',
];

export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

export function variantLabel(item: { title: string; variantTitle: string | null }): string {
  return item.variantTitle ? `${item.title} — ${item.variantTitle}` : item.title;
}
