// VIOLATION (no-deep-package-imports): imports a package's internal module rather than
// its declared entrypoint.
import { internal } from '../../../packages/contracts/src/internal.js';

export const gamma = () => internal();
