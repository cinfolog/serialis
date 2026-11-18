import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Gid, Location, Unit } from '@serialis/contract';
import {
  ErrorBanner,
  StateBadge,
  aria,
  countByLocation,
  newFirst,
  normalizeRef,
  type ApiClient,
  type Translate,
} from '@serialis/extensions-shared';

/** Refs shown per page ("Afficher plus" loads the next page with the cursor). */
export const EXISTING_PAGE_SIZE = 20;
/** Pause after the last keystroke in the filter before asking the server. */
export const FILTER_DEBOUNCE_MS = 300;

export type FormatDate = (iso: string) => string;

/** Fallback date format when Shopify's `i18n.formatDate` is not given (tests): the ISO day. */
export const isoDay: FormatDate = (iso) => iso.slice(0, 10);

/**
 * « Refs déjà enregistrées » (decision 3): the refs of the variant at the selected location, by pages of 20
 * (`GET /units?variant=&location=&limit=20&cursor=`), the count elsewhere in one line with a switch to all locations,
 * a prefix filter (`q`) beyond 20 refs. Refs just added are shown first. Counts come from the units already loaded
 * for the form (`loadVariantData`).
 */
export function ExistingRefs(p: {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  locationId: string;
  locations: Location[];
  /** All units of the variant, as loaded for the form (counts). */
  units: Unit[];
  /** The loaded units stop at the page cap: counts are shown as "N+". */
  truncated: boolean;
  /** Units created in this modal, newest first. */
  added: Unit[];
  formatDate: FormatDate;
}) {
  const { t } = p;
  const [allLocations, setAllLocations] = useState(false);
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Unit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const nameOf = (id: string | null) => (id ? (p.locations.find((l) => l.id === id)?.name ?? id) : '—');
  const { here, elsewhere } = countByLocation(p.units, p.locationId);
  const total = here + elsewhere;
  const shown = allLocations ? total : here;
  const fmt = (n: number) => (p.truncated ? `${n}+` : String(n));

  // Debounced filter: one request per pause.
  useEffect(() => {
    const id = setTimeout(() => setQ(normalizeRef(filter)), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [filter]);

  const query = (after?: string) => ({
    variant: p.variantGid,
    limit: EXISTING_PAGE_SIZE,
    ...(allLocations ? {} : { location: p.locationId }),
    ...(q ? { q } : {}),
    ...(after ? { cursor: after } : {}),
  });

  // First page; again after an add (`added` changes) or a scope / filter change.
  useEffect(() => {
    if (total === 0 && p.added.length === 0) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    p.api.listUnits(query(), { signal: ctrl.signal }).then(
      (res) => {
        if (ctrl.signal.aborted) return;
        setItems(res.items);
        setCursor(res.nextCursor);
        setLoading(false);
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.variantGid, p.locationId, allLocations, q, p.added, tick, total === 0]);

  const more = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const res = await p.api.listUnits(query(cursor));
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  const rows = useMemo(() => {
    const pinned = p.added.filter((u) => (allLocations || u.locationId === p.locationId) && (!q || normalizeRef(u.ref).startsWith(q)));
    return newFirst(pinned, items);
  }, [p.added, items, allLocations, p.locationId, q]);
  const addedIds = useMemo(() => new Set(p.added.map((u) => u.id)), [p.added]);

  if (total === 0 && p.added.length === 0) return <s-text color="subdued">{t('variantAction.existingNone')}</s-text>;

  const heading = allLocations
    ? t('variantAction.existingHeadingAll', { count: fmt(shown) })
    : t('variantAction.existingHeading', { location: nameOf(p.locationId), count: fmt(shown) });

  return (
    <s-stack gap="small-200">
      <s-divider />
      <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
        <s-heading>{heading}</s-heading>
        <s-button variant="tertiary" onClick={() => setOpen(!open)} {...aria({ 'aria-expanded': String(open) })}>
          {open ? t('variantAction.existingHide') : t('variantAction.existingShow')}
        </s-button>
      </s-stack>
      {open ? (
        <>
          {elsewhere > 0 ? (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {!allLocations ? <s-text color="subdued">{t('variantAction.existingElsewhere', { count: elsewhere })}</s-text> : null}
              <s-button variant="tertiary" onClick={() => setAllLocations(!allLocations)}>
                {allLocations ? t('variantAction.existingOnlyHere', { location: nameOf(p.locationId) }) : t('variantAction.existingShowAll')}
              </s-button>
            </s-stack>
          ) : null}
          {shown > EXISTING_PAGE_SIZE || filter ? (
            <s-search-field
              label={t('variantAction.existingFilter')}
              labelAccessibilityVisibility="exclusive"
              placeholder={t('variantAction.existingFilter')}
              value={filter}
              onInput={(e: Event) => setFilter((e.currentTarget as HTMLInputElement).value)}
            />
          ) : null}
          {error ? <ErrorBanner t={t} error={error} onRetry={() => setTick((n) => n + 1)} /> : null}
          {rows.length > 0 ? (
            <s-table variant="list">
              <s-table-header-row>
                <s-table-header>{t('variantAction.colRef')}</s-table-header>
                <s-table-header>{t('variantAction.colState')}</s-table-header>
                {allLocations ? <s-table-header>{t('variantAction.colLocation')}</s-table-header> : null}
                <s-table-header>{t('variantAction.colRegistered')}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((u) => (
                  <s-table-row key={u.id}>
                    <s-table-cell>
                      {u.ref}
                      {addedIds.has(u.id) ? ` · ${t('variantAction.existingNew')}` : ''}
                    </s-table-cell>
                    <s-table-cell>
                      <StateBadge t={t} state={u.state} />
                    </s-table-cell>
                    {allLocations ? <s-table-cell>{nameOf(u.locationId)}</s-table-cell> : null}
                    <s-table-cell>{u.createdAt ? p.formatDate(u.createdAt) : ''}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : !loading && !error ? (
            <s-text color="subdued">{q ? t('variantAction.existingNoMatch') : t('variantAction.existingNoneHere')}</s-text>
          ) : null}
          {loading ? <s-spinner accessibilityLabel={t('common.loading')} /> : null}
          {cursor && !loading ? (
            <s-button variant="secondary" onClick={() => void more()}>
              {t('variantAction.existingMore')}
            </s-button>
          ) : null}
        </>
      ) : null}
    </s-stack>
  );
}
