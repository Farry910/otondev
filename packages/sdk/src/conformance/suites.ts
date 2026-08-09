import {
  defineConformanceSuite,
  expectEqual,
  expectRejection,
  expectTrue,
  ID_PREFIX,
} from '@otondev/contracts';
import type { ConformanceSuite, MemoryRecord } from '@otondev/contracts';
import type { ServiceClient } from '../hooks.js';
import type {
  CapabilityBrokerClient,
  ConnectorBrokerClient,
  IngressClient,
  PolicyClient,
  WorkflowEngineClient,
} from '../services/control-plane.js';
import type { EvidenceClient, VerifierClient } from '../services/execution-plane.js';
import type { MemoryStore } from '../services/data-plane.js';
import { digestOf } from '../fakes/support.js';

/**
 * Shared conformance suites.
 *
 * These are the contract a fake and its real implementation must *both* satisfy — property 4
 * of an independently buildable package. A Wave-1 session imports the suite for the service
 * it owns, points it at its implementation, and the fake-parity driver compares the two runs.
 *
 * They are not exhaustive and are not meant to be. Each case here is an invariant a *peer*
 * depends on: the thing a downstream session would build wrongly if the fake behaved
 * differently from the implementation. A package's own thorough tests live with the package.
 */

const A_SHA = `sha256:${'ab'.repeat(32)}`;
const B_SHA = `sha256:${'cd'.repeat(32)}`;

function repoRef(): string {
  return 'repo:team/api';
}

// ------------------------------------------------------------ every service, W0-E hooks

export const controlHooksSuite: ConformanceSuite<ServiceClient> = defineConformanceSuite(
  'ControlHooks (W0-E)',
  [
    {
      name: 'reports health with its own service id',
      run: async (service) => {
        const health = await service.health();
        expectEqual(health.service, service.serviceId, 'health must identify the service');
        expectTrue(health.denying === false, 'a fresh service is not denying');
      },
    },
    {
      name: 'deny is acknowledged and visible in health',
      run: async (service, context) => {
        const ack = await service.deny({
          incident_id: 'inc_1',
          scope: { kind: 'global' },
          reason: 'conformance',
          requested_by: 'operator',
          requested_at: context.clock.nowIso(),
        });
        expectEqual(ack.service, service.serviceId, 'the ack names the service');
        expectTrue(ack.outcome !== 'unreachable', 'a live service is not unreachable');
        const health = await service.health();
        // "Containment is verified, not merely requested" (S18). A service that accepted a
        // deny and still reports itself unconstrained has not been contained.
        expectTrue(health.denying, 'health must reflect an active denial');
      },
    },
    {
      name: 'revoke reports what it invalidated',
      run: async (service, context) => {
        const ack = await service.revoke({
          incident_id: 'inc_2',
          scope: { kind: 'global' },
          reason: 'conformance',
          requested_by: 'operator',
          requested_at: context.clock.nowIso(),
          revocation_epoch: 1,
        });
        expectTrue(Array.isArray(ack.contained), 'an ack always carries a contained list');
        expectTrue(
          ack.outcome !== 'contained' || ack.outstanding.length === 0,
          'a contained ack may not also report outstanding subjects',
        );
      },
    },
    {
      name: 'quarantine is acknowledged even when there is nothing to quarantine',
      run: async (service, context) => {
        const ack = await service.quarantine({
          incident_id: 'inc_3',
          scope: { kind: 'workflow', id: `${ID_PREFIX.workflow}${'0'.repeat(26)}` },
          reason: 'conformance',
          requested_by: 'operator',
          requested_at: context.clock.nowIso(),
        });
        // `not_applicable` and `contained` are both fine. Silence is not: the aggregator
        // cannot tell silence from a wedged process.
        expectTrue(
          ['contained', 'not_applicable', 'partial'].includes(ack.outcome),
          `unexpected quarantine outcome "${ack.outcome}"`,
        );
      },
    },
  ],
);

// --------------------------------------------------------------------------- S1 Ingress

export const ingressSuite: ConformanceSuite<IngressClient> = defineConformanceSuite('Ingress (S1)', [
  {
    name: 'a duplicate delivery returns the EXISTING canonical event id',
    run: async (ingress, context) => {
      const delivery = {
        system: 'jira' as const,
        installation_id: 'jira_acme',
        body: new TextEncoder().encode('{"ticket":"ENG-42"}'),
        headers: { 'x-signature': 'sig', 'x-event-id': 'vendor_1', 'x-principal': 'jira_cloud_app' },
        received_at: context.clock.nowIso(),
      };
      const first = await ingress.ingest(delivery);
      expectEqual(first.status, 'accepted', 'the first delivery is accepted');
      const second = await ingress.ingest(delivery);
      expectEqual(second.status, 'duplicate', 'the second delivery is a duplicate');
      expectTrue(
        first.status === 'accepted' && second.status === 'duplicate' && first.event_id === second.event_id,
        'contracts §2: a duplicate returns the id of the event already accepted',
      );
    },
  },
  {
    name: 'an unsigned delivery fails closed',
    run: async (ingress, context) => {
      const outcome = await ingress.ingest({
        system: 'jira',
        installation_id: 'jira_acme',
        body: new TextEncoder().encode('{}'),
        headers: { 'x-event-id': 'vendor_unsigned' },
        received_at: context.clock.nowIso(),
      });
      expectEqual(outcome.status, 'rejected', 'no signature, no acceptance');
    },
  },
  {
    name: 'an accepted event is durable and findable by its dedupe key',
    run: async (ingress, context) => {
      const outcome = await ingress.ingest({
        system: 'github',
        installation_id: 'gh_acme',
        body: new TextEncoder().encode('{}'),
        headers: { 'x-signature': 'sig', 'x-event-id': 'vendor_2' },
        received_at: context.clock.nowIso(),
      });
      expectTrue(outcome.status === 'accepted', 'accepted');
      // Acknowledgement happens only after the record is durable (contracts §2), so it must
      // be readable the instant the promise resolves.
      const event = await ingress.getEvent(outcome.event_id);
      expectTrue(event !== null, 'the event is readable immediately after acknowledgement');
      expectEqual(
        await ingress.lookupByDedupeKey(event.dedupe_key),
        outcome.event_id,
        'the dedupe ledger points at the canonical id',
      );
    },
  },
]);

// -------------------------------------------------------------------------- S2 Workflow

async function seedWorkflow(engine: WorkflowEngineClient, tenantId: string, agentId: string) {
  return engine.create({
    tenant_id: tenantId,
    agent_id: agentId,
    type: 'ticket_delivery',
    goal_ref: `${ID_PREFIX.artifact}${'0'.repeat(26)}`,
    source_refs: ['ticket:jira:ENG-42'],
    definition_of_done_ref: 'dod_default_v1',
    risk: 'low',
    data_classes: ['internal_source'],
    autonomy_required: 'A2',
    priority: 50,
    budget: { usd_max: 5, deadline: '2030-01-01T00:00:00Z', cpu_seconds: 3600 },
  });
}

export const workflowEngineSuite: ConformanceSuite<WorkflowEngineClient> = defineConformanceSuite(
  'WorkflowEngine (S2)',
  [
    {
      name: 'compare-and-set: exactly one of two claimants wins',
      run: async (engine, context) => {
        const workflow = await seedWorkflow(
          engine,
          context.ids.next('tenant'),
          context.ids.next('agent'),
        );
        const attempt = () =>
          engine.transition({
            workflow_id: workflow.id,
            expected_state_version: workflow.state_version,
            to: 'TRIAGED',
            channel: 'normal',
            reason_codes: ['RACE'],
          });
        const results = await Promise.allSettled([attempt(), attempt()]);
        const won = results.filter((r) => r.status === 'fulfilled').length;
        expectEqual(won, 1, 'exactly one claimant may win a compare-and-set');
      },
    },
    {
      name: 'a stale state_version is refused',
      run: async (engine, context) => {
        const workflow = await seedWorkflow(engine, context.ids.next('tenant'), context.ids.next('agent'));
        await engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 0,
          to: 'TRIAGED',
          channel: 'normal',
          reason_codes: ['OK'],
        });
        await expectRejection(
          () =>
            engine.transition({
              workflow_id: workflow.id,
              expected_state_version: 0,
              to: 'PLANNED',
              channel: 'normal',
              reason_codes: ['STALE'],
            }),
          'STATE_VERSION_CONFLICT',
        );
      },
    },
    {
      name: "an expired worker's write is fenced",
      run: async (engine, context) => {
        const workflow = await seedWorkflow(engine, context.ids.next('tenant'), context.ids.next('agent'));
        const first = await engine.acquireLease({
          workflow_id: workflow.id,
          owner: context.ids.next('workload'),
          ttl_seconds: 60,
        });
        context.advance(61_000);
        await engine.acquireLease({
          workflow_id: workflow.id,
          owner: context.ids.next('workload'),
          ttl_seconds: 60,
        });
        // The old worker does not know it lost. Its write must be rejected after the fact —
        // which is the entire reason a fencing token exists alongside an expiry.
        await expectRejection(
          () =>
            engine.transition({
              workflow_id: workflow.id,
              expected_state_version: workflow.state_version,
              to: 'TRIAGED',
              channel: 'normal',
              reason_codes: ['ZOMBIE'],
              fencing_token: first.fencing_token,
            }),
          'LEASE_FENCED',
        );
      },
    },
    {
      name: 'fencing tokens are monotonic',
      run: async (engine, context) => {
        const workflow = await seedWorkflow(engine, context.ids.next('tenant'), context.ids.next('agent'));
        const owner = context.ids.next('workload');
        const first = await engine.acquireLease({ workflow_id: workflow.id, owner, ttl_seconds: 60 });
        const second = await engine.acquireLease({ workflow_id: workflow.id, owner, ttl_seconds: 60 });
        expectTrue(second.fencing_token > first.fencing_token, 'a reissued lease gets a higher token');
      },
    },
    {
      name: 'a terminal state rejects every transition',
      run: async (engine, context) => {
        const workflow = await seedWorkflow(engine, context.ids.next('tenant'), context.ids.next('agent'));
        const rejected = await engine.transition({
          workflow_id: workflow.id,
          expected_state_version: 0,
          to: 'REJECTED',
          channel: 'normal',
          reason_codes: ['OUT_OF_SCOPE'],
        });
        await expectRejection(
          () =>
            engine.transition({
              workflow_id: workflow.id,
              expected_state_version: rejected.state_version,
              to: 'TRIAGED',
              channel: 'normal',
              reason_codes: ['RESURRECT'],
            }),
          'WORKFLOW_TERMINAL',
        );
      },
    },
    {
      name: 'the recovery scan finds a workflow whose lease expired',
      run: async (engine, context) => {
        const workflow = await seedWorkflow(engine, context.ids.next('tenant'), context.ids.next('agent'));
        await engine.acquireLease({
          workflow_id: workflow.id,
          owner: context.ids.next('workload'),
          ttl_seconds: 30,
        });
        expectEqual((await engine.recoveryScan()).length, 0, 'a live lease is not due for recovery');
        context.advance(31_000);
        expectTrue((await engine.recoveryScan()).includes(workflow.id), 'an expired lease is due');
      },
    },
  ],
);

// ---------------------------------------------------------------------------- S4 Policy

export const policySuite: ConformanceSuite<PolicyClient> = defineConformanceSuite('Policy (S4)', [
  {
    name: 'every decision names a reproducible bundle',
    run: async (policy, context) => {
      const decision = await policy.evaluate({
        tenant_id: context.ids.next('tenant'),
        agent_id: context.ids.next('agent'),
        workload_id: context.ids.next('workload'),
        workflow_id: context.ids.next('workflow'),
        plan_id: context.ids.next('plan'),
        action: 'jira.comment',
        resource: repoRef(),
        environment: 'nonprod',
        parameter_digest: A_SHA,
        data_classes: ['internal_source'],
      });
      expectTrue(
        /@sha256:[0-9a-f]{64}$/.test(decision.policy_bundle),
        'a decision must be reproducible against a content-pinned bundle',
      );
      expectTrue(decision.reason_codes.length > 0, 'a decision states why');
    },
  },
  {
    name: 'editing ANY bound field invalidates an approval',
    requires: ['approvals'],
    run: async (policy, context) => {
      const binding = {
        action: 'staging.deploy' as const,
        resource: 'service:api',
        environment: 'staging' as const,
        parameter_digest: A_SHA,
        plan_digest: A_SHA,
      };
      const approval = await policy.createApproval({
        decision_request_id: context.ids.next('decisionRequest'),
        approver: { human_id: context.ids.next('user'), authn_strength: 'mfa' },
        binding,
        expires_at: '2030-01-01T00:00:00Z',
        max_uses: 1,
      });

      // One field at a time, so a failure names the field that stopped being bound.
      const mutations = [
        { ...binding, action: 'git.push' as const },
        { ...binding, resource: 'service:other' },
        { ...binding, environment: 'prod' as const },
        { ...binding, parameter_digest: B_SHA },
        { ...binding, plan_digest: B_SHA },
      ];
      for (const mutated of mutations) {
        await expectRejection(
          () => policy.consumeApproval(approval.id, mutated),
          'APPROVAL_BINDING_MISMATCH',
        );
      }
    },
  },
  {
    name: 'a consumed approval cannot be replayed',
    requires: ['approvals'],
    run: async (policy, context) => {
      const binding = {
        action: 'staging.deploy' as const,
        resource: 'service:api',
        environment: 'staging' as const,
        parameter_digest: A_SHA,
        plan_digest: A_SHA,
      };
      const approval = await policy.createApproval({
        decision_request_id: context.ids.next('decisionRequest'),
        approver: { human_id: context.ids.next('user'), authn_strength: 'mfa' },
        binding,
        expires_at: '2030-01-01T00:00:00Z',
        max_uses: 1,
      });
      await policy.consumeApproval(approval.id, binding);
      await expectRejection(() => policy.consumeApproval(approval.id, binding), 'APPROVAL_CONSUMED');
    },
  },
  {
    name: 'an expired approval cannot be consumed',
    requires: ['approvals'],
    run: async (policy, context) => {
      const binding = {
        action: 'staging.deploy' as const,
        resource: 'service:api',
        environment: 'staging' as const,
        parameter_digest: A_SHA,
        plan_digest: A_SHA,
      };
      const approval = await policy.createApproval({
        decision_request_id: context.ids.next('decisionRequest'),
        approver: { human_id: context.ids.next('user'), authn_strength: 'mfa' },
        binding,
        expires_at: new Date(context.clock.nowMs() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        max_uses: 1,
      });
      context.advance(61_000);
      await expectRejection(() => policy.consumeApproval(approval.id, binding), 'APPROVAL_EXPIRED');
    },
  },
]);

// -------------------------------------------------------------------- S5 Capability broker

export const capabilityBrokerSuite: ConformanceSuite<CapabilityBrokerClient> = defineConformanceSuite(
  'CapabilityBroker (S5)',
  [
    {
      name: 'a well-formed capability verifies',
      run: async (broker, context) => {
        const capability = await broker.mint({
          subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
          workflow_id: context.ids.next('workflow'),
          action_id: context.ids.next('action'),
          operation: 'jira.comment',
          resource: 'ticket:jira:ENG-42',
          parameter_digest: A_SHA,
          max_uses: 1,
          lease_fencing_token: 7,
          requested_ttl_seconds: 300,
          policy_decision_id: context.ids.next('policyDecision'),
        });
        const verdict = await broker.verify(capability, {
          resource: 'ticket:jira:ENG-42',
          parameter_digest: A_SHA,
          fencing_token: 7,
        });
        expectTrue(verdict.valid, `expected a valid verdict, failed: ${verdict.failed_checks.join(',')}`);
      },
    },
    {
      name: 'the verification matrix catches expiry, fencing, parameters and resource',
      run: async (broker, context) => {
        const mint = () =>
          broker.mint({
            subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
            workflow_id: context.ids.next('workflow'),
            action_id: context.ids.next('action'),
            operation: 'jira.comment',
            resource: 'ticket:jira:ENG-42',
            parameter_digest: A_SHA,
            max_uses: 1,
            lease_fencing_token: 7,
            requested_ttl_seconds: 300,
            policy_decision_id: context.ids.next('policyDecision'),
          });

        const good = { resource: 'ticket:jira:ENG-42', parameter_digest: A_SHA, fencing_token: 7 };

        const wrongParameters = await broker.verify(await mint(), { ...good, parameter_digest: B_SHA });
        expectTrue(wrongParameters.failed_checks.includes('parameter_digest'), 'parameter digest is checked');

        const wrongResource = await broker.verify(await mint(), { ...good, resource: 'ticket:jira:ENG-99' });
        expectTrue(wrongResource.failed_checks.includes('resource'), 'target resource is checked');

        // A stale fencing token means the worker lost its lease. Its capability dies with it.
        const staleToken = await broker.verify(await mint(), { ...good, fencing_token: 6 });
        expectTrue(staleToken.failed_checks.includes('fencing_token'), 'fencing token is checked');

        const expiring = await mint();
        context.advance(301_000);
        const expired = await broker.verify(expiring, good);
        expectTrue(expired.failed_checks.includes('expiry'), 'expiry is checked');
      },
    },
    {
      name: 'a capability cannot be used more times than it permits',
      run: async (broker, context) => {
        const capability = await broker.mint({
          subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
          workflow_id: context.ids.next('workflow'),
          action_id: context.ids.next('action'),
          operation: 'jira.comment',
          resource: 'ticket:jira:ENG-42',
          parameter_digest: A_SHA,
          max_uses: 1,
          lease_fencing_token: 7,
          requested_ttl_seconds: 300,
          policy_decision_id: context.ids.next('policyDecision'),
        });
        const call = { resource: 'ticket:jira:ENG-42', parameter_digest: A_SHA, fencing_token: 7 };
        expectTrue((await broker.consume(capability.id, call)).valid, 'the first use succeeds');
        const second = await broker.consume(capability.id, call);
        expectTrue(second.failed_checks.includes('use_count'), 'the second use is refused');
      },
    },
    {
      name: 'an epoch bump invalidates every outstanding capability at once',
      run: async (broker, context) => {
        const capability = await broker.mint({
          subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
          workflow_id: context.ids.next('workflow'),
          action_id: context.ids.next('action'),
          operation: 'jira.comment',
          resource: 'ticket:jira:ENG-42',
          parameter_digest: A_SHA,
          max_uses: 5,
          lease_fencing_token: 7,
          requested_ttl_seconds: 300,
          policy_decision_id: context.ids.next('policyDecision'),
        });
        await broker.revoke({
          incident_id: 'inc_epoch',
          scope: { kind: 'global' },
          reason: 'conformance',
          requested_by: 'operator',
          requested_at: context.clock.nowIso(),
          revocation_epoch: 0,
        });
        const verdict = await broker.verify(capability, {
          resource: 'ticket:jira:ENG-42',
          parameter_digest: A_SHA,
          fencing_token: 7,
        });
        expectTrue(verdict.failed_checks.includes('revocation_epoch'), 'the epoch bump revoked it');
      },
    },
  ],
);

// ------------------------------------------------------------------------ S7 Connectors

export const connectorBrokerSuite: ConformanceSuite<{
  connectors: ConnectorBrokerClient;
  broker: CapabilityBrokerClient;
  /** Test seam: make the next execute of this operation answer ambiguously. */
  makeAmbiguous(operation: string): void;
  /** Test seam: tell reconcile what the provider will say. */
  setRemoteState(actionId: string, state: 'present' | 'absent' | 'indeterminate'): void;
}> = defineConformanceSuite('ConnectorBroker (S7)', [
  {
    name: 'an ambiguous timeout sets outcome_unknown and REFUSES automatic retry',
    run: async (subject, context) => {
      subject.makeAmbiguous('pull_request.create_draft');
      const action = await subject.connectors.prepare({
        workflow_id: context.ids.next('workflow'),
        adapter: 'github',
        operation: 'pull_request.create_draft',
        action_class: 'git.open_draft_pr',
        resource: repoRef(),
        parameters: { title: 'ENG-42' },
        policy_decision_id: context.ids.next('policyDecision'),
      });
      const capability = await subject.broker.mint({
        subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
        workflow_id: action.workflow_id,
        action_id: action.id,
        operation: 'git.open_draft_pr',
        resource: action.resource,
        parameter_digest: action.parameter_digest,
        max_uses: 5,
        lease_fencing_token: 1,
        requested_ttl_seconds: 300,
        policy_decision_id: action.policy_decision_id,
      });

      await expectRejection(() => subject.connectors.execute(action.id, capability), 'ACTION_OUTCOME_UNKNOWN');
      expectEqual(
        (await subject.connectors.getAction(action.id))?.state,
        'outcome_unknown',
        'an ambiguous timeout leaves the action in outcome_unknown',
      );
      // Contracts §7: this is the retry that must not happen. A second PR on one ticket is
      // exactly the damage the state exists to prevent.
      await expectRejection(() => subject.connectors.execute(action.id, capability), 'ACTION_OUTCOME_UNKNOWN');
    },
  },
  {
    name: 'reconciliation saying absent is what unblocks the retry',
    run: async (subject, context) => {
      subject.makeAmbiguous('pull_request.create_draft');
      const action = await subject.connectors.prepare({
        workflow_id: context.ids.next('workflow'),
        adapter: 'github',
        operation: 'pull_request.create_draft',
        action_class: 'git.open_draft_pr',
        resource: repoRef(),
        parameters: { title: 'ENG-42' },
        policy_decision_id: context.ids.next('policyDecision'),
      });
      const capability = await subject.broker.mint({
        subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
        workflow_id: action.workflow_id,
        action_id: action.id,
        operation: 'git.open_draft_pr',
        resource: action.resource,
        parameter_digest: action.parameter_digest,
        max_uses: 5,
        lease_fencing_token: 1,
        requested_ttl_seconds: 300,
        policy_decision_id: action.policy_decision_id,
      });
      await expectRejection(() => subject.connectors.execute(action.id, capability));

      subject.setRemoteState(action.id, 'absent');
      const reconciled = await subject.connectors.reconcile(action.id);
      expectEqual(reconciled.outcome, 'absent', 'the provider says the effect never happened');
      expectEqual(
        (await subject.connectors.getAction(action.id))?.state,
        'failed',
        'a definitely-absent action becomes retryable',
      );
    },
  },
  {
    name: 'an indeterminate reconciliation keeps the action blocked',
    run: async (subject, context) => {
      subject.makeAmbiguous('pull_request.create_draft');
      const action = await subject.connectors.prepare({
        workflow_id: context.ids.next('workflow'),
        adapter: 'github',
        operation: 'pull_request.create_draft',
        action_class: 'git.open_draft_pr',
        resource: repoRef(),
        parameters: { title: 'ENG-42' },
        policy_decision_id: context.ids.next('policyDecision'),
      });
      const capability = await subject.broker.mint({
        subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
        workflow_id: action.workflow_id,
        action_id: action.id,
        operation: 'git.open_draft_pr',
        resource: action.resource,
        parameter_digest: action.parameter_digest,
        max_uses: 5,
        lease_fencing_token: 1,
        requested_ttl_seconds: 300,
        policy_decision_id: action.policy_decision_id,
      });
      await expectRejection(() => subject.connectors.execute(action.id, capability));
      subject.setRemoteState(action.id, 'indeterminate');
      await subject.connectors.reconcile(action.id);
      // "I still cannot tell" must not be rounded down to "it did not happen".
      expectEqual(
        (await subject.connectors.getAction(action.id))?.state,
        'outcome_unknown',
        'indeterminate leaves the action blocked',
      );
    },
  },
  {
    name: 'a parameter mismatch against the capability digest is rejected',
    run: async (subject, context) => {
      const action = await subject.connectors.prepare({
        workflow_id: context.ids.next('workflow'),
        adapter: 'jira',
        operation: 'issue.add_comment',
        action_class: 'jira.comment',
        resource: 'ticket:jira:ENG-42',
        parameters: { body: 'hello' },
        policy_decision_id: context.ids.next('policyDecision'),
      });
      const capability = await subject.broker.mint({
        subject: { workload_id: context.ids.next('workload'), agent_id: context.ids.next('agent') },
        workflow_id: action.workflow_id,
        action_id: action.id,
        operation: 'jira.comment',
        resource: action.resource,
        // Bound to different parameters than the action carries.
        parameter_digest: digestOf('something else entirely'),
        max_uses: 1,
        lease_fencing_token: 1,
        requested_ttl_seconds: 300,
        policy_decision_id: action.policy_decision_id,
      });
      await expectRejection(
        () => subject.connectors.execute(action.id, capability),
        'CAPABILITY_PARAMETER_MISMATCH',
      );
    },
  },
]);

// --------------------------------------------------------------------------- S9 Evidence

const PASSING_BUNDLE = (workflowId: string) => ({
  workflow_id: workflowId,
  task_source: 'ticket:jira:ENG-42@1',
  repository: {
    url: 'https://example.invalid/team/api',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    diff_digest: A_SHA,
  },
  environment: { worker_image: `worker@sha256:${'0'.repeat(64)}`, toolchain: ['node-22'] },
  checks: [
    { name: 'unit', command_digest: A_SHA, status: 'pass' as const, exit_code: 0, log_ref: null, log_digest: null, reason: null },
  ],
  verifier: { version: 'verifier-v3', verdict: 'pass' as const, limitations: [] },
  policy_refs: [],
  approval_refs: [],
  action_refs: [],
  artifacts: [],
});

export const evidenceSuite: ConformanceSuite<EvidenceClient> = defineConformanceSuite('Evidence (S9)', [
  {
    name: 'the delivery gate rejects an incomplete bundle',
    run: async (evidence, context) => {
      const workflowId = context.ids.next('workflow');
      const incomplete = {
        ...PASSING_BUNDLE(workflowId),
        checks: [
          {
            name: 'unit',
            command_digest: A_SHA,
            status: 'fail' as const,
            exit_code: 1,
            log_ref: null,
            log_digest: null,
            reason: null,
          },
        ],
        verifier: { version: 'verifier-v3', verdict: 'fail' as const, limitations: [] },
      };
      await expectRejection(() => evidence.assembleBundle(incomplete), 'EVIDENCE_INCOMPLETE');
    },
  },
  {
    name: 'artifact digests are stable across re-put',
    run: async (evidence) => {
      const content = new TextEncoder().encode('the same bytes');
      const retention = { expires_at: null, legal_hold: false };
      const first = await evidence.putArtifact({ kind: 'log', content, retention, data_classes: ['internal'] });
      const second = await evidence.putArtifact({ kind: 'log', content, retention, data_classes: ['internal'] });
      expectEqual(second.digest, first.digest, 'identical bytes hash identically');
      expectEqual(second.ref, first.ref, 'a content-addressed store returns the existing ref');
    },
  },
  {
    name: 'a correction supersedes and leaves the original intact',
    run: async (evidence, context) => {
      const workflowId = context.ids.next('workflow');
      const original = await evidence.assembleBundle(PASSING_BUNDLE(workflowId));
      const replacement = await evidence.supersede(original.id, PASSING_BUNDLE(workflowId));
      expectEqual(replacement.supersedes, original.id, 'the correction points at what it replaces');
      const reread = await evidence.getBundle(original.id);
      // Contracts §10: an evidence bundle is immutable. "We corrected it" and "we replaced
      // it" have to stay distinguishable after the fact.
      expectTrue(reread !== null, 'the original is still retrievable');
      expectEqual(reread.supersedes, null, 'the original was not mutated');
    },
  },
]);

// --------------------------------------------------------------------------- S12 Verifier

export const verifierSuite: ConformanceSuite<VerifierClient> = defineConformanceSuite('Verifier (S12)', [
  {
    name: 'fails closed on an unsupported manifest version',
    run: async (verifier, context) => {
      await expectRejection(
        () =>
          verifier.verify({
            workflow_id: context.ids.next('workflow'),
            goal_digest: A_SHA,
            diff_digest: A_SHA,
            head_sha: 'a'.repeat(40),
            definition_of_done_ref: 'dod_default_v1',
            manifest_version: 'verifier-v99',
            evidence_refs: [],
          }),
        'VERIFY_MANIFEST_INVALID',
      );
    },
  },
  {
    name: 'a manifest with no version is invalid, not assumed current',
    run: async (verifier) => {
      const result = await verifier.validateManifest({ checks: [] });
      expectTrue(!result.valid, 'a versionless manifest is invalid');
    },
  },
  {
    name: 'holds no publish capability',
    run: async (verifier) => {
      // S12: "the verifier cannot publish or approve". Asserted against the object, so a
      // future implementation that grows one fails here rather than in review.
      for (const forbidden of ['publish', 'comment', 'approve', 'transition', 'merge']) {
        expectTrue(
          !(forbidden in (verifier as unknown as Record<string, unknown>)),
          `the verifier must not expose "${forbidden}"`,
        );
      }
    },
  },
]);

// ------------------------------------------------------- S13 / S14 shared storage suite

export const memoryStoreSuite: ConformanceSuite<MemoryStore> = defineConformanceSuite(
  'MemoryStore (S13 reference and S14 Ditto)',
  [
    {
      name: 'round-trips a record within its tenant',
      run: async (store, context) => {
        const tenantId = context.ids.next('tenant');
        const record = memoryRecord(tenantId, context.ids.next('memory'), 'the build is flaky on windows');
        await store.put(record);
        const read = await store.get(tenantId, record.id);
        expectTrue(read !== null, 'the record is readable');
        expectEqual(read.claim, record.claim, 'the claim survives the round trip');
      },
    },
    {
      name: 'never returns a record from another tenant',
      run: async (store, context) => {
        const tenantA = context.ids.next('tenant');
        const tenantB = context.ids.next('tenant');
        const record = memoryRecord(tenantA, context.ids.next('memory'), 'tenant A only');
        await store.put(record);
        expectEqual(await store.get(tenantB, record.id), null, 'cross-tenant read must return nothing');
        expectEqual((await store.query({ tenant_id: tenantB })).length, 0, 'cross-tenant query is empty');
      },
    },
    {
      name: 'a tombstone is visible as a tombstone, not as an absence',
      run: async (store, context) => {
        const tenantId = context.ids.next('tenant');
        const record = memoryRecord(tenantId, context.ids.next('memory'), 'to be retracted');
        await store.put(record);
        await store.tombstone(tenantId, record.id);
        const read = await store.get(tenantId, record.id);
        // Deleting the row would make "this was retracted" indistinguishable from "we never
        // knew that", and correction propagation depends on the difference.
        expectTrue(read !== null, 'the record still exists');
        expectEqual(read.status, 'tombstoned', 'and it is marked tombstoned');
      },
    },
    {
      name: 'a subscription sees only what its scope covers',
      run: async (store, context) => {
        const tenantId = context.ids.next('tenant');
        const seen: string[] = [];
        const subscription = store.subscribe({ tenant_id: tenantId }, (record) => seen.push(record.id));
        const mine = memoryRecord(tenantId, context.ids.next('memory'), 'in scope');
        const theirs = memoryRecord(context.ids.next('tenant'), context.ids.next('memory'), 'out of scope');
        await store.put(mine);
        await store.put(theirs);
        subscription.close();
        expectEqual(seen.length, 1, 'only the in-scope record was delivered');
        expectEqual(seen[0], mine.id, 'and it was the right one');
      },
    },
    {
      name: 'a closed subscription stops delivering',
      run: async (store, context) => {
        const tenantId = context.ids.next('tenant');
        let count = 0;
        const subscription = store.subscribe({ tenant_id: tenantId }, () => (count += 1));
        subscription.close();
        await store.put(memoryRecord(tenantId, context.ids.next('memory'), 'after close'));
        expectEqual(count, 0, 'nothing is delivered after close');
      },
    },
  ],
);

function memoryRecord(tenantId: string, id: string, claim: string): MemoryRecord {
  return {
    schema: 'agentdev.memory.v2',
    id,
    tenant_id: tenantId,
    correlation_id: `${ID_PREFIX.correlation}${'0'.repeat(26)}`,
    created_at: '2026-07-30T08:00:00Z',
    producer: { service: 'memory', instance: 'conformance', version: '0' },
    data_classes: ['internal'],
    integrity: { alg: 'sha256', digest: '0'.repeat(64), version: 1 },
    owner_scope: { type: 'agent', id: `${ID_PREFIX.agent}${'0'.repeat(26)}` },
    record_type: 'fact',
    source_or_derived: 'source',
    claim,
    scope: {},
    provenance: { source_refs: ['run:ci:1'], derivation: null },
    confidence: 0.5,
    status: 'active',
    observed_at: '2026-07-30T08:00:00Z',
    valid_from: '2026-07-30T08:00:00Z',
    valid_until: null,
    data_class: 'internal',
    acl: { read: [], publish: [] },
    retention: { expires_at: null, legal_hold: false },
    supersedes: null,
  };
}

/** Everything a Wave-1 session can point at its own implementation. */
export const CONFORMANCE_SUITES = {
  controlHooks: controlHooksSuite,
  ingress: ingressSuite,
  workflow: workflowEngineSuite,
  policy: policySuite,
  broker: capabilityBrokerSuite,
  connectors: connectorBrokerSuite,
  evidence: evidenceSuite,
  verifier: verifierSuite,
  memoryStore: memoryStoreSuite,
} as const;
