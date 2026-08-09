#!/usr/bin/env node
/**
 * Runs the import-boundary rules over whichever top-level trees exist.
 *
 * The plain `depcruise <dirs>` form would have to name `services/`, `eval/`, `integration/`
 * and `windows/` before any of them exists, and adding a directory to that list is a root
 * config edit — a W0/S20-owned file no Wave-1 session may touch. Filtering here means a
 * session creates its package directory and the boundary check picks it up with no
 * coordination at all.
 */
import { existsSync } from 'node:fs';
import { cruise } from 'dependency-cruiser';
import config from '../.dependency-cruiser.cjs';

const CANDIDATES = ['packages', 'services', 'windows', 'eval', 'integration'];
const targets = CANDIDATES.filter((dir) => existsSync(dir));

if (targets.length === 0) {
  console.error('boundaries: nothing to cruise — no source trees found.');
  process.exit(1);
}

const { output } = await cruise(targets, {
  ...config.options,
  // `ruleSet` (not `forbidden`) and `validate: true`, both required and both silent when
  // omitted — see the comment in scripts/__tests__/boundaries.test.mjs.
  ruleSet: { forbidden: config.forbidden },
  validate: true,
});
const { violations, error, warn } = output.summary;

for (const v of violations) {
  const where = v.from === v.to ? v.from : `${v.from} -> ${v.to}`;
  console.error(`${v.rule.severity.toUpperCase()}  ${v.rule.name}  ${where}`);
  const rule = config.forbidden.find((r) => r.name === v.rule.name);
  if (rule?.comment) console.error(`       ${rule.comment}`);
}

if (error > 0) {
  console.error(`\nboundaries: ${error} error(s) across ${targets.join(', ')}.`);
  process.exit(1);
}
console.log(
  `boundaries: OK — ${output.summary.totalCruised} modules cruised in ${targets.join(', ')}` +
    (warn > 0 ? ` (${warn} warning(s))` : ''),
);
