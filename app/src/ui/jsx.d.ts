import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type PolarisElementProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { [attribute: string]: unknown };

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      /** Shopify Polaris web components (`<s-page>`, `<s-button>`, ...), loaded from the CDN script. */
      [tag: `s-${string}`]: PolarisElementProps;
    }
  }
}
