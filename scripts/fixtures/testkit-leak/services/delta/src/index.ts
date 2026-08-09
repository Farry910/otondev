// VIOLATION (no-testkit-in-production-code): a production entrypoint reaching a test double.
import { fakeClock } from '../../../packages/testkit/src/index.js';

export const delta = () => fakeClock();
