/**
 * The two runtime seams `conformance.ts` needs, re-exported from their home modules.
 *
 * A separate file only to keep `conformance.ts` from importing the package barrel, which
 * would make `index.ts -> conformance.ts -> index.ts` a cycle and trip `no-circular`.
 */
export type { Clock } from './primitives.js';
export type { IdFactory, IdKind } from './ids.js';
