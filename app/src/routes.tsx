import type { ReactNode } from 'react';
import { Home } from './screens/home/Home';
import { UnitDetail } from './screens/units/UnitDetail';
import { Units } from './screens/units/Units';

export const ROUTE_TABLE: Array<{ path: string; element: ReactNode }> = [
  { path: '/', element: <Home /> },
  { path: '/units', element: <Units /> },
  { path: '/units/:id', element: <UnitDetail /> },
];
