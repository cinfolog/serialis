import type { ReactNode } from 'react';
import { Home } from './screens/home/Home';

export const ROUTE_TABLE: Array<{ path: string; element: ReactNode }> = [
  { path: '/', element: <Home /> },
];
