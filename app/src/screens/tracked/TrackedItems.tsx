import type { TrackedItem } from '@serialis/contract';
import { useRef, useState } from 'react';
import { newIdempotencyKey } from '../../api/client';
import { useAnnounce, useClient, useServices, useSession } from '../../context';
import { useLocations, variantLabel } from '../../data';
import { useI18n } from '../../i18n';
import type { PickedVariant } from '../../shopify';
import { Badge, Banner, Button, ConfirmDialog, Section, Stack } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { Link } from '../../ui/Link';
import { Page } from '../../ui/Page';
import { EmptyState, ErrorState, Loading, useErrorMessage } from '../../ui/states';

/** Tracked items (EF-01, reduced): list with the Shopify gap per location, activation of tracking. */
export function TrackedItems() {
  const { t } = useI18n();
  const client = useClient();
  const { pickVariants } = useServices();
  const { canAdmin, reload: reloadSession } = useSession();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const locations = useLocations();
  const list = useAsync(() => client.listTrackedItems({ limit: 250 }), [client], { live: true });
  const [picked, setPicked] = useState<PickedVariant[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  async function choose() {
    setError(null);
    try {
      const selection = await pickVariants();
      const already = new Set(list.data?.items.map((i) => i.variantGid));
      const fresh = selection.filter((v) => !already.has(v.variantGid));
      if (fresh.length > 0) setPicked(fresh);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function activate() {
    if (!picked) return;
    setBusy(true);
    try {
      const response = await client.trackItems({ variantGids: picked.map((p) => p.variantGid), applyToOpenOrders: false }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      announce(t('tracked.done', { count: response.items.length }), { toast: true });
      setPicked(null);
      list.reload();
      void reloadSession();
    } catch (e) {
      setError(errorMessage(e));
      setPicked(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      heading={t('tracked.heading')}
      actions={
        canAdmin ? (
          <Button slot="primary-action" variant="primary" onPress={() => void choose()} testId="tracked-activate">
            {t('tracked.activate')}
          </Button>
        ) : undefined
      }
    >
      {error ? <Banner tone="critical" testId="tracked-error">{error}</Banner> : null}
      <Section>
        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <Loading />
        ) : list.data.items.length === 0 ? (
          <EmptyState heading={t('tracked.empty.heading')}>{t('tracked.empty.body')}</EmptyState>
        ) : (
          <s-table data-testid="tracked-table">
            <s-table-header-row>
              <s-table-header>{t('tracked.table.item')}</s-table-header>
              <s-table-header>{t('tracked.table.mode')}</s-table-header>
              <s-table-header>{t('tracked.table.stock')}</s-table-header>
              <s-table-header>{t('tracked.table.phase')}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {list.data.items.map((i: TrackedItem) => (
                <s-table-row key={i.variantGid}>
                  <s-table-cell>
                    <Link to={`/units?variant=${encodeURIComponent(i.variantGid)}`}>{variantLabel(i)}</Link>
                  </s-table-cell>
                  <s-table-cell>{t(`tracked.mode.${i.mode}`)}</s-table-cell>
                  <s-table-cell>
                    <Stack gap="small">
                      {i.stock.map((s) => (
                        <s-text key={s.locationId}>{t('tracked.stock.line', { location: locations.name(s.locationId), shopify: s.shopifyOnHand, registered: s.registeredUnits })}</s-text>
                      ))}
                    </Stack>
                  </s-table-cell>
                  <s-table-cell>
                    <Badge tone={i.initializing ? 'warning' : 'success'}>{i.initializing ? t('tracked.phase.yes') : t('tracked.phase.no')}</Badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </Section>

      <ConfirmDialog
        open={picked !== null}
        heading={t('tracked.confirm.heading')}
        confirmLabel={t('tracked.confirm.action')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        onConfirm={() => void activate()}
        onClose={() => setPicked(null)}
      >
        <Stack gap="small">
          <s-paragraph>{t('tracked.confirm.body', { count: picked?.length ?? 0 })}</s-paragraph>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {picked?.map((p) => (
              <li key={p.variantGid}>{variantLabel(p)}</li>
            ))}
          </ul>
          <s-paragraph>{t('tracked.confirm.open_orders')}</s-paragraph>
        </Stack>
      </ConfirmDialog>
    </Page>
  );
}
