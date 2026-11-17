import type { ReactNode } from 'react';
import { Anomalies } from './screens/anomalies/Anomalies';
import { Home } from './screens/home/Home';
import { TrackedItems } from './screens/tracked/TrackedItems';
import { Wizard } from './screens/wizard/Wizard';
import { UnitDetail } from './screens/units/UnitDetail';
import { Units } from './screens/units/Units';

export const ROUTE_TABLE: Array<{ path: string; element: ReactNode }> = [
  { path: '/', element: <Home /> },
  { path: '/start', element: <Wizard /> },
  { path: '/tracked-items', element: <TrackedItems /> },
  { path: '/anomalies', element: <Anomalies /> },
  { path: '/units', element: <Units /> },
  { path: '/units/:id', element: <UnitDetail /> },
];
