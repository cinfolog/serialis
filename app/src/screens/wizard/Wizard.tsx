import type { ExtensionKey } from '@serialis/contract';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { newIdempotencyKey } from '../../api/client';
import { useAnnounce, useClient, useServices, useSession } from '../../context';
import { useLocations, variantLabel } from '../../data';
import { useI18n } from '../../i18n';
import { adminUrl, type PickedVariant } from '../../shopify';
import { Badge, Banner, Button, Checkbox, Section, Stack } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { AdminLink, Link } from '../../ui/Link';
import { Page } from '../../ui/Page';
import { ErrorState, Loading, useErrorMessage } from '../../ui/states';
import { EXTENSIONS, WIZARD_STEPS } from '../home/Home';
import { AddRefsPanel } from '../refs/AddRefsPanel';

type Step = (typeof WIZARD_STEPS)[number];

function StepList({ current }: { current: Step }) {
  const { t } = useI18n();
  const index = WIZARD_STEPS.indexOf(current);
  return (
    <ol aria-label={t('wizard.steps_label')} style={{ display: 'flex', flexWrap: 'wrap', gap: 16, listStyle: 'none', padding: 0, margin: '0 0 16px' }} data-testid="wizard-steps">
      {WIZARD_STEPS.map((s, i) => (
        <li key={s} aria-current={s === current ? 'step' : undefined} style={{ fontWeight: s === current ? 600 : 400 }}>
          {i + 1}. {t(`wizard.step.${s}`)} {i < index ? '✓' : ''}
        </li>
      ))}
    </ol>
  );
}

function ProductsStep({ onNext }: { onNext: () => void }) {
  const { t } = useI18n();
  const client = useClient();
  const { pickVariants } = useServices();
  const { canAdmin, reload } = useSession();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const tracked = useAsync(() => client.listTrackedItems({ limit: 250 }), [client]);
  const [picked, setPicked] = useState<PickedVariant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  async function pick() {
    setError(null);
    try {
      const selection = await pickVariants();
      const known = new Set([...(tracked.data?.items.map((i) => i.variantGid) ?? []), ...picked.map((p) => p.variantGid)]);
      setPicked((prev) => [...prev, ...selection.filter((v) => !known.has(v.variantGid))]);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      const response = await client.trackItems({ variantGids: picked.map((p) => p.variantGid), applyToOpenOrders: false }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setPicked([]);
      announce(t('wizard.products.activated', { count: response.items.length }), { toast: true });
      await reload();
      tracked.reload();
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const existing = tracked.data?.items ?? [];
  return (
    <Section heading={t('wizard.step.products')}>
      <Stack>
        <s-paragraph>{t('wizard.products.intro')}</s-paragraph>
        <s-paragraph>{t('wizard.products.open_orders')}</s-paragraph>
        <s-paragraph>{t('wizard.products.defaults')}</s-paragraph>
        {!canAdmin ? <Banner tone="warning">{t('common.read_only_admin')}</Banner> : null}
        {existing.length > 0 ? (
          <Stack gap="small">
            <s-text type="strong">{t('wizard.products.tracked')}</s-text>
            <ul style={{ margin: 0, paddingInlineStart: 20 }} data-testid="wizard-tracked">
              {existing.map((i) => (
                <li key={i.variantGid}>{variantLabel(i)}</li>
              ))}
            </ul>
          </Stack>
        ) : null}
        <Stack gap="small">
          <s-text type="strong">{t('wizard.products.picked')}</s-text>
          {picked.length === 0 ? (
            <s-paragraph>{t('wizard.products.none_picked')}</s-paragraph>
          ) : (
            <ul style={{ margin: 0, paddingInlineStart: 20 }} data-testid="wizard-picked">
              {picked.map((p) => (
                <li key={p.variantGid}>
                  {variantLabel(p)}{' '}
                  <Button variant="tertiary" onPress={() => setPicked((prev) => prev.filter((x) => x.variantGid !== p.variantGid))} accessibilityLabel={`${t('wizard.products.remove')} ${variantLabel(p)}`}>
                    {t('wizard.products.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Stack>
        {error ? <Banner tone="critical" testId="wizard-error">{error}</Banner> : null}
        <Stack direction="inline" gap="base">
          <Button onPress={() => void pick()} disabled={!canAdmin} testId="wizard-pick">
            {t('wizard.products.pick')}
          </Button>
          <Button variant="primary" onPress={() => void activate()} disabled={picked.length === 0 || !canAdmin} loading={busy} testId="wizard-activate">
            {t('wizard.products.activate')}
          </Button>
          {existing.length > 0 ? <Button onPress={onNext} testId="wizard-next">{t('common.next')}</Button> : null}
        </Stack>
      </Stack>
    </Section>
  );
}

function RefsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { t } = useI18n();
  const client = useClient();
  const { reload } = useSession();
  const locations = useLocations();
  const tracked = useAsync(() => client.listTrackedItems({ limit: 250 }), [client]);
  if (!tracked.data) return tracked.error ? <ErrorState error={tracked.error} onRetry={tracked.reload} /> : <Loading />;
  const items = tracked.data.items;
  const initial = items.find((i) => i.initializing)?.variantGid ?? items[0]?.variantGid;
  return (
    <Stack>
      <s-paragraph>{t('wizard.refs.intro')}</s-paragraph>
      <AddRefsPanel
        items={items}
        locations={locations.list}
        defaultAlreadyCounted
        {...(initial ? { initialVariant: initial } : {})}
        onDone={() => {
          tracked.reload();
          void reload();
        }}
      />
      <Stack direction="inline" gap="base">
        <Button onPress={onBack}>{t('common.back')}</Button>
        <Link to="/imports">
          <Button>{t('wizard.refs.import')}</Button>
        </Link>
        <Button variant="primary" onPress={onNext} testId="wizard-next">
          {t('common.next')}
        </Button>
      </Stack>
    </Stack>
  );
}

function GapStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { t, number } = useI18n();
  const client = useClient();
  const locations = useLocations();
  const tracked = useAsync(() => client.listTrackedItems({ limit: 250 }), [client]);
  const [understood, setUnderstood] = useState(false);
  if (!tracked.data) return tracked.error ? <ErrorState error={tracked.error} onRetry={tracked.reload} /> : <Loading />;
  const rows = tracked.data.items.flatMap((i) => i.stock.map((s) => ({ item: i, stock: s, gap: s.shopifyOnHand - s.registeredUnits })));
  const hasGap = rows.some((r) => r.gap !== 0);
  return (
    <Section heading={t('wizard.step.gap')}>
      <Stack>
        <s-paragraph>{t('wizard.gap.intro')}</s-paragraph>
        <s-table data-testid="wizard-gap-table">
          <s-table-header-row>
            <s-table-header>{t('wizard.gap.table.item')}</s-table-header>
            <s-table-header>{t('wizard.gap.table.location')}</s-table-header>
            <s-table-header format="numeric">{t('wizard.gap.table.shopify')}</s-table-header>
            <s-table-header format="numeric">{t('wizard.gap.table.registered')}</s-table-header>
            <s-table-header>{t('wizard.gap.table.gap')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={`${r.item.variantGid}-${r.stock.locationId}`}>
                <s-table-cell>{variantLabel(r.item)}</s-table-cell>
                <s-table-cell>{locations.name(r.stock.locationId)}</s-table-cell>
                <s-table-cell>{number(r.stock.shopifyOnHand)}</s-table-cell>
                <s-table-cell>{number(r.stock.registeredUnits)}</s-table-cell>
                <s-table-cell>
                  {r.gap === 0 ? (
                    <Badge tone="success">0</Badge>
                  ) : (
                    <Badge tone="warning">{r.gap > 0 ? t('wizard.gap.missing', { count: r.gap }) : t('wizard.gap.extra', { count: -r.gap })}</Badge>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {hasGap ? (
          <Checkbox label={t('wizard.gap.understood')} checked={understood} onChange={setUnderstood} testId="wizard-gap-understood" />
        ) : (
          <Banner tone="success" testId="wizard-gap-ok">{t('wizard.gap.ok')}</Banner>
        )}
        <Stack direction="inline" gap="base">
          <Button onPress={onBack}>{t('wizard.gap.add_more')}</Button>
          <Button onPress={tracked.reload}>{t('wizard.gap.refresh')}</Button>
          <Button variant="primary" onPress={onNext} disabled={hasGap && !understood} testId="wizard-next">
            {t('common.next')}
          </Button>
        </Stack>
      </Stack>
    </Section>
  );
}

function BlocksStep({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { me, reload } = useSession();
  const navigate = useNavigate();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [verifying, setVerifying] = useState(false);
  const shown = me.extensionsShown;
  const allShown = me.onboarding.completed || (shown !== undefined && EXTENSIONS.every((k) => shown[k]));
  const target = (k: ExtensionKey) => (k === 'order_block' || k === 'order_action' ? { href: adminUrl('orders'), label: t('wizard.blocks.open_orders') } : { href: adminUrl('products'), label: t('wizard.blocks.open_products') });

  async function verify() {
    setVerifying(true);
    try {
      await reload();
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Section heading={t('wizard.step.blocks')}>
      <Stack>
        <s-paragraph>{t('wizard.blocks.intro')}</s-paragraph>
        <s-paragraph>{t('wizard.blocks.how')}</s-paragraph>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="wizard-blocks">
          {EXTENSIONS.map((k) => {
            const link = target(k);
            const isShown = shown?.[k] ?? false;
            return (
              <li key={k} style={{ marginBottom: 12 }} data-testid={`ext-${k}`}>
                <Stack gap="small">
                  <Stack direction="inline" gap="base" alignItems="center">
                    <s-text type="strong">{t(`wizard.ext.${k}`)}</s-text>
                    <Badge tone={isShown ? 'success' : 'warning'}>{isShown ? t('wizard.shown') : t('wizard.not_shown')}</Badge>
                    <AdminLink href={link.href}>{link.label}</AdminLink>
                  </Stack>
                  <Checkbox label={`${t('wizard.blocks.checked')} : ${t(`wizard.ext.${k}`)}`} checked={checked[k] ?? isShown} onChange={(v) => setChecked((c) => ({ ...c, [k]: v }))} />
                </Stack>
              </li>
            );
          })}
        </ul>
        <Checkbox label={t('wizard.blocks.team')} checked={checked['team'] ?? false} onChange={(v) => setChecked((c) => ({ ...c, team: v }))} testId="wizard-team" />
        {allShown ? <Banner tone="success" testId="wizard-blocks-ok">{t('wizard.blocks.all_shown')}</Banner> : <Banner tone="info" testId="wizard-blocks-pending">{t('wizard.blocks.pending')}</Banner>}
        <Stack direction="inline" gap="base">
          <Button onPress={onBack}>{t('common.back')}</Button>
          <Button onPress={() => void verify()} loading={verifying} testId="wizard-verify">
            {t('wizard.blocks.verify')}
          </Button>
          <Button variant="primary" onPress={() => navigate('/')} testId="wizard-finish">
            {t('wizard.finish')}
          </Button>
        </Stack>
      </Stack>
    </Section>
  );
}

/** Startup wizard (15.4 "Assistants", 19.4): products, existing refs, gap with Shopify, admin blocks. */
export function Wizard() {
  const { t } = useI18n();
  const { me } = useSession();
  const [step, setStep] = useState<Step>(me.onboarding.step === 'done' ? 'products' : me.onboarding.step);
  const go = (delta: number) => setStep((s) => WIZARD_STEPS[Math.min(Math.max(WIZARD_STEPS.indexOf(s) + delta, 0), 3)] ?? s);

  return (
    <Page heading={t('wizard.heading')}>
      <Section>
        <StepList current={step} />
      </Section>
      {step === 'products' ? <ProductsStep onNext={() => go(1)} /> : null}
      {step === 'refs' ? (
        <Section heading={t('wizard.step.refs')}>
          <RefsStep onNext={() => go(1)} onBack={() => go(-1)} />
        </Section>
      ) : null}
      {step === 'gap' ? <GapStep onNext={() => go(1)} onBack={() => go(-1)} /> : null}
      {step === 'blocks' || step === 'done' ? <BlocksStep onBack={() => go(-1)} /> : null}
    </Page>
  );
}
