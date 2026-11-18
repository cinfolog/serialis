import type { SettingValue, SettingsSimulation } from '@serialis/contract';
import { useMemo, useRef, useState } from 'react';
import { isApiError, newIdempotencyKey } from '../../api/client';
import { useAnnounce, useClient, useSession } from '../../context';
import { useLocations } from '../../data';
import { useI18n, type MessageKey } from '../../i18n';
import { Badge, Banner, Button, ConfirmDialog, Section, Select, Stack, TextField } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { Page } from '../../ui/Page';
import { SaveBar } from '../../ui/SaveBar';
import { ErrorState, Loading, useErrorMessage } from '../../ui/states';
import { choiceFor, FIXED_SETTINGS, SETTINGS, THEMES, weakeningOf, type SettingDef, type SettingValueType } from './../../settings/catalogue';
import { ApiKeysSection } from './ApiKeysSection';
import { EmergencyStopSection } from './EmergencyStopSection';
import { HealthLinkSection } from './Health';

const same = (a: SettingValueType | undefined, b: SettingValueType | undefined) => a === b;

interface Review {
  values: Record<string, SettingValueType>;
  simulation: SettingsSimulation | null;
  warnings: string[];
}

/** Reduced settings (19.4): MVP settings S-05, S-08, S-09, S-11, S-17, S-22, S-25, S-35..S-38, S-40, with S-01/S-24 fixed. */
export function Settings() {
  const { t, tMaybe, dateTime } = useI18n();
  const client = useClient();
  const { canAdmin } = useSession();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const locations = useLocations();
  const server = useAsync(() => client.getSettings('shop'), [client]);

  const [draft, setDraft] = useState<Record<string, SettingValueType>>({});
  const [minutesText, setMinutesText] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const simulationKey = useRef<{ signature: string; key: string } | null>(null);

  const serverByKey = useMemo(() => new Map<string, SettingValue>((server.data?.values ?? []).map((v) => [v.key, v])), [server.data]);
  // The draft is never reset by an effect on `server.data`: such an effect runs after the commit
  // that shows the loaded values, so a change made in between was silently overwritten (decision 29).
  // The draft is cleared only where the server values are replaced on purpose (`persist`, `discard`).

  const valueOf = (def: SettingDef): SettingValueType => draft[def.key] ?? serverByKey.get(def.key)?.value ?? def.default;
  const changedKeys = SETTINGS.filter((d) => draft[d.key] !== undefined && !same(draft[d.key], serverByKey.get(d.key)?.value ?? d.default)).map((d) => d.key);
  const dirty = changedKeys.length > 0 || minutesText !== null;

  const labelOf = (def: SettingDef, value: SettingValueType): string => {
    if (def.kind === 'choice') {
      const c = choiceFor(def, value);
      return c ? t(`settings.${def.key}.choice.${c.id}` as MessageKey) : String(value);
    }
    if (def.kind === 'minutes') return `${value} min`;
    return String(value);
  };

  function setValue(def: SettingDef, value: SettingValueType) {
    setError(null);
    setDraft((d) => ({ ...d, [def.key]: value }));
  }

  function onMinutes(def: Extract<SettingDef, { kind: 'minutes' }>, text: string) {
    setMinutesText(text);
    const n = Number(text);
    if (text.trim() !== '' && Number.isInteger(n) && n >= def.min && n <= def.max) {
      setMinutesError(null);
      setDraft((d) => ({ ...d, [def.key]: n }));
    } else {
      setMinutesError(t('settings.minutes_error', { min: def.min, max: def.max }));
    }
  }

  const patternInvalid = (() => {
    const p = draft['S-37.pattern'];
    if (valueOfKey('S-37') !== 'regex' || typeof p !== 'string' || p === '') return false;
    try {
      new RegExp(p);
      return false;
    } catch {
      return true;
    }
  })();
  function valueOfKey(key: string) {
    const def = SETTINGS.find((d) => d.key === key);
    return def ? valueOf(def) : undefined;
  }

  function discard() {
    setDraft({});
    setMinutesText(null);
    setMinutesError(null);
    setError(null);
  }

  async function persist(values: Record<string, SettingValueType>, simulationId?: string) {
    setSaving(true);
    setError(null);
    try {
      const saved = await client.patchSettings({ scope: 'shop', values, ...(simulationId ? { simulationId } : {}) });
      // Same batch: the saved values become the server values and leave the draft. A key changed
      // again while the request was in flight keeps its new draft value.
      server.replace(saved);
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => !(k in values && same(v, values[k])))));
      setReview(null);
      setMinutesText(null);
      announce(t('settings.save.saved'), { toast: true });
    } catch (e) {
      setError(errorMessage(e));
      if (isApiError(e) && e.code === 'simulation_expired') {
        setReview(null);
        simulationKey.current = null;
      }
      setReview((r) => (isApiError(e) && e.code === 'simulation_expired' ? null : r));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (minutesError || patternInvalid) return;
    const values = Object.fromEntries(changedKeys.map((k) => [k, draft[k] as SettingValueType]));
    const needsSimulation = changedKeys.some((k) => serverByKey.get(k)?.changeRule === 'simulation');
    const warnings = changedKeys
      .map((k) => weakeningOf(SETTINGS.find((d) => d.key === k) as SettingDef, values[k]))
      .filter((w): w is string => w !== null)
      .map((w) => tMaybe(w) ?? w);
    if (needsSimulation) {
      setSaving(true);
      setError(null);
      try {
        const signature = JSON.stringify(values);
        if (simulationKey.current?.signature !== signature) simulationKey.current = { signature, key: newIdempotencyKey() };
        const sim = await client.simulateSettings({ scope: 'shop', values }, { idempotencyKey: simulationKey.current.key });
        setReview({ values, simulation: sim, warnings: [...new Set([...warnings, ...sim.warnings])] });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setSaving(false);
      }
    } else if (warnings.length > 0) {
      setReview({ values, simulation: null, warnings });
    } else {
      await persist(values);
    }
  }

  if (!server.data) {
    return <Page heading={t('settings.heading')}>{server.error ? <ErrorState error={server.error} onRetry={server.reload} /> : <Loading />}</Page>;
  }

  const mine = SETTINGS.flatMap((def) => {
    const v = serverByKey.get(def.key);
    return v && v.origin !== 'default' && v.origin !== 'fixed' ? [{ def, value: v }] : [];
  });

  return (
    <Page heading={t('settings.heading')}>
      {!canAdmin ? <Banner tone="info" testId="settings-read-only">{t('settings.read_only')}</Banner> : null}
      {error ? <Banner tone="critical" testId="settings-error">{error}</Banner> : null}

      {THEMES.map((theme) => (
        <Section key={theme} heading={t(`settings.theme.${theme}` as MessageKey)}>
          <Stack>
            {SETTINGS.filter((d) => d.theme === theme)
              .filter((d) => d.kind !== 'pattern' || valueOfKey(d.visibleWhen.key) === d.visibleWhen.equals)
              .map((def) => {
                const current = valueOf(def);
                const warn = weakeningOf(def, current);
                const origin = serverByKey.get(def.key)?.origin ?? 'default';
                const rule = serverByKey.get(def.key)?.changeRule;
                if (def.kind === 'choice') {
                  const selected = choiceFor(def, current);
                  const effectKey = `settings.${def.key}.effect.${selected?.id ?? def.default}`;
                  return (
                    <div key={def.key} data-testid={`setting-${def.key}`}>
                      <Stack gap="small">
                        <Select
                          label={t(`settings.${def.key}.question` as MessageKey)}
                          value={selected?.id ?? ''}
                          options={def.choices.map((c) => {
                            const label = t(`settings.${def.key}.choice.${c.id}` as MessageKey);
                            return { value: c.id, label: c.value === def.default ? t('settings.default_marker', { label }) : label };
                          })}
                          onChange={(id) => {
                            const c = def.choices.find((x) => x.id === id);
                            if (c) setValue(def, c.value);
                          }}
                          disabled={!canAdmin}
                          details={tMaybe(effectKey) ?? ''}
                          testId={`input-${def.key}`}
                        />
                        <s-text>
                          {t('settings.origin', { origin: t(`settings.origin.${origin}`) })}
                          {rule === 'simulation' ? ` · ${t('settings.rule.simulation')}` : ''}
                        </s-text>
                        {warn ? (
                          <Banner tone="warning" heading={t('settings.warning.heading')} testId={`warn-${def.key}`}>
                            {tMaybe(warn)}
                          </Banner>
                        ) : null}
                      </Stack>
                    </div>
                  );
                }
                if (def.kind === 'minutes') {
                  return (
                    <div key={def.key} data-testid={`setting-${def.key}`}>
                      <Stack gap="small">
                        <TextField
                          label={t(`settings.${def.key}.question` as MessageKey)}
                          value={minutesText ?? String(current)}
                          onChange={(text) => onMinutes(def, text)}
                          error={minutesError ?? undefined}
                          details={t(`settings.${def.key}.effect` as MessageKey)}
                          disabled={!canAdmin}
                          inputMode="numeric"
                          testId={`input-${def.key}`}
                        />
                        {warn ? (
                          <Banner tone="warning" heading={t('settings.warning.heading')} testId={`warn-${def.key}`}>
                            {tMaybe(warn)}
                          </Banner>
                        ) : null}
                      </Stack>
                    </div>
                  );
                }
                return (
                  <div key={def.key} data-testid={`setting-${def.key}`}>
                    <TextField
                      label={t('settings.pattern_label')}
                      value={String(current)}
                      onChange={(text) => setValue(def, text)}
                      error={patternInvalid ? t('settings.pattern_error') : undefined}
                      details={t('settings.S-37.pattern.effect')}
                      disabled={!canAdmin}
                      testId={`input-${def.key}`}
                    />
                  </div>
                );
              })}
          </Stack>
        </Section>
      ))}

      <Section heading={t('settings.mine.heading')}>
        <Stack gap="small">
          <s-paragraph>{t('settings.mine.intro')}</s-paragraph>
          {mine.length === 0 ? (
            <s-paragraph data-testid="mine-empty">{t('settings.mine.empty')}</s-paragraph>
          ) : (
            <ul style={{ margin: 0, paddingInlineStart: 20 }} data-testid="mine-list">
              {mine.map(({ def, value }) => (
                <li key={def.key}>
                  {t('settings.mine.line', { name: def.kind === 'choice' || def.kind === 'minutes' ? t(`settings.${def.key}.question` as MessageKey) : def.key, value: labelOf(def, value.value) })}{' '}
                  {canAdmin ? (
                    <Button variant="tertiary" onPress={() => setValue(def, def.default)} testId={`revert-${def.key}`}>
                      {t('settings.mine.revert')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </Section>

      <Section heading={t('settings.fixed.heading')}>
        <Stack>
          <s-paragraph>{t('settings.fixed.intro')}</s-paragraph>
          {FIXED_SETTINGS.map((key) => (
            <div key={key} data-testid={`fixed-${key}`}>
              <Stack gap="small">
                <Stack direction="inline" gap="small" alignItems="center">
                  <s-text type="strong">{t(`settings.fixed.${key}.name` as MessageKey)}</s-text>
                  <Badge>{t('settings.fixed.badge')}</Badge>
                </Stack>
                <s-text>{t(`settings.fixed.${key}.value` as MessageKey)}</s-text>
                <s-text>{t(`settings.fixed.${key}.why` as MessageKey)}</s-text>
              </Stack>
            </div>
          ))}
        </Stack>
      </Section>

      <Section heading={t('settings.locations.heading')}>
        <Stack gap="small">
          {locations.list.map((l) => (
            <Stack key={l.id} direction="inline" gap="small" alignItems="center">
              <s-text>{l.name}</s-text>
              <Badge tone={l.active ? 'success' : 'neutral'}>{l.active ? t('settings.locations.active') : t('settings.locations.inactive')}</Badge>
            </Stack>
          ))}
        </Stack>
      </Section>

      <HealthLinkSection />

      <ApiKeysSection />

      <EmergencyStopSection />

      <SaveBar visible={dirty && canAdmin} saving={saving} disabled={Boolean(minutesError) || patternInvalid} onSave={() => void save()} onDiscard={discard} />

      <ConfirmDialog
        open={review !== null}
        heading={t('settings.simulation.heading')}
        confirmLabel={t('settings.simulation.confirm')}
        cancelLabel={t('common.cancel')}
        busy={saving}
        onConfirm={() => review && void persist(review.values, review.simulation?.simulationId)}
        onClose={() => setReview(null)}
      >
        <Stack gap="small">
          <s-paragraph>{t('settings.simulation.intro')}</s-paragraph>
          {review?.simulation && review.simulation.effects.length > 0 ? (
            <ul style={{ margin: 0, paddingInlineStart: 20 }} data-testid="simulation-effects">
              {review.simulation.effects.map((e) => (
                <li key={e.key}>{e.summary}</li>
              ))}
            </ul>
          ) : null}
          {review && review.warnings.length > 0 ? (
            <Banner tone="warning" heading={t('settings.simulation.warnings')} testId="simulation-warnings">
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {review.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {review?.simulation ? <s-text>{t('settings.simulation.expires', { time: dateTime(review.simulation.expiresAt) })}</s-text> : null}
        </Stack>
      </ConfirmDialog>
    </Page>
  );
}
