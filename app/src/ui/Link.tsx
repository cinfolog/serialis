import { useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useElementEvent } from './hooks';
import { withEmbeddedParams } from '../navigation';

/** In-app link: navigates with React Router (keeping the embedded-app parameters) instead of reloading. */
export function Link({ to, children, accessibilityLabel }: { to: string; children: ReactNode; accessibilityLabel?: string }) {
  const ref = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  useElementEvent<MouseEvent>(ref, 'click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(withEmbeddedParams(to));
  });
  return (
    <s-link ref={ref} href={to} accessibilityLabel={accessibilityLabel}>
      {children}
    </s-link>
  );
}

/** External link into the Shopify admin (`shopify:admin/...`), opened by App Bridge. */
export function AdminLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <s-link href={href} target="_top">
      {children}
    </s-link>
  );
}
