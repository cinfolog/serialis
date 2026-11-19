import type { Unit, UnitState } from '@serialis/contract';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useClient } from '../../context';
import { UNIT_STATES, useLocations, variantLabel } from '../../data';
import { useI18n } from '../../i18n';
import { adminUrl, gidNumber } from '../../shopify';
import { StateBadge } from '../../ui/badges';
import { Button, Section, Select, Stack, TextField } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { AdminLink, Link } from '../../ui/Link';
import { Page } from '../../ui/Page';
import { EmptyState, ErrorState, Loading, useErrorMessage } from '../../ui/states';
import { AddRefsPanel } from '../refs/AddRefsPanel';

/** Units list (15.4): filters kept in the URL, cursor pagination, ref search, add refs by pasting. */
export function Units() {
  const { t, dateTime } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  const errorMessage = useErrorMessage();
  const [params, setParams] = useSearchParams();
  const state = (params.get('state') ?? '') as UnitState | '';
  const location = params.get('location') ?? '';
  const variant = params.get('variant') ?? '';
  const q = params.get('q') ?? '';
  const adding = params.get('add') === '1';

  // The search text follows the URL when `q` changes, adjusted during render and not in an effect:
  // an effect runs after the commit that shows the field, so text typed in between was lost (decision 29).
  const [qDraft, setQDraft] = useState(q);
  const [qShown, setQShown] = useState(q);
  if (qShown !== q) {
    setQShown(q);
    setQDraft(q);
  }

  const locations = useLocations();
  const tracked = useAsync(() => client.listTrackedItems({ limit: 250 }), [client]);
  const [extra, setExtra] = useState<{ items: Unit[]; cursor: string | null | undefined; key: string }>({ items: [], cursor: undefined, key: '' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const filterKey = JSON.stringify([state, location, variant, q]);

  const page = useAsync(
    () => client.listUnits({ ...(state ? { state } : {}), ...(location ? { location } : {}), ...(variant ? { variant } : {}), ...(q ? { q } : {}), limit: 50 }),
    [client, filterKey],
    { live: true },
  );

  useEffect(() => setExtra({ items: [], cursor: undefined, key: filterKey }), [filterKey]);

  const items = useMemo(() => {
    // A background refresh of the first page can overlap the pages loaded after it: one row per unit.
    const seen = new Set<string>();
    return [...(page.data?.items ?? []), ...(extra.key === filterKey ? extra.items : [])].filter((u) => !seen.has(u.id) && Boolean(seen.add(u.id)));
  }, [page.data, extra, filterKey]);
  const nextCursor = extra.key === filterKey && extra.cursor !== undefined ? extra.cursor : (page.data?.nextCursor ?? null);

  const setFilter = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const more = await client.listUnits({ ...(state ? { state } : {}), ...(location ? { location } : {}), ...(variant ? { variant } : {}), ...(q ? { q } : {}), cursor: nextCursor, limit: 50 });
      setExtra((e) => ({ key: filterKey, items: [...(e.key === filterKey ? e.items : []), ...more.items], cursor: more.nextCursor }));
    } catch (e) {
      setMoreError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function search() {
    const value = qDraft.trim();
    if (value) {
      // A unique exact match opens the unit sheet directly (15.4).
      try {
        const { unit } = await client.lookup(value);
        if (unit) return void navigate(`/units/${encodeURIComponent(unit.id)}`);
      } catch {
        /* fall back to the filtered list */
      }
    }
    setFilter('q', value);
  }

  const itemLabel = (gid: string) => {
    const found = tracked.data?.items.find((i) => i.variantGid === gid);
    return found ? variantLabel(found) : t('units.unknown_item');
  };
  const filtered = Boolean(state || location || variant || q);

  return (
    <Page
      heading={t('units.heading')}
      actions={
        <Button slot="primary-action" variant="primary" onPress={() => setFilter('add', adding ? '' : '1')} testId="units-add">
          {t('units.add')}
        </Button>
      }
    >
      {adding && tracked.data ? (
        <AddRefsPanel
          items={tracked.data.items}
          locations={locations.list}
          onDone={() => {
            page.reload();
            tracked.reload();
          }}
        />
      ) : null}

      <Section>
        <Stack>
          <Stack direction="inline" gap="base" alignItems="end">
            <TextField label={t('units.filter.q')} value={qDraft} onChange={setQDraft} onEnter={() => void search()} placeholder={t('units.filter.q.placeholder')} testId="units-q" />
            <Button onPress={() => void search()} testId="units-search">
              {t('units.filter.apply')}
            </Button>
          </Stack>
          <Stack direction="inline" gap="base">
            <Select
              label={t('units.filter.state')}
              value={state}
              options={[{ value: '', label: t('common.all') }, ...UNIT_STATES.map((s) => ({ value: s, label: t(`state.${s}`) }))]}
              onChange={(v) => setFilter('state', v)}
              testId="units-state"
            />
            <Select
              label={t('units.filter.location')}
              value={location}
              options={[{ value: '', label: t('common.all') }, ...locations.list.map((l) => ({ value: l.id, label: l.name }))]}
              onChange={(v) => setFilter('location', v)}
              testId="units-location"
            />
            <Select
              label={t('units.filter.variant')}
              value={variant}
              options={[{ value: '', label: t('common.all') }, ...(tracked.data?.items ?? []).map((i) => ({ value: i.variantGid, label: variantLabel(i) }))]}
              onChange={(v) => setFilter('variant', v)}
              testId="units-variant"
            />
            {filtered ? (
              <Button
                variant="tertiary"
                onPress={() => {
                  const next = new URLSearchParams();
                  if (adding) next.set('add', '1');
                  setParams(next, { replace: true });
                }}
              >
                {t('units.filter.reset')}
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </Section>

      <Section>
        {page.error ? (
          <ErrorState error={page.error} onRetry={page.reload} />
        ) : !page.data ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState heading={t('units.empty.heading')}>{filtered ? t('units.empty.filtered') : t('units.empty.none')}</EmptyState>
        ) : (
          <Stack>
            <s-text data-testid="units-count">{t('units.count', { count: items.length })}</s-text>
            <s-table data-testid="units-table">
              <s-table-header-row>
                <s-table-header>{t('units.table.ref')}</s-table-header>
                <s-table-header>{t('units.table.item')}</s-table-header>
                <s-table-header>{t('units.table.state')}</s-table-header>
                <s-table-header>{t('units.table.location')}</s-table-header>
                <s-table-header>{t('units.table.order')}</s-table-header>
                <s-table-header>{t('units.table.updated')}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {items.map((u) => (
                  <s-table-row key={u.id} data-testid={`unit-row-${u.ref}`}>
                    <s-table-cell>
                      <Link to={`/units/${encodeURIComponent(u.id)}`}>{u.ref}</Link>
                    </s-table-cell>
                    <s-table-cell>{itemLabel(u.variantGid)}</s-table-cell>
                    <s-table-cell>
                      <StateBadge state={u.state} />
                    </s-table-cell>
                    <s-table-cell>{locations.name(u.locationId)}</s-table-cell>
                    <s-table-cell>{u.orderGid ? <AdminLink href={adminUrl(`orders/${gidNumber(u.orderGid)}`)}>{t('common.order_link')}</AdminLink> : '—'}</s-table-cell>
                    <s-table-cell>{dateTime(u.updatedAt)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {moreError ? <ErrorState error={new Error(moreError)} /> : null}
            {nextCursor ? (
              <div>
                <Button onPress={() => void loadMore()} loading={loadingMore} testId="units-more">
                  {t('common.load_more')}
                </Button>
              </div>
            ) : null}
          </Stack>
        )}
      </Section>
    </Page>
  );
}
