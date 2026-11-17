// Writes db/shop/0002_allowed_transitions.sql from core/src/transitions.ts.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allowedTransitionsSql } from '../core/src/transitions.ts';

const out = fileURLToPath(new URL('../db/shop/0002_allowed_transitions.sql', import.meta.url));
writeFileSync(out, allowedTransitionsSql());
console.log(`wrote ${out}`);
