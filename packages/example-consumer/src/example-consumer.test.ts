import { describe, expect, it } from 'vitest';
import { createFakeRegistry } from '@otondev/sdk';
import type { FakeConnectorBroker, FakePolicy } from '@otondev/sdk';
import { FakeClock, FaultInjector, deterministicIdFactory, withFaults } from '@otondev/testkit';
import { TicketCommenter } from './index.js';

/**
 * Wave 0's exit criterion, executable.
 *
 * "A trivial consumer can be written against any service interface, run its tests with every
 * peer faked, offline, and green."
 *
 * Offline is enforced, not assumed: `scripts/vitest-offline-guard.mjs` makes outbound HTTP
 * throw for every test in this repository. If anything below reached a network it would fail
 * rather than quietly succeed on a machine that happened to have connectivity.
 */

function build() {
  const clock = new FakeClock('2026-07-30T08:00:00.000Z');
  const ids = deterministicIdFactory({ clock });
  const { services, defaults } = createFakeRegistry({ clock, ids });
  const commenter = new TicketCommenter({
    ingress: services.ingress,
    workflow: services.workflow,
    policy: services.policy,
    broker: services.broker,
    connectors: services.connectors,
    audit: services.audit,
    clock,
    ids,
    tenantId: defaults.tenantId,
    agentId: defaults.agentId,
    workloadId: defaults.workloadId,
  });
  return { clock, ids, services, commenter };
}

const HEADERS = { 'x-signature': 'sig', 'x-event-id': 'vendor_1', 'x-principal': 'jira_cloud_app' };

describe('a trivial consumer, every peer faked, no network', () => {
  it('publishes a comment on the happy path', async () => {
    const { commenter } = build();
    const outcome = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    expect(outcome.status).toBe('published');
    if (outcome.status === 'published') expect(outcome.remote_ref).toContain('fake://jira');
  });

  it('recognises a duplicate delivery instead of commenting twice', async () => {
    const { commenter } = build();
    const first = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    const second = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    expect(first.status).toBe('published');
    expect(second.status).toBe('duplicate_event');
  });

  it('refuses an unsigned delivery', async () => {
    const { commenter } = build();
    const outcome = await commenter.handleWebhook('{}', { 'x-event-id': 'vendor_unsigned' });
    expect(outcome).toMatchObject({ status: 'refused', code: 'SIGNATURE_INVALID' });
  });

  it('does not publish when policy denies', async () => {
    const { commenter, services } = build();
    (services.policy as FakePolicy).denyAll = true;
    const outcome = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    expect(outcome).toMatchObject({ status: 'refused', code: 'POLICY_DENIED' });
  });

  it('does not publish when the action requires an approval that does not exist', async () => {
    const { commenter, services } = build();
    (services.policy as FakePolicy).approvalRequiredFor.add('jira.comment');
    const outcome = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    expect(outcome).toMatchObject({ status: 'refused', code: 'APPROVAL_REQUIRED' });
  });

  it('surfaces an ambiguous outcome as a refusal rather than retrying', async () => {
    // The consumer must not turn ACTION_OUTCOME_UNKNOWN into a retry. Contracts §7 forbids
    // it, and a duplicated comment is the visible consequence.
    const { commenter, services } = build();
    (services.connectors as FakeConnectorBroker).ambiguousOperations.add('issue.add_comment');
    const outcome = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    expect(outcome).toMatchObject({ status: 'refused', code: 'ACTION_OUTCOME_UNKNOWN' });
  });

  it('stops when an emergency deny is in force', async () => {
    const { commenter, services, clock } = build();
    await services.workflow.deny({
      incident_id: 'inc_1',
      scope: { kind: 'global' },
      reason: 'drill',
      requested_by: 'operator',
      requested_at: clock.nowIso(),
    });
    const outcome = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    expect(outcome).toMatchObject({ status: 'refused', code: 'EMERGENCY_STOP_ACTIVE' });
  });

  it('survives a peer failing, and reports a stable code', async () => {
    const clock = new FakeClock('2026-07-30T08:00:00.000Z');
    const ids = deterministicIdFactory({ clock });
    const { services, defaults } = createFakeRegistry({ clock, ids });
    const faults = new FaultInjector({ clock, advance: (ms) => clock.advance(ms) });

    const commenter = new TicketCommenter({
      ingress: services.ingress,
      workflow: services.workflow,
      policy: withFaults('policy', services.policy, faults),
      broker: services.broker,
      connectors: services.connectors,
      audit: services.audit,
      clock,
      ids,
      tenantId: defaults.tenantId,
      agentId: defaults.agentId,
      workloadId: defaults.workloadId,
    });

    faults.failNext('policy.evaluate', 'PROVIDER_UNAVAILABLE');
    const outcome = await commenter.handleWebhook('{"ticket":"ENG-42"}', HEADERS);
    expect(outcome).toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE' });
  });

  it('is deterministic: the same inputs produce the same run', async () => {
    const run = async () => JSON.stringify(await build().commenter.handleWebhook('{"t":1}', HEADERS));
    expect(await run()).toBe(await run());
  });
});

describe('the offline gate is real', () => {
  it('makes an outbound fetch throw', async () => {
    await expect(fetch('https://example.invalid')).rejects.toThrow(/Network access is disabled/);
  });
});
