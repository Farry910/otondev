import { describe, expect, it } from 'vitest';
import { cruise } from 'dependency-cruiser';
import boundaryRules from '../lib/boundary-rules.cjs';

const { makeForbiddenRules } = boundaryRules;

/**
 * Exit criterion: "import-boundary rules and the path-ownership check both FAIL THE BUILD
 * when violated". A ruleset that exists but never fires is worse than no ruleset, because
 * every session downstream believes it is protected. So each fixture violates exactly one
 * rule and the real factory-produced ruleset is pointed at it.
 */
async function cruiseFixture(name) {
  const base = `scripts/fixtures/${name}/`;
  const result = await cruise([base], {
    // Two non-obvious requirements of the programmatic API, both of which fail *silently*:
    // the ruleset goes under `ruleSet` (not `forbidden`, which the CLI config file uses),
    // and `validate` must be true or the rules are carried along and never applied. Either
    // mistake produces a green guard test that guards nothing — which is why the `clean`
    // fixture below is not enough on its own and every rule has a positive case.
    ruleSet: { forbidden: makeForbiddenRules(`^${base.replaceAll('/', '\\/')}`) },
    validate: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
    },
  });
  return result.output;
}

function rulesTriggered(output) {
  return output.summary.violations.map((v) => v.rule.name);
}

describe('import-boundary rules', () => {
  it('fails the build when a service imports another service source', async () => {
    const output = await cruiseFixture('cross-service');
    expect(rulesTriggered(output)).toContain('no-cross-service');
    expect(output.summary.error).toBeGreaterThan(0);
  });

  it('fails the build on a deep import past a package entrypoint', async () => {
    const output = await cruiseFixture('deep-import');
    expect(rulesTriggered(output)).toContain('no-deep-package-imports');
    expect(output.summary.error).toBeGreaterThan(0);
  });

  it('fails the build when production code reaches a test double', async () => {
    const output = await cruiseFixture('testkit-leak');
    expect(rulesTriggered(output)).toContain('no-testkit-in-production-code');
    expect(output.summary.error).toBeGreaterThan(0);
  });

  it('stays silent on well-formed code, so a pass means something', async () => {
    const output = await cruiseFixture('clean');
    expect(output.summary.violations).toEqual([]);
    expect(output.summary.error).toBe(0);
  });

  it('never leaves an import unresolved in a fixture', async () => {
    // If resolution silently broke, the violation assertions above could pass or fail for
    // the wrong reason. This pins the thing they depend on.
    for (const fixture of ['cross-service', 'deep-import', 'testkit-leak', 'clean']) {
      const output = await cruiseFixture(fixture);
      expect(rulesTriggered(output), `${fixture} had unresolvable imports`).not.toContain(
        'no-unresolvable',
      );
    }
  });
});

// The real repository is cruised by `pnpm run lint:boundaries`, which runs after the build
// so cross-package imports resolve. Deliberately not asserted here: a test whose result
// depends on whether dist/ happens to exist is a flake, not a guard.
