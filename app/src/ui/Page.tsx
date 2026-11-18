import { useEffect, type ReactNode } from 'react';
import { useI18n } from '../i18n';

/** Screen wrapper: Polaris page with its title mirrored in the document title. */
export function Page(props: { heading: string; children: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  const { t } = useI18n();
  useEffect(() => {
    document.title = `${props.heading} · ${t('app.name')}`;
  }, [props.heading, t]);
  return (
    <s-page heading={props.heading} inlineSize="base">
      {props.actions}
      {props.back}
      {props.children}
    </s-page>
  );
}
