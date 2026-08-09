import { ContractError, makeError } from '@otondev/contracts';
import type { Clock, DataClass, IdFactory } from '@otondev/contracts';
import type { ServiceRegistry } from '@otondev/sdk';

/**
 * A trivial consumer.
 *
 * This package exists to make Wave 0's exit criterion executable: *a consumer can be written
 * against any service interface, run its tests with every peer faked, offline, and green*.
 *
 * It is also the template for every Wave-1 package. Three properties, and each one is the
 * point rather than a stylistic preference:
 *
 *   1. It declares the peers it needs as `Pick<ServiceRegistry, ...>` and takes them as a
 *      constructor argument. It cannot reach a peer it did not declare, and there is no
 *      container to reach through.
 *   2. It imports no service implementation, only `@otondev/sdk` interfaces. The
 *      `no-cross-service` boundary rule makes anything else a build failure.
 *   3. It takes its clock and its id factory as arguments. Every deadline in this system is
 *      a rule that has to be tested, and a service that reads `Date.now()` internally cannot
 *      be tested for any of them without sleeping.
 *
 * What it does: take a webhook, get a decision, mint a capability, publish a comment, and
 * refuse — correctly — at every point the design says to refuse.
 */

export interface TicketCommenterDeps
  extends Pick<ServiceRegistry, 'ingress' | 'workflow' | 'policy' | 'broker' | 'connectors' | 'audit'> {
  clock: Clock;
  ids: IdFactory;
  tenantId: string;
  agentId: string;
  workloadId: string;
}

export type CommentOutcome =
  | { status: 'published'; action_id: string; remote_ref: string | null }
  | { status: 'duplicate_event'; event_id: string }
  | { status: 'refused'; code: string; reason: string };

export class TicketCommenter {
  readonly #deps: TicketCommenterDeps;

  constructor(deps: TicketCommenterDeps) {
    this.#deps = deps;
  }

  /**
   * The whole nine-yard path, minus everything that is not Wave 0's business.
   *
   * Every failure returns a `refused` outcome carrying a stable error code rather than
   * throwing something the caller has to pattern-match on a message. That is the error
   * contract (contracts §11) applied at the smallest possible scale.
   */
  async handleWebhook(body: string, headers: Record<string, string>): Promise<CommentOutcome> {
    const { ingress, workflow, policy, broker, connectors, audit, clock, ids } = this.#deps;

    const ingested = await ingress.ingest({
      system: 'jira',
      installation_id: 'jira_acme',
      body: new TextEncoder().encode(body),
      headers,
      received_at: clock.nowIso(),
    });

    // A duplicate is a normal outcome with a useful answer, not an error. Retrying here is
    // exactly how one ticket ends up with three comments.
    if (ingested.status === 'duplicate') {
      return { status: 'duplicate_event', event_id: ingested.event_id };
    }
    if (ingested.status === 'rejected') {
      return { status: 'refused', code: ingested.code, reason: 'ingress refused the delivery' };
    }

    // The error boundary opens *here*, not after the lease is taken. Creating a workflow can
    // fail — an emergency deny is in force, the engine is degraded — and a refusal that
    // escapes as an exception is a refusal the caller has to guess the shape of.
    let created: Awaited<ReturnType<typeof workflow.create>> | undefined;
    let lease: Awaited<ReturnType<typeof workflow.acquireLease>> | undefined;

    try {
      created = await workflow.create({
        tenant_id: this.#deps.tenantId,
        agent_id: this.#deps.agentId,
        type: 'ticket_delivery',
        goal_ref: ids.next('artifact'),
        source_refs: [ingested.event_id],
        definition_of_done_ref: 'dod_comment_v1',
        risk: 'low',
        data_classes: ['internal_source' as DataClass],
        autonomy_required: 'A2',
        priority: 50,
        budget: { usd_max: 1, deadline: iso(clock, 3600), cpu_seconds: 60 },
      });

      lease = await workflow.acquireLease({
        workflow_id: created.id,
        owner: this.#deps.workloadId,
        ttl_seconds: 300,
      });

      const action = await connectors.prepare({
        workflow_id: created.id,
        adapter: 'jira',
        operation: 'issue.add_comment',
        action_class: 'jira.comment',
        resource: 'ticket:jira:ENG-42',
        parameters: { body: 'Picked this up.' },
        policy_decision_id: ids.next('policyDecision'),
      });

      const decision = await policy.evaluate({
        tenant_id: this.#deps.tenantId,
        agent_id: this.#deps.agentId,
        workload_id: this.#deps.workloadId,
        workflow_id: created.id,
        plan_id: ids.next('plan'),
        action: 'jira.comment',
        resource: action.resource,
        environment: 'nonprod',
        parameter_digest: action.parameter_digest,
        data_classes: ['internal_source' as DataClass],
      });

      if (decision.decision !== 'allow') {
        await audit.append({
          partition: `${this.#deps.tenantId}:policy`,
          severity: 'security',
          component: 'policy',
          event: 'policy.decision.recorded',
          subject_refs: [decision.id, action.resource],
          attributes: { decision: decision.decision },
          message: 'Comment not permitted.',
        });
        return {
          status: 'refused',
          code: decision.decision === 'deny' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED',
          reason: decision.reason_codes.join(','),
        };
      }

      // The capability is bound to this action's parameters and to this lease's fencing
      // token. A worker that loses its lease loses the ability to act, at the same instant.
      const capability = await broker.mint({
        subject: { workload_id: this.#deps.workloadId, agent_id: this.#deps.agentId },
        workflow_id: created.id,
        action_id: action.id,
        operation: 'jira.comment',
        resource: action.resource,
        parameter_digest: action.parameter_digest,
        max_uses: 1,
        lease_fencing_token: lease.fencing_token,
        requested_ttl_seconds: 300,
        policy_decision_id: decision.id,
      });

      const published = await connectors.execute(action.id, capability);
      await audit.append({
        partition: `${this.#deps.tenantId}:actions`,
        severity: 'notice',
        component: 'connectors',
        event: 'action.published',
        subject_refs: [published.id],
        attributes: { adapter: published.adapter, result: published.state },
        message: 'Comment published.',
      });
      return { status: 'published', action_id: published.id, remote_ref: published.remote_ref };
    } catch (error) {
      if (error instanceof ContractError) {
        return { status: 'refused', code: error.code, reason: error.contract.public_message };
      }
      // Nothing crosses this boundary as a bare Error either.
      throw new ContractError(
        makeError('INTERNAL', {
          diagnostic_ref: `example-consumer:${clock.nowIso()}`,
          occurred_at: clock.nowIso(),
        }),
      );
    } finally {
      if (created !== undefined && lease !== undefined) {
        await workflow.releaseLease(created.id, lease.fencing_token).catch(() => {
          // A lease that could not be released expires on its own. Failing the whole
          // operation because cleanup failed would turn a published comment into a
          // reported failure — the worst possible direction to be wrong in.
        });
      }
    }
  }
}

function iso(clock: Clock, plusSeconds: number): string {
  return new Date(clock.nowMs() + plusSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
