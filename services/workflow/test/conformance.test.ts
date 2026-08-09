import type { ConformanceContext } from '@otondev/contracts';
import { CONFORMANCE_SUITES, createFakeRegistry } from '@otondev/sdk';
import { formatParityReport, runFakeParity } from '@otondev/testkit';
import { describe, expect, it } from 'vitest';
import { MemoryWorkflowStore, WorkflowEngine, brokerContainment } from '../src/index.js';

/**
 * The S2 exit criterion: "fake and implementation both pass the shared conformance suite".
 *
 * Run through the parity driver rather than as two separate suites, because passing
 * independently is the weaker claim. What downstream sessions actually need is that the fake
 * they built against and the engine they will get behave the *same* — the driver's
 * `fake_ahead` verdict is the failure that would otherwise surface at integration, long after
 * sixteen packages have encoded the fake's promise.
 *
 * The suite object is imported from `packages/sdk`, never copied. A copy drifts, and the
 * first thing it stops catching is the drift.
 */

function realEngine(context: ConformanceContext) {
  const runtime = { clock: context.clock, ids: context.ids };
  return new WorkflowEngine({
    runtime,
    store: new MemoryWorkflowStore(),
    // The engine's peer is consumed through the SDK interface, backed by S5's fake —
    // implementation-plan §1 property 3. No import of another service's source.
    containment: brokerContainment(createFakeRegistry(runtime).services.broker, context.clock),
  });
}

describe('WorkflowEngine — shared conformance suite', () => {
  it('the fake and the implementation agree on every case', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.workflow,
      fake: {
        name: 'FakeWorkflowEngine',
        create: (context) =>
          createFakeRegistry({ clock: context.clock, ids: context.ids }).services.workflow,
      },
      real: { name: 'WorkflowEngine', create: realEngine },
    });

    if (!report.ok) throw new Error(`\n${formatParityReport(report)}`);

    expect(report.real).not.toBeNull();
    expect(report.real?.complete).toBe(true);
    expect(report.divergences).toEqual([]);
  });

  it('the suite is not empty — a green parity run must mean something', () => {
    expect(CONFORMANCE_SUITES.workflow.cases.length).toBeGreaterThanOrEqual(6);
  });
});

/**
 * Negative controls.
 *
 * The parity run above went green the first time it was executed, which is exactly when a
 * suite deserves the least trust: a harness that cannot fail reports the same green over a
 * correct engine and a broken one. Each control below breaks one specific guarantee and
 * requires the driver to notice — and to notice *that* case, not merely some case.
 */
describe('negative controls — the parity driver catches a broken engine', () => {
  async function parityAgainst(mutate: (engine: WorkflowEngine) => Record<string, unknown>) {
    return runFakeParity({
      suite: CONFORMANCE_SUITES.workflow,
      fake: {
        name: 'FakeWorkflowEngine',
        create: (context) =>
          createFakeRegistry({ clock: context.clock, ids: context.ids }).services.workflow,
      },
      real: {
        name: 'BrokenEngine',
        create: (context) => {
          const engine = realEngine(context);
          return { ...bind(engine), ...mutate(engine) } as never;
        },
      },
    });
  }

  /** Method references lose `this` when spread off a class instance. */
  function bind(engine: WorkflowEngine) {
    return {
      serviceId: engine.serviceId,
      health: () => engine.health(),
      deny: (r: Parameters<WorkflowEngine['deny']>[0]) => engine.deny(r),
      quarantine: (r: Parameters<WorkflowEngine['quarantine']>[0]) => engine.quarantine(r),
      revoke: (r: Parameters<WorkflowEngine['revoke']>[0]) => engine.revoke(r),
      create: (i: Parameters<WorkflowEngine['create']>[0]) => engine.create(i),
      get: (id: string) => engine.get(id),
      transition: (i: Parameters<WorkflowEngine['transition']>[0]) => engine.transition(i),
      acquireLease: (i: Parameters<WorkflowEngine['acquireLease']>[0]) => engine.acquireLease(i),
      renewLease: (id: string, t: number, ttl: number) => engine.renewLease(id, t, ttl),
      releaseLease: (id: string, t: number) => engine.releaseLease(id, t),
      scheduleWakeup: (id: string, at: string) => engine.scheduleWakeup(id, at),
      recoveryScan: () => engine.recoveryScan(),
    };
  }

  it('catches an engine that ignores the fencing token', async () => {
    const report = await parityAgainst((engine) => ({
      transition: (input: Parameters<WorkflowEngine['transition']>[0]) =>
        engine.transition({ ...input, fencing_token: undefined, channel: 'recovery' }),
    }));

    expect(report.ok).toBe(false);
    expect(report.divergences.map((d) => d.case)).toContain("an expired worker's write is fenced");
  });

  it('catches an engine whose fencing tokens are not monotonic', async () => {
    const report = await parityAgainst((engine) => ({
      acquireLease: async (input: Parameters<WorkflowEngine['acquireLease']>[0]) => {
        const lease = await engine.acquireLease(input);
        return { ...lease, fencing_token: 1 };
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.divergences.map((d) => d.case)).toContain('fencing tokens are monotonic');
  });

  it('catches an engine whose recovery scan never reports anything', async () => {
    const report = await parityAgainst(() => ({
      recoveryScan: async () => [],
    }));

    expect(report.ok).toBe(false);
    expect(report.divergences.map((d) => d.case)).toContain(
      'the recovery scan finds a workflow whose lease expired',
    );
  });
});
