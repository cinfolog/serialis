import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom renders custom elements slowly under parallel load: generous async timeouts avoid flakiness.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});
