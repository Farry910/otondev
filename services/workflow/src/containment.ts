import type { Clock } from '@otondev/contracts';
import type { CapabilityBrokerClient, ControlAck } from '@otondev/sdk';

/**
 * The precondition on pause and cancel.
 *
 * Contracts §3 is specific about ordering, and the order is the whole point:
 *
 *   "the transition completes only after active capabilities are denied, the current lease is
 *    fenced or safely checkpointed, and the state-specific containment rule succeeds"
 *
 * A workflow that reads `PAUSED` while its worker still holds a live capability is worse than
 * one that reads `EXECUTING`, because an operator looking at the first one believes the agent
 * has stopped. So the engine denies capabilities *first*, fences the lease *second*, and only
 * then commits the state — and if the first step fails, the state does not move at all.
 *
 * Expressed as a narrow port rather than a direct dependency on the broker so S2 stays
 * buildable and testable with S5 faked (implementation-plan §1 property 3).
 */

export interface ContainmentRequest {
  workflow_id: string;
  incident_id: string;
  reason: string;
  requested_by: string;
}

export interface ContainmentOutcome {
  /** False means the pause or cancel must not complete. */
  denied: boolean;
  /** What the peer reported it actually contained. Empty is legitimate — see below. */
  contained: string[];
  detail: string;
}

export interface ContainmentPort {
  denyCapabilities(request: ContainmentRequest): Promise<ContainmentOutcome>;
}

/**
 * Adapts the SDK capability-broker client to the port.
 *
 * `not_applicable` counts as denied. The hook contract says an empty `contained` with a
 * successful outcome means "nothing here to contain", and a broker holding no live
 * capabilities for this workflow is the common case for a pause during PLANNED. Treating it
 * as a failure would make pause unreliable exactly when it is cheapest.
 *
 * `partial`, `unreachable` and `failed` are refusals. In particular `unreachable` must never
 * pass: it is indistinguishable from "the broker is wedged and still minting", which is the
 * scenario the criterion exists for.
 */
export function brokerContainment(broker: CapabilityBrokerClient, clock: Clock): ContainmentPort {
  return {
    async denyCapabilities(request): Promise<ContainmentOutcome> {
      let ack: ControlAck;
      try {
        ack = await broker.deny({
          incident_id: request.incident_id,
          scope: { kind: 'workflow', id: request.workflow_id },
          reason: request.reason,
          requested_by: request.requested_by,
          requested_at: clock.nowIso(),
        });
      } catch (error) {
        return {
          denied: false,
          contained: [],
          detail: `broker.deny threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const denied = ack.outcome === 'contained' || ack.outcome === 'not_applicable';
      return {
        denied,
        contained: ack.contained,
        detail: denied
          ? `broker acked ${ack.outcome}`
          : `broker acked ${ack.outcome}; outstanding: ${
              ack.outstanding.map((o) => `${o.subject}(${o.reason})`).join(', ') || 'none reported'
            }`,
      };
    },
  };
}

/** A port that contains nothing, for deployments where no broker is wired yet. */
export const noContainment: ContainmentPort = {
  async denyCapabilities() {
    return { denied: true, contained: [], detail: 'no capability broker configured' };
  },
};
