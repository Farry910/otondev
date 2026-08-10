/**
 * The fault-injection suite: process, worker, host, network, provider, token, storage, bad
 * rollout.
 *
 * Eight classes, because they fail differently and the system is supposed to respond
 * differently. They are declared as data so the same class can be pointed at every service as
 * it lands, rather than each session inventing its own idea of "the network is down".
 *
 * The invariant each one asserts is always of the same shape: **after the fault, the system is
 * in a state a human would call safe** — no acknowledged work lost, no work done twice, no
 * authority outliving the thing that granted it. Not "it recovered", which is a weaker claim
 * and much easier to accidentally satisfy by swallowing the error.
 */

import type { FaultInjector } from '@otondev/testkit';

export const FAULT_CLASSES = [
  'process',
  'worker',
  'host',
  'network',
  'provider',
  'token',
  'storage',
  'bad_rollout',
] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];

export interface FaultScenario {
  id: string;
  class: FaultClass;
  /** What is broken, in one line. */
  description: string;
  /** What must hold afterwards. This is the assertion, in prose, for the report. */
  invariant: string;
  /**
   * Arm the injector for this scenario.
   *
   * Takes the injector rather than a service so one scenario can be run against whichever
   * peer is under test — `operation` is `${peer}.${method}`, so the caller supplies the peer.
   */
  arm(injector: FaultInjector, peer: string): void;
}

export const FAULT_SCENARIOS: readonly FaultScenario[] = [
  {
    id: 'process-crash-mid-write',
    class: 'process',
    description: 'the process dies between persisting and acknowledging',
    invariant: 'the redelivery converges on the same canonical id: nothing lost, nothing duplicated',
    arm: (injector, peer) => injector.failNext(`${peer}.commit`, 'INTERNAL', 1),
  },
  {
    id: 'worker-abandons-lease',
    class: 'worker',
    description: 'the worker stops heartbeating and its lease expires',
    invariant: 'the abandoned worker loses its fencing token and cannot publish afterwards',
    arm: (injector, peer) => injector.delayNext(`${peer}.execute`, 600_000, 1),
  },
  {
    id: 'host-clock-jump',
    class: 'host',
    description: 'the host clock jumps forward past every outstanding expiry',
    invariant: 'expired leases and capabilities are refused, not renewed on presentation',
    arm: (injector, peer) => injector.delayNext(`${peer}.mint`, 3_600_000, 1),
  },
  {
    id: 'network-partition',
    class: 'network',
    description: 'the peer is unreachable and never answers',
    invariant: 'the caller reports unreachable within its deadline rather than waiting forever',
    arm: (injector, peer) => injector.hangNext(`${peer}.health`, 1),
  },
  {
    id: 'provider-ambiguous-timeout',
    class: 'provider',
    description: 'the external provider times out after the request may already have taken effect',
    invariant: 'the action enters outcome_unknown and is reconciled, never blindly retried',
    arm: (injector, peer) => injector.timeoutNext(`${peer}.execute`, 1),
  },
  {
    id: 'token-revoked-mid-flight',
    class: 'token',
    description: 'authority is revoked while a step is in flight',
    invariant: 'the next use of the capability is refused; revocation does not wait for expiry',
    arm: (injector, peer) => injector.failNext(`${peer}.execute`, 'CAPABILITY_EXPIRED', 1),
  },
  {
    id: 'storage-unavailable',
    class: 'storage',
    description: 'the durable store rejects writes',
    invariant: 'nothing is acknowledged that was not stored; the caller sees a refusal, not a success',
    arm: (injector, peer) => injector.failAlways(`${peer}.put`, 'INTERNAL'),
  },
  {
    id: 'bad-rollout-version-skew',
    class: 'bad_rollout',
    description: 'a peer is running a version that rejects the current schema major',
    invariant: 'the mismatch fails closed and is attributed to the version, not to the payload',
    arm: (injector, peer) => injector.failAlways(`${peer}.ingest`, 'SCHEMA_MAJOR_UNSUPPORTED'),
  },
];

export function scenariosFor(faultClass: FaultClass): readonly FaultScenario[] {
  return FAULT_SCENARIOS.filter((scenario) => scenario.class === faultClass);
}

/** Every class has at least one scenario. Asserted by a test, because a gap here is invisible. */
export function classesCovered(): FaultClass[] {
  return [...new Set(FAULT_SCENARIOS.map((scenario) => scenario.class))];
}
