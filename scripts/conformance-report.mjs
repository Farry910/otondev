#!/usr/bin/env node
/**
 * Prints the fake-parity report for every shipped fake.
 *
 * The vitest gate in `packages/sdk/src/conformance/parity.test.ts` asserts the same thing;
 * this exists so CI produces something a human reads at a glance — a table naming every
 * suite, every case, and whether parity with a real implementation has been *established*
 * or merely not yet attempted. Those two look identical on a green build unless something
 * says otherwise, and in Wave 0 every single one is the second.
 *
 * Needs a build first: it imports the packages through their `exports` field.
 *   pnpm run typecheck && node scripts/conformance-report.mjs
 */
import { ALL_PARITY_TARGETS } from '@otondev/sdk';
import { formatParityReport, runFakeParity } from '@otondev/testkit';

let failures = 0;
let unproven = 0;

for (const target of ALL_PARITY_TARGETS) {
  const report = await target((suite, fake) => runFakeParity({ suite, fake }));
  console.log(formatParityReport(report));
  console.log('');
  if (!report.fake.complete) failures += 1;
  if (report.real === null) unproven += 1;
}

console.log('─'.repeat(72));
console.log(`${ALL_PARITY_TARGETS.length} suite runs, ${failures} failing, ${unproven} with no implementation to compare against.`);

if (failures > 0) {
  console.error('\nA fake does not satisfy the contract it advertises. Every session building');
  console.error('against it is being taught the wrong behaviour. This fails the build.');
  process.exit(1);
}
if (unproven > 0) {
  console.log('\nParity is UNPROVEN for the runs above: no real implementation exists yet.');
  console.log('Expected during Wave 0. Each Wave-1 session adds `real:` to its target in');
  console.log('packages/sdk/src/conformance/subjects.ts, and this report starts comparing.');
}
