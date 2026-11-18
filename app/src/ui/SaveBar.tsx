import { useI18n } from '../i18n';
import { Button, Stack } from './components';

/**
 * Contextual save bar (15.1): appears as soon as a form has unsaved changes, with Save and Discard.
 * It is rendered in the page (sticky at the bottom) so that it also works outside the Shopify admin;
 * it uses a labelled region and a polite announcement for screen readers.
 */
export function SaveBar(props: { visible: boolean; saving?: boolean; disabled?: boolean; onSave: () => void; onDiscard: () => void }) {
  const { t } = useI18n();
  if (!props.visible) return null;
  return (
    <div
      role="region"
      aria-label={t('settings.save.region')}
      data-testid="save-bar"
      style={{ position: 'sticky', bottom: 0, zIndex: 10, background: 'var(--p-color-bg-surface, #fff)', borderTop: '1px solid var(--p-color-border, #ccc)', padding: '12px 16px' }}
    >
      <Stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-text type="strong">{t('settings.save.message')}</s-text>
        <Stack direction="inline" gap="small">
          <Button onPress={props.onDiscard} disabled={props.saving} testId="save-bar-discard">
            {t('common.discard')}
          </Button>
          <Button variant="primary" onPress={props.onSave} loading={props.saving} disabled={props.disabled} testId="save-bar-save">
            {t('common.save')}
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}
