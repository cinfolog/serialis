import { useRef, useState } from 'react';
import { newIdempotencyKey, type ImportReportFull } from '../../api/client';
import { useAnnounce, useClient } from '../../context';
import { useI18n } from '../../i18n';
import { problemMessage } from '../../labels';
import { Badge, Banner, Button, ConfirmDialog, Section, Stack, TextArea } from '../../ui/components';
import { useOnline } from '../../ui/hooks';
import { Page } from '../../ui/Page';
import { useErrorMessage } from '../../ui/states';

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/**
 * Simple CSV import (EF-42, MVP): file or pasted content, mandatory simulation, then confirmation
 * (15.4 "Imports et exports"; the serialLogic export and column mapping are lot 1).
 */
export function Imports() {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useClient();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const online = useOnline();
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState<string | undefined>();
  const [report, setReport] = useState<ImportReportFull | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef<{ csv: string; key: string } | null>(null);
  const confirmKey = useRef<{ id: string; key: string } | null>(null);

  const step: 'file' | 'simulation' | 'confirm' = report?.status === 'confirmed' ? 'confirm' : report ? 'simulation' : 'file';
  const stepIds = ['file', 'simulation', 'confirm'] as const;

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      setCsv(await readFile(file));
      setFilename(file.name);
    } catch {
      setError(t('imports.read_failed'));
    }
  }

  async function simulate() {
    setError(null);
    if (csv.trim() === '') return void setError(t('imports.empty_file'));
    if (keys.current?.csv !== csv) keys.current = { csv, key: newIdempotencyKey() };
    setSimulating(true);
    try {
      setReport(await client.createImport({ csv, ...(filename ? { filename } : {}) }, { idempotencyKey: keys.current.key }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSimulating(false);
    }
  }

  async function confirm() {
    if (!report) return;
    if (confirmKey.current?.id !== report.id) confirmKey.current = { id: report.id, key: newIdempotencyKey() };
    setBusy(true);
    try {
      const confirmed = await client.confirmImport(report.id, { idempotencyKey: confirmKey.current.key });
      setConfirming(false);
      if (confirmed.status === 'failed') {
        setError(t('imports.failed'));
      } else {
        setReport(confirmed);
        announce(t('imports.done', { count: confirmed.valid }), { toast: true });
      }
    } catch (e) {
      setError(errorMessage(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setReport(null);
    setCsv('');
    setFilename(undefined);
    setError(null);
    keys.current = null;
    confirmKey.current = null;
  }

  const stockWrites = report?.stockWrites ?? 0;

  return (
    <Page heading={t('imports.heading')}>
      <Section>
        <ol aria-label={t('imports.steps_label')} style={{ display: 'flex', gap: 16, listStyle: 'none', padding: 0, margin: 0 }} data-testid="import-steps">
          {stepIds.map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined} style={{ fontWeight: s === step ? 600 : 400 }}>
              {i + 1}. {t(`imports.step.${s}`)}
            </li>
          ))}
        </ol>
      </Section>

      {error ? (
        <Banner tone="critical" testId="import-error">
          {error}
        </Banner>
      ) : null}

      {!report ? (
        <Section>
          <Stack>
            <s-paragraph>{t('imports.intro')}</s-paragraph>
            <Stack gap="small">
              <s-text type="strong">{t('imports.format.heading')}</s-text>
              <s-paragraph>{t('imports.format.body')}</s-paragraph>
              <code>{t('imports.format.columns')}</code>
            </Stack>
            <div>
              <label htmlFor="import-file" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                {t('imports.file')}
              </label>
              <input id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} data-testid="import-file" aria-describedby="import-file-hint" />
              <div id="import-file-hint">{t('imports.file.hint')}</div>
            </div>
            <TextArea label={t('imports.paste')} value={csv} onChange={setCsv} rows={8} placeholder={t('imports.paste.placeholder')} testId="import-text" />
            <div>
              <Button variant="primary" onPress={() => void simulate()} loading={simulating} disabled={!online} testId="import-simulate">
                {t('imports.simulate')}
              </Button>
            </div>
          </Stack>
        </Section>
      ) : report.status === 'confirmed' ? (
        <Section>
          <Stack>
            <Banner tone="success" testId="import-done">
              {t('imports.done', { count: report.valid })}
            </Banner>
            <div>
              <Button onPress={reset}>{t('imports.new')}</Button>
            </div>
          </Stack>
        </Section>
      ) : (
        <Section heading={t('imports.report.heading')}>
          <Stack>
            <ul style={{ margin: 0, paddingInlineStart: 20 }} data-testid="import-report">
              <li>{t('imports.report.rows', { count: report.rows })}</li>
              <li>{t('imports.report.valid', { count: report.valid })}</li>
              <li>{t('imports.report.errors', { count: report.errors.length })}</li>
              {report.beyondGap ? <li>{t('imports.report.beyond_gap', { count: report.beyondGap })}</li> : null}
            </ul>
            {report.valid > 0 ? (
              <s-text data-testid="import-effect">{t('imports.report.effect', { writes: stockWrites, counted: report.valid - stockWrites })}</s-text>
            ) : (
              <Banner tone="warning">{t('imports.report.none_valid')}</Banner>
            )}
            {report.errors.length > 0 ? (
              <Stack gap="small">
                <s-text type="strong">{t('imports.report.errors_heading')}</s-text>
                <s-table data-testid="import-errors">
                  <s-table-header-row>
                    <s-table-header>{t('imports.report.errors.row')}</s-table-header>
                    <s-table-header>{t('imports.report.errors.problem')}</s-table-header>
                    <s-table-header>{t('imports.report.errors.status')}</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {report.errors.map((e) => (
                      <s-table-row key={`${e.row}-${e.code}`}>
                        <s-table-cell>{e.row}</s-table-cell>
                        <s-table-cell>{problemMessage(i18n, e.code, e.detail)}</s-table-cell>
                        <s-table-cell>
                          <Badge tone="critical">{t('imports.report.errors.refused')}</Badge>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </Stack>
            ) : null}
            <Stack direction="inline" gap="base">
              <Button onPress={reset}>{t('imports.new')}</Button>
              <Button variant="primary" onPress={() => setConfirming(true)} disabled={report.valid === 0 || !online} testId="import-confirm">
                {t('imports.confirm', { count: report.valid })}
              </Button>
            </Stack>
          </Stack>
        </Section>
      )}

      <ConfirmDialog
        open={confirming}
        heading={t('imports.confirm.heading')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        onConfirm={() => void confirm()}
        onClose={() => setConfirming(false)}
      >
        <s-paragraph>{t('imports.confirm.body', { count: report?.valid ?? 0, writes: stockWrites, errors: report?.errors.length ?? 0 })}</s-paragraph>
      </ConfirmDialog>
    </Page>
  );
}
