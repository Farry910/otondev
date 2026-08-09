// LEGAL: a service importing only within itself. Proves the ruleset does not fire on
// well-formed code, so a passing guard test means something.
import { helper } from './helper.js';

export const epsilon = () => helper();
