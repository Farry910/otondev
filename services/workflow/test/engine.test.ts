import { ContractError } from '@otondev/contracts';
import type { WorkflowRecord } from '@otondev/contracts';
import { createFakeRegistry } from '@otondev/sdk';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryWorkflowStore,
  WorkflowEngine,
  brokerContainment,
  noContainment,
} from '../src/index.js';
import type { CompensationHook, ContainmentPort, WorkflowStore } from '../src/index.js';

/**
 * The S2 exit criteria the shared suite does not reach.
 *
 * The suite covers the five behaviours every peer depends on. These cover the ones only this
 * package can test, because they are about its internal ordering: that a transition event is
 * written for refusals as well as changes, that a pause does not complete when containment
 * fails, and that an interrupted attempt is compensated before it resumes rather than after.
 */

const SEED = {
  type: 'ticket_delivery' as const,
  goal_ref: `art_${'0'.repeat(26)}`,
  source_refs: ['ticket:jira:ENG-42'],
  definition_of_done_ref: 'dod_default_v1',
  risk: 'low' as const,
  data_classes: ['internal_source' as const],
  autonomy_required: 'A2' as const,
  priority: 50,
  budget: { usd_max: 5, deadline: '2030-01-01T00:00:00Z', cpu_seconds: 3600 },
};

function harness(overrides: { containment?: ContainmentPort; compensations?: CompensationHook[] } = {}) {
  const clock = new FakeClock('2026-01-01T00:00:00Z');
  const ids = deterministicIdFactory({ clock });
  const runtime = { clock, ids };
  const store: WorkflowStore = new MemoryWorkflowStore();
  const broker = createFakeRegistry(runtime).services.broker;

  const engine = new WorkflowEngine({
    runtime,
    store,
    containment: overrides.containment ?? brokerContainment(broker, clock),
    ...(overrides.compensations === undefined ? {} : { compensations: overrides.compensations }),
  });

  const seed = (): Promise<WorkflowRecord> =>
    engine.create({ tenant_id: ids.next('tenant'), agent_id: ids.next('agent'), ...SEED });

  return { clock, ids, store, engine, seed, broker };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ContractError) return error.contract.code;
    return `unexpected:${String(error)}`;
  }
  return 'no-error';
}

describe('a transition event is persisted for every state change', () => {
  it('records the accepted transition with the version it moved to', async () => {
    const { engine, store, seed } = harness();
    const workflow = await seed();

    await engine.transition({
      workflow_id: workflow.id,
      expected_state_version: 0,
      to: 'TRIAGED',
      channel: 'normal',
      reason_codes: ['IN_SCOPE'],
    });

    const log = await store.transitions(workflow.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      workflow_id: workflow.id,
      from_state: 'RECEIVED',
      to_state: 'TRIAGED',
      state_version: 1,
      accepted: true,
      channel: 'normal',
    });
  });

  it('records a REFUSED transition too — "why did nothing happen" is a real question', async () => {
    const { engine, store, seed } = harness();
    const workflow = await seed();

    await engine.transition({
      workflow_id: workflow.id,
      expected_state_version: 0,
      to: 'TRIAGED',
      channel: 'normal',
      reason_codes: ['OK'],
    });

    expect(
      await codeOf(() =>
        engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 0,
          to: 'PLANNED',
          channel: 'normal',
          reason_codes: ['STALE'],
        }),
      ),
    ).toBe('STATE_VERSION_CONFLICT');

    const log = await store.transitions(workflow.id);
    const refusals = log.filter((t) => !t.accepted);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason_codes).toContain('state_version conflict');
  });

  it('records a fenced write as a refusal, not only a thrown error', async () => {
    const { engine, store, clock, seed } = harness();
    const workflow = await seed();

    const stale = await engine.acquireLease({
      workflow_id: workflow.id,
      owner: `wl_${'0'.repeat(26)}`,
      ttl_seconds: 60,
    });
    clock.advance(61_000);
    await engine.acquireLease({
      workflow_id: workflow.id,
      owner: `wl_${'1'.repeat(26)}`,
      ttl_seconds: 60,
    });

    expect(
      await codeOf(() =>
        engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 0,
          to: 'TRIAGED',
          channel: 'normal',
          reason_codes: ['ZOMBIE'],
          fencing_token: stale.fencing_token,
        }),
      ),
    ).toBe('LEASE_FENCED');

    const refusals = (await store.transitions(workflow.id)).filter((t) => !t.accepted);
    expect(refusals.map((t) => t.reason_codes.at(-1))).toEqual(['LEASE_FENCED']);
    // The token the zombie presented is on the record, which is what makes the log usable
    // for working out which worker it was.
    expect(refusals[0]?.fencing_token).toBe(stale.fencing_token);
  });
});

describe('pause and cancel complete only after capabilities are denied', () => {
  const refusingContainment: ContainmentPort = {
    async denyCapabilities() {
      return { denied: false, contained: [], detail: 'broker acked unreachable' };
    },
  };

  it('does NOT move the state when the broker will not confirm the deny', async () => {
    const { engine, seed } = harness({ containment: refusingContainment });
    const workflow = await seed();

    expect(
      await codeOf(() =>
        engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 0,
          to: 'PAUSED',
          channel: 'operator',
          reason_codes: ['OPERATOR_STOP'],
        }),
      ),
    ).toBe('INTERNAL');

    // The criterion is about the *state*, not the error. A workflow that reads PAUSED while
    // its worker still holds a capability is the failure this test exists to prevent.
    const after = await engine.get(workflow.id);
    expect(after?.state).toBe('RECEIVED');
    expect(after?.state_version).toBe(0);
  });

  it('completes, and fences the lease, when containment succeeds', async () => {
    const { engine, seed } = harness();
    const workflow = await seed();
    const lease = await engine.acquireLease({
      workflow_id: workflow.id,
      owner: `wl_${'0'.repeat(26)}`,
      ttl_seconds: 60,
    });

    const paused = await engine.transition({
      workflow_id: workflow.id,
      expected_state_version: 0,
      to: 'PAUSED',
      channel: 'operator',
      reason_codes: ['OPERATOR_STOP'],
    });

    expect(paused.state).toBe('PAUSED');
    // Dropping the lease is what fences the worker: it never saw the pause, and its next
    // write must fail because of that.
    expect(paused.lease).toBeNull();
    expect(await codeOf(() => engine.renewLease(workflow.id, lease.fencing_token, 60))).toBe(
      'LEASE_EXPIRED',
    );
  });

  it('runs compensation before a cancel completes', async () => {
    const order: string[] = [];
    const { engine, seed } = harness({
      compensations: [
        {
          name: 'close-draft-pr',
          async compensate() {
            order.push('compensated');
          },
        },
      ],
    });
    const workflow = await seed();

    await engine.transition({
      workflow_id: workflow.id,
      expected_state_version: 0,
      to: 'CANCELLED',
      channel: 'operator',
      reason_codes: ['OPERATOR_CANCEL'],
    });
    order.push('state-moved');

    expect(order).toEqual(['compensated', 'state-moved']);
  });

  it('refuses the cancel when compensation cannot run', async () => {
    const { engine, seed } = harness({
      compensations: [
        {
          name: 'close-draft-pr',
          async compensate() {
            throw new Error('github unreachable');
          },
        },
      ],
    });
    const workflow = await seed();

    expect(
      await codeOf(() =>
        engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 0,
          to: 'CANCELLED',
          channel: 'operator',
          reason_codes: ['OPERATOR_CANCEL'],
        }),
      ),
    ).toBe('COMPENSATION_UNAVAILABLE');

    // Un-compensated external effects plus a CANCELLED record is how duplicates are born.
    expect((await engine.get(workflow.id))?.state).toBe('RECEIVED');
  });
});

describe('a crash mid-transition resumes at a safe state', () => {
  it('recovers an interrupted attempt through RECOVERING into a safe active state', async () => {
    const compensated: string[] = [];
    const { engine, clock, store, seed } = harness({
      compensations: [
        {
          name: 'destroy-workspace',
          async compensate(record, reason) {
            compensated.push(`${record.id}:${reason}`);
          },
        },
      ],
    });

    const workflow = await seed();
    let version = 0;
    for (const to of ['TRIAGED', 'PLANNED', 'LEASED', 'EXECUTING'] as const) {
      const next = await engine.transition({
        workflow_id: workflow.id,
        expected_state_version: version,
        to,
        channel: 'normal',
        reason_codes: ['STEP'],
      });
      version = next.state_version;
    }

    // The worker takes a lease and then dies. Nothing marks it dead; the lease simply stops
    // being renewed, which is exactly what a crash looks like from here.
    await engine.acquireLease({
      workflow_id: workflow.id,
      owner: `wl_${'0'.repeat(26)}`,
      ttl_seconds: 30,
    });
    expect(await engine.recoveryScan()).toEqual([]);
    clock.advance(31_000);
    expect(await engine.recoveryScan()).toContain(workflow.id);

    const resumed = await engine.recover(workflow.id, 'EXECUTING');

    expect(resumed.state).toBe('EXECUTING');
    expect(compensated).toEqual([`${workflow.id}:interrupted attempt`]);

    // The log has to show the interruption. A record that silently reappears in EXECUTING is
    // indistinguishable from one that never left.
    const states = (await store.transitions(workflow.id))
      .filter((t) => t.accepted)
      .map((t) => t.to_state);
    expect(states.slice(-2)).toEqual(['RECOVERING', 'EXECUTING']);
  });

  it('a commit that dies after deciding leaves no half-applied transition', async () => {
    // "Crash mid-transition" has two halves. The half above is recovery; this is the half
    // that makes recovery tractable — there is no state in which the record moved but its
    // transition event did not, so a restarting engine never has to guess which it is seeing.
    const clock = new FakeClock('2026-01-01T00:00:00Z');
    const ids = deterministicIdFactory({ clock });
    const inner = new MemoryWorkflowStore();

    let crash = false;
    const crashing: WorkflowStore = {
      insert: (r) => inner.insert(r),
      get: (id) => inner.get(id),
      mutate: (id, m) => inner.mutate(id, m),
      appendRefusal: (t) => inner.appendRefusal(t),
      transitions: (id) => inner.transitions(id),
      due: (now) => inner.due(now),
      active: () => inner.active(),
      commit: async (id, expected, mutate) => {
        if (crash) throw new Error('process died mid-commit');
        return inner.commit(id, expected, mutate);
      },
    };

    const engine = new WorkflowEngine({
      runtime: { clock, ids },
      store: crashing,
      containment: noContainment,
    });
    const workflow = await engine.create({
      tenant_id: ids.next('tenant'),
      agent_id: ids.next('agent'),
      ...SEED,
    });

    crash = true;
    await expect(
      engine.transition({
        workflow_id: workflow.id,
        expected_state_version: 0,
        to: 'TRIAGED',
        channel: 'normal',
        reason_codes: ['STEP'],
      }),
    ).rejects.toThrow('process died mid-commit');

    const after = await engine.get(workflow.id);
    expect(after?.state).toBe('RECEIVED');
    expect(after?.state_version).toBe(0);
    expect(await crashing.transitions(workflow.id)).toEqual([]);
  });

  it('will not resume a workflow into a state the machine does not allow', async () => {
    const { engine, clock, seed } = harness();
    const workflow = await seed();
    await engine.acquireLease({
      workflow_id: workflow.id,
      owner: `wl_${'0'.repeat(26)}`,
      ttl_seconds: 30,
    });
    clock.advance(31_000);

    // DELIVERING is a safe active state, but RECOVERING -> DELIVERING is only legal on the
    // recovery channel; DONE is not reachable from RECOVERING at all.
    expect(await codeOf(() => engine.recover(workflow.id, 'DONE'))).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('retry and backoff', () => {
  it('schedules an exponentially later wakeup for each attempt', async () => {
    const { engine, seed } = harness();
    const workflow = await seed();

    expect(await engine.scheduleRetry(workflow.id)).toBe(true);
    const first = await engine.get(workflow.id);
    expect(first?.attempt).toBe(2);

    expect(await engine.scheduleRetry(workflow.id)).toBe(true);
    const second = await engine.get(workflow.id);
    expect(second?.attempt).toBe(3);

    expect(Date.parse(second!.next_wakeup_at!)).toBeGreaterThan(Date.parse(first!.next_wakeup_at!));
  });

  it('stops scheduling once the policy is exhausted rather than retrying forever', async () => {
    const { engine, seed } = harness();
    const workflow = await seed();

    const outcomes: boolean[] = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await engine.scheduleRetry(workflow.id));

    expect(outcomes).toEqual([true, true, true, true, false, false]);
  });

  it('a due wakeup shows up in the recovery scan', async () => {
    const { engine, clock, seed } = harness();
    const workflow = await seed();

    await engine.scheduleWakeup(workflow.id, new Date(clock.nowMs() + 10_000).toISOString());
    expect(await engine.recoveryScan()).toEqual([]);
    clock.advance(10_001);
    expect(await engine.recoveryScan()).toContain(workflow.id);
  });
});

describe('terminal states and the emergency hooks', () => {
  it('rejects an operator cancel of an already-terminal workflow', async () => {
    const { engine, seed } = harness();
    const workflow = await seed();
    await engine.transition({
      workflow_id: workflow.id,
      expected_state_version: 0,
      to: 'REJECTED',
      channel: 'normal',
      reason_codes: ['OUT_OF_SCOPE'],
    });

    expect(
      await codeOf(() =>
        engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 1,
          to: 'CANCELLED',
          channel: 'operator',
          reason_codes: ['TOO_LATE'],
        }),
      ),
    ).toBe('WORKFLOW_TERMINAL');
  });

  it('deny refuses new work but still permits containment', async () => {
    const { engine, seed } = harness();
    const workflow = await seed();

    await engine.deny({
      incident_id: 'cor_x',
      scope: { kind: 'global' },
      reason: 'incident',
      requested_by: 'operator',
      requested_at: '2026-01-01T00:00:00Z',
    });

    expect(
      await codeOf(() =>
        engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 0,
          to: 'TRIAGED',
          channel: 'normal',
          reason_codes: ['NEW_WORK'],
        }),
      ),
    ).toBe('EMERGENCY_STOP_ACTIVE');

    // Refusing to pause because we are denying would be exactly backwards.
    const paused = await engine.transition({
      workflow_id: workflow.id,
      expected_state_version: 0,
      to: 'PAUSED',
      channel: 'operator',
      reason_codes: ['INCIDENT'],
    });
    expect(paused.state).toBe('PAUSED');
  });

  it('a global quarantine contains every live workflow, including idle ones', async () => {
    // The one an incident actually uses. A workflow that has never taken a lease and has no
    // wakeup scheduled is still live and still needs containing, and an ack that reports
    // `contained: []` for it reads as "nothing to do" — the most dangerous possible answer
    // during an emergency stop.
    const { engine, seed } = harness();
    const idle = await seed();
    const leased = await seed();
    await engine.acquireLease({
      workflow_id: leased.id,
      owner: `wl_${'0'.repeat(26)}`,
      ttl_seconds: 60,
    });
    const finished = await seed();
    await engine.transition({
      workflow_id: finished.id,
      expected_state_version: 0,
      to: 'REJECTED',
      channel: 'normal',
      reason_codes: ['OUT_OF_SCOPE'],
    });

    const ack = await engine.quarantine({
      incident_id: 'cor_global',
      scope: { kind: 'global' },
      reason: 'suspected compromise',
      requested_by: 'operator',
      requested_at: '2026-01-01T00:00:00Z',
    });

    expect(ack.contained.sort()).toEqual([idle.id, leased.id].sort());
    expect((await engine.get(idle.id))?.state).toBe('PAUSED');
    expect((await engine.get(leased.id))?.state).toBe('PAUSED');
    // Already terminal: nothing to contain, and listing it would overstate the blast radius.
    expect(ack.contained).not.toContain(finished.id);
    expect((await engine.get(finished.id))?.state).toBe('REJECTED');
  });

  it('quarantine pauses the named workflow and reports what it contained', async () => {
    const { engine, seed } = harness();
    const workflow = await seed();

    const ack = await engine.quarantine({
      incident_id: 'cor_y',
      scope: { kind: 'workflow', id: workflow.id },
      reason: 'suspected compromise',
      requested_by: 'operator',
      requested_at: '2026-01-01T00:00:00Z',
    });

    expect(ack.outcome).toBe('contained');
    expect(ack.contained).toEqual([workflow.id]);
    expect((await engine.get(workflow.id))?.state).toBe('PAUSED');
  });
});

describe('leases', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness({ containment: noContainment });
  });

  it('refuses a second owner while the lease is live, and allows one after it expires', async () => {
    const workflow = await h.seed();
    const owner = `wl_${'0'.repeat(26)}`;
    const other = `wl_${'1'.repeat(26)}`;

    await h.engine.acquireLease({ workflow_id: workflow.id, owner, ttl_seconds: 60 });
    expect(
      await codeOf(() =>
        h.engine.acquireLease({ workflow_id: workflow.id, owner: other, ttl_seconds: 60 }),
      ),
    ).toBe('STATE_VERSION_CONFLICT');

    h.clock.advance(61_000);
    const taken = await h.engine.acquireLease({
      workflow_id: workflow.id,
      owner: other,
      ttl_seconds: 60,
    });
    expect(taken.owner).toBe(other);
  });

  it('keeps fencing tokens monotonic across a release', async () => {
    const workflow = await h.seed();
    const owner = `wl_${'0'.repeat(26)}`;

    const first = await h.engine.acquireLease({ workflow_id: workflow.id, owner, ttl_seconds: 60 });
    await h.engine.releaseLease(workflow.id, first.fencing_token);
    const second = await h.engine.acquireLease({ workflow_id: workflow.id, owner, ttl_seconds: 60 });

    // A release must not reset the counter, or a stale write from the first holder would be
    // accepted by the second holder's token.
    expect(second.fencing_token).toBeGreaterThan(first.fencing_token);
  });
});
