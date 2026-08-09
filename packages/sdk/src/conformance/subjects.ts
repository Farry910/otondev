import type { ConformanceContext, ConformanceSuite } from '@otondev/contracts';
import { createFakeRegistry } from '../fakes/index.js';
import type { FakeConnectorBroker } from '../fakes/control-plane.js';
import { SERVICE_NAMES } from '../services/index.js';
import { CONFORMANCE_SUITES } from './suites.js';

/**
 * Which fake each suite runs against.
 *
 * Declared once so the vitest gate and the CI report cannot drift into testing different
 * things — the same failure mode this whole package exists to prevent, one level up.
 *
 * `FakeSubject` is structurally identical to the testkit's `SubjectUnderTest` but is declared
 * here instead of imported: `packages/sdk` is production code and may not depend on a test
 * double, even for a type (`no-testkit-in-production-code`). The runner accepts it because
 * TypeScript matches on shape, which is the right amount of coupling between a description
 * of work and the thing that performs it.
 */
export interface FakeSubject<S> {
  name: string;
  capabilities?: readonly string[];
  create(context: ConformanceContext): S;
}

/** Pairs a suite with its subject while keeping their element type linked. */
export type SuiteVisitor<R> = <S>(suite: ConformanceSuite<S>, subject: FakeSubject<S>) => R;
export type ParityTarget = <R>(visit: SuiteVisitor<R>) => R;

function registry(context: ConformanceContext) {
  return createFakeRegistry({ clock: context.clock, ids: context.ids });
}

/** One target per service suite. */
export const SERVICE_PARITY_TARGETS: readonly ParityTarget[] = [
  (visit) =>
    visit(CONFORMANCE_SUITES.ingress, {
      name: 'FakeIngress',
      create: (context) => registry(context).services.ingress,
    }),
  (visit) =>
    visit(CONFORMANCE_SUITES.workflow, {
      name: 'FakeWorkflowEngine',
      create: (context) => registry(context).services.workflow,
    }),
  (visit) =>
    visit(CONFORMANCE_SUITES.policy, {
      name: 'FakePolicy',
      capabilities: ['approvals'],
      create: (context) => registry(context).services.policy,
    }),
  (visit) =>
    visit(CONFORMANCE_SUITES.broker, {
      name: 'FakeCapabilityBroker',
      create: (context) => registry(context).services.broker,
    }),
  (visit) =>
    visit(CONFORMANCE_SUITES.connectors, {
      name: 'FakeConnectorBroker',
      create: (context) => {
        const { services } = registry(context);
        const connectors = services.connectors as FakeConnectorBroker;
        return {
          connectors,
          broker: services.broker,
          makeAmbiguous: (operation: string) => connectors.ambiguousOperations.add(operation),
          setRemoteState: (actionId: string, state: 'present' | 'absent' | 'indeterminate') =>
            connectors.remoteState.set(actionId, state),
        };
      },
    }),
  (visit) =>
    visit(CONFORMANCE_SUITES.evidence, {
      name: 'FakeEvidence',
      create: (context) => registry(context).services.evidence,
    }),
  (visit) =>
    visit(CONFORMANCE_SUITES.verifier, {
      name: 'FakeVerifier',
      create: (context) => registry(context).services.verifier,
    }),
  (visit) =>
    visit(CONFORMANCE_SUITES.memoryStore, {
      name: 'FakeMemoryStore',
      create: (context) => registry(context).services.memoryStore,
    }),
];

/** The W0-E hooks apply to all twenty services, so this is one target per service. */
export const CONTROL_HOOK_PARITY_TARGETS: readonly ParityTarget[] = SERVICE_NAMES.map(
  (name): ParityTarget =>
    (visit) =>
      visit(CONFORMANCE_SUITES.controlHooks, {
        name: `fake:${name}`,
        create: (context) => registry(context).services[name],
      }),
);

export const ALL_PARITY_TARGETS: readonly ParityTarget[] = [
  ...CONTROL_HOOK_PARITY_TARGETS,
  ...SERVICE_PARITY_TARGETS,
];
