import { useRef, useState } from 'react';
import { newIdempotencyKey } from '../../api/client';
import { useAnnounce, useClient, useSession } from '../../context';
import { useI18n } from '../../i18n';
import { Badge, Banner, Button, ConfirmDialog, Section, Stack } from '../../ui/components';
import { useErrorMessage } from '../../ui/states';

/** Emergency stop (EF-33): pause or resume automatic allocation; confirmation names the exact effect. */
export function EmergencyStopSection() {
  const { t } = useI18n();
  const client = useClient();
  const { me, canAdmin, setEmergencyStop } = useSession();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const stopped = me.emergencyStop;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (stopped) await client.resume({ idempotencyKey: key.current });
      else await client.pause({ idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setEmergencyStop(!stopped);
      setOpen(false);
      announce(stopped ? t('resume.done') : t('emergency.activated'), { toast: true });
    } catch (e) {
      setError(errorMessage(e));
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section heading={t('emergency.heading')}>
      <Stack>
        <Stack direction="inline" gap="small" alignItems="center">
          <s-heading>{t('emergency.title')}</s-heading>
          <Badge tone={stopped ? 'critical' : 'success'}>{stopped ? t('emergency.on') : t('emergency.off')}</Badge>
        </Stack>
        {error ? <Banner tone="critical" testId="emergency-error">{error}</Banner> : null}
        {canAdmin ? (
          <div>
            <Button tone={stopped ? undefined : 'critical'} onPress={() => setOpen(true)} testId="emergency-toggle">
              {stopped ? t('emergency.resume') : t('emergency.activate')}
            </Button>
          </div>
        ) : (
          <s-paragraph>{t('common.read_only_admin')}</s-paragraph>
        )}
      </Stack>
      <ConfirmDialog
        open={open}
        heading={stopped ? t('resume.dialog.heading') : t('emergency.activate.heading')}
        confirmLabel={stopped ? t('resume.dialog.confirm') : t('emergency.activate.confirm')}
        cancelLabel={t('common.cancel')}
        {...(stopped ? {} : { tone: 'critical' as const })}
        busy={busy}
        onConfirm={() => void run()}
        onClose={() => setOpen(false)}
      >
        <s-paragraph>{stopped ? t('resume.dialog.body') : t('emergency.activate.body')}</s-paragraph>
      </ConfirmDialog>
    </Section>
  );
}
