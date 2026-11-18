import { useParams } from 'react-router';
import { useClient } from '../../context';
import { useLocations, variantLabel } from '../../data';
import { useI18n } from '../../i18n';
import { adminUrl, gidNumber } from '../../shopify';
import { StateBadge } from '../../ui/badges';
import { Section, Stack } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { AdminLink, Link } from '../../ui/Link';
import { Page } from '../../ui/Page';
import { ErrorState, Loading } from '../../ui/states';

/** Unit sheet (EF-34, reduced): situation, identifiers and timeline of events. No customer data (15.1). */
export function UnitDetail() {
  const { id = '' } = useParams();
  const { t, dateTime } = useI18n();
  const client = useClient();
  const locations = useLocations();
  const unit = useAsync(() => client.getUnit(id), [client, id]);
  const events = useAsync(() => client.unitEvents(id, { limit: 100 }), [client, id]);
  const tracked = useAsync(() => client.listTrackedItems({ limit: 250 }), [client]);

  if (!unit.data) {
    return (
      <Page heading={t('units.heading')}>
        {unit.error ? <ErrorState error={unit.error} onRetry={unit.reload} /> : <Loading />}
      </Page>
    );
  }
  const u = unit.data;
  const item = tracked.data?.items.find((i) => i.variantGid === u.variantGid);

  return (
    <Page heading={t('unit.heading', { ref: u.ref })} back={<Link to="/units">{t('unit.back')}</Link>}>
      <Section heading={t('unit.summary')}>
        <Stack gap="small">
          <Stack direction="inline" gap="small" alignItems="center">
            <s-text type="strong">{t('unit.state')}</s-text>
            <StateBadge state={u.state} />
          </Stack>
          <s-text data-testid="unit-location">
            {t('unit.location')} : {locations.name(u.locationId)}
          </s-text>
          <s-text>
            {t('unit.item')} : {item ? variantLabel(item) : t('units.unknown_item')}
          </s-text>
          <s-text>{u.receivedAt ? `${t('unit.received')} ${dateTime(u.receivedAt)}` : ''}</s-text>
          <s-text>
            {t('unit.order')} :{' '}
            {u.orderGid ? <AdminLink href={adminUrl(`orders/${gidNumber(u.orderGid)}`)}>{t('common.order_link')}</AdminLink> : t('unit.no_order')}
          </s-text>
        </Stack>
      </Section>

      <Section heading={t('unit.identifiers')}>
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          {u.identifiers.map((i) => (
            <li key={i.id}>
              {i.type} : {i.value} {i.primary ? `(${t('unit.identifier.primary')})` : ''}
            </li>
          ))}
        </ul>
      </Section>

      <Section heading={t('unit.history')}>
        {events.error ? (
          <ErrorState error={events.error} onRetry={events.reload} />
        ) : !events.data ? (
          <Loading />
        ) : events.data.items.length === 0 ? (
          <s-paragraph>{t('unit.history.empty')}</s-paragraph>
        ) : (
          <s-table data-testid="unit-events">
            <s-table-header-row>
              <s-table-header>{t('unit.history.date')}</s-table-header>
              <s-table-header>{t('unit.history.actor')}</s-table-header>
              <s-table-header>{t('unit.history.event')}</s-table-header>
              <s-table-header>{t('unit.history.states')}</s-table-header>
              <s-table-header>{t('unit.history.reason')}</s-table-header>
              <s-table-header>{t('unit.history.stock')}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {events.data.items.map((e) => (
                <s-table-row key={e.id}>
                  <s-table-cell>{dateTime(e.at)}</s-table-cell>
                  <s-table-cell>{e.actor}</s-table-cell>
                  <s-table-cell>{e.type}</s-table-cell>
                  <s-table-cell>
                    {e.fromState ? t(`state.${e.fromState}`) : '—'} → {e.toState ? t(`state.${e.toState}`) : '—'}
                  </s-table-cell>
                  <s-table-cell>{e.reason ?? '—'}</s-table-cell>
                  <s-table-cell>{e.stockEffect ?? '—'}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </Section>
    </Page>
  );
}
