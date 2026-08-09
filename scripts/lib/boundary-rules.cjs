'use strict';

/**
 * Import-boundary rules for the otondev monorepo.
 *
 * These encode properties 2 and 3 of "what makes a package independent"
 * (doc/03-implementation/implementation-plan.md §1):
 *
 *   2. a package's public surface is declared in packages/contracts, not in its own code
 *   3. a package consumes every peer through an interface, never a concrete import
 *
 * The rules are produced by a factory so the guard test can point the *same* ruleset at a
 * fixture tree instead of restating them — a restated rule drifts and then guards nothing.
 * `prefix` is a regex fragment everything is anchored on: '^' for the real repository,
 * '^scripts/fixtures/<case>/' for a fixture.
 */
function makeForbiddenRules(prefix = '^') {
  const p = prefix;
  return [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A dependency cycle makes ownership, build order and review order undecidable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-cross-service',
      severity: 'error',
      comment:
        "A service may never import another service's source. Consume the peer through its " +
        '@otondev/sdk interface, backed by the peer fake. implementation-plan §1 property 3.',
      from: { path: `${p}services/([^/]+)/` },
      to: { path: `${p}services/`, pathNot: `${p}services/$1/` },
    },
    {
      name: 'no-service-to-windows',
      severity: 'error',
      comment:
        'The control plane may not import the Windows presence packages: separate trust boundary, ' +
        'separate process (implementation-plan §2).',
      from: { path: `${p}services/` },
      to: { path: `${p}windows/` },
    },
    {
      name: 'no-windows-to-service',
      severity: 'error',
      comment: 'Same boundary, other direction.',
      from: { path: `${p}windows/` },
      to: { path: `${p}services/` },
    },
    {
      name: 'sdk-is-implementation-free',
      severity: 'error',
      comment:
        'packages/sdk declares interfaces and in-memory fakes only. If it imported an ' +
        'implementation it would stop being the seam that lets a session build against peers it ' +
        'cannot see.',
      from: { path: `${p}packages/sdk/` },
      to: { path: `${p}(services|windows|integration|eval)/` },
    },
    {
      name: 'testkit-is-implementation-free',
      severity: 'error',
      comment: 'packages/testkit must be usable by every package, so it may depend on none of them.',
      from: { path: `${p}packages/testkit/` },
      to: { path: `${p}(services|windows|integration|eval|packages/sdk)/` },
    },
    {
      name: 'contracts-is-a-leaf',
      severity: 'error',
      comment:
        'packages/contracts is the one thing every package reads. It depends on no workspace ' +
        'package, so a contract change is never blocked on an implementation.',
      from: { path: `${p}packages/contracts/` },
      to: { path: `${p}(packages/(?!contracts/)|services|windows|eval|integration)` },
    },
    {
      name: 'no-testkit-in-production-code',
      severity: 'error',
      comment:
        'Test doubles must not be reachable from a production entrypoint. Import @otondev/testkit ' +
        'from *.test.ts and test/** only.',
      from: {
        path: `${p}(packages|services|windows)/[^/]+/src/`,
        // testkit is allowed to be made of testkit. Excluding it here is not a loophole:
        // the rule is about production code *reaching* a test double, and testkit is not
        // production code — nothing depends on it except tests, which the next clause
        // exempts anyway.
        pathNot: `${p}packages/testkit/|\\.(test|spec)\\.ts$|/(test|__tests__|testing)/`,
      },
      to: { path: `${p}packages/testkit/` },
    },
    {
      name: 'no-deep-package-imports',
      severity: 'error',
      comment:
        'Cross-package imports go through the package entrypoint, never a src/ path. A deep import ' +
        'makes the public surface accidental instead of declared.',
      from: { pathNot: `${p}packages/([^/]+)/` },
      to: { path: `${p}packages/([^/]+)/src/(?!index\\.ts$)` },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code must not depend on a devDependency.',
      from: {
        path: `${p}(packages|services|windows)/[^/]+/src/`,
        pathNot: '\\.(test|spec)\\.ts$|/(test|__tests__|testing)/',
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: 'An import that does not resolve is a broken boundary waiting to happen.',
      from: {},
      to: { couldNotResolve: true },
    },
  ];
}

module.exports = { makeForbiddenRules };
