import { dataClassRank, mostRestrictiveDataClass } from '@otondev/contracts';
import type { ActionClass, AutonomyLevel, DataClass, Environment } from '@otondev/contracts';
import type { PolicyQuery } from '@otondev/sdk';
import type { ActionRule, PolicyBundleBody } from './bundle.js';
import { meetsAutonomy, resolveEffectiveAutonomy } from './autonomy.js';
import type { AutonomyContribution } from './autonomy.js';
import type { ReasonCode } from './reasons.js';

/**
 * The evaluator.
 *
 * A pure function of (bundle, query, approval state). No clock, no store, no randomness — the
 * caller supplies `now` and the approval verdict. That is what makes the S4 criterion
 * "reproducible from logged inputs plus bundle hash" true by construction rather than by
 * discipline: given the same inputs there is nothing else for the answer to depend on.
 *
 * The checks run in a fixed order and the first refusal wins. Order is part of the contract,
 * not an implementation detail — it decides which reason code a caller sees, and a caller
 * that branches on the reason needs that to be stable across releases.
 */

/**
 * `PolicyQuery` plus the two inputs the S4 brief requires that the frozen SDK type does not
 * yet carry. Both are optional, so an SDK-typed query is still a valid argument, and both
 * default to the safe reading: no cost information means zero, no approval means none.
 *
 * Raised as a contract request against `packages/sdk` — see the card log. Until it lands,
 * a caller that needs cost-aware decisions passes this wider type.
 */
export interface PolicyEvaluationQuery extends PolicyQuery {
  /** What the action is estimated to cost, in USD. Absent is treated as 0, not as unknown. */
  estimated_cost_usd?: number;
  /** An approval the caller believes authorises this action. */
  approval_id?: string;
}

/** What the approval store concluded. Resolved before evaluation so this stays pure. */
export type ApprovalVerdict =
  | { present: false }
  | { present: true; valid: true; approvalId: string }
  | { present: true; valid: false; approvalId: string; reason: ReasonCode };

export interface EvaluationOutcome {
  decision: 'allow' | 'deny' | 'require_approval';
  reason_codes: ReasonCode[];
  /** Effective autonomy. `A0` whenever it could not be established — never a guess upward. */
  autonomy_level: AutonomyLevel;
  constraints: Record<string, string | number | boolean>;
  /** Which dimensions pinned the effective autonomy. Explains the number. */
  binding_dimensions: AutonomyContribution[];
  /** Present when the outcome is `require_approval`. */
  minimum_authn_strength?: ActionRule['minimum_authn_strength'];
}

function deny(reasons: ReasonCode[], constraints: Record<string, never> = {}): EvaluationOutcome {
  // A0 rather than the computed level: if we are denying because we could not establish an
  // input, reporting any higher number would be asserting something we do not know.
  return {
    decision: 'deny',
    reason_codes: reasons,
    autonomy_level: 'A0',
    constraints,
    binding_dimensions: [],
  };
}

export interface EvaluateInput {
  bundle: PolicyBundleBody;
  query: PolicyEvaluationQuery;
  approval: ApprovalVerdict;
}

export function evaluate({ bundle, query, approval }: EvaluateInput): EvaluationOutcome {
  // 1. Tenant. A bundle governs one tenant; evaluating a different tenant's request against
  //    it would produce a confident answer from the wrong rules.
  if (query.tenant_id !== bundle.tenant_id) {
    return deny(['DENIED_TENANT_MISMATCH']);
  }

  // 2. Secret-class data is illegal in a contract payload (contracts §1). The envelope
  //    already refuses it; refusing again here means a caller that assembled a query by hand
  //    cannot slip past by skipping envelope validation.
  if (query.data_classes.includes('secret' as DataClass)) {
    return deny(['DENIED_SECRET_DATA_CLASS']);
  }

  // 3. Resource. Unknown denies — this is the criterion, and it is checked before anything
  //    that might otherwise produce a permissive answer.
  if (!isKnownResource(bundle, query.resource)) {
    return deny(['DENIED_UNKNOWN_RESOURCE', 'DENIED_UNKNOWN_INPUT']);
  }

  // 4. Action rule.
  const rule = bundle.rules.find((candidate) => candidate.action === query.action);
  if (rule === undefined) {
    return deny(['DENIED_UNKNOWN_ACTION', 'DENIED_UNKNOWN_INPUT']);
  }

  // 5. Environment.
  if (!rule.environments.includes(query.environment as Environment)) {
    return deny(['DENIED_ENVIRONMENT_NOT_PERMITTED']);
  }

  // 6. Data class ceiling for this action.
  if (query.data_classes.length === 0) {
    return deny(['DENIED_UNKNOWN_INPUT']);
  }
  const highest = mostRestrictiveDataClass(query.data_classes);
  if (dataClassRank(highest) > dataClassRank(rule.max_data_class)) {
    return deny(['DENIED_DATA_CLASS_TOO_HIGH']);
  }

  // 7. Effective autonomy: the minimum across every dimension, with unknowns fatal.
  const resolution = resolveEffectiveAutonomy(bundle.ceilings, {
    agentId: query.agent_id,
    resource: query.resource,
    environment: query.environment,
    dataClasses: query.data_classes,
    actionClass: query.action as ActionClass,
    incidentMode: query.incident_mode === true,
  });
  if (!resolution.ok) {
    return deny(['DENIED_UNKNOWN_INPUT']);
  }

  const { effective, contributions } = resolution;
  const binding = contributions.filter((c) => c.level === effective);
  const incidentIsBinding = binding.some((c) => c.dimension === 'incident_mode');

  // 8. Cost ceiling. Absent cost means zero, which is the safe reading: it can only make an
  //    action cheaper than reality, and the cost ceiling is not the only control.
  const cost = query.estimated_cost_usd ?? 0;
  if (cost > rule.cost.deny_above_usd) {
    return deny(['DENIED_COST_ABOVE_CEILING']);
  }

  // 9. Does this need a human?
  const reasons: ReasonCode[] = [];
  const autonomyShort = !meetsAutonomy(effective, rule.min_autonomy);
  const costNeedsApproval = cost > rule.cost.approval_above_usd;

  if (rule.always_requires_approval) reasons.push('APPROVAL_REQUIRED_BY_RULE');
  if (autonomyShort) reasons.push('APPROVAL_REQUIRED_AUTONOMY');
  if (costNeedsApproval) reasons.push('APPROVAL_REQUIRED_COST');
  if (autonomyShort && incidentIsBinding) reasons.push('DENIED_INCIDENT_MODE');

  const needsApproval = reasons.length > 0;

  if (!needsApproval) {
    const allowReasons: ReasonCode[] = ['AUTONOMY_SUFFICIENT'];
    if (rule.cost.approval_above_usd > 0) allowReasons.push('WITHIN_COST_BUDGET');
    return {
      decision: 'allow',
      reason_codes: allowReasons,
      autonomy_level: effective,
      constraints: rule.constraints,
      binding_dimensions: binding,
    };
  }

  // 10. An approval can satisfy the requirement — but only a valid one, and an invalid one
  //     never downgrades the outcome to something weaker than "we still need a human".
  if (approval.present && approval.valid) {
    return {
      decision: 'allow',
      reason_codes: ['APPROVAL_PRESENT', ...reasons],
      autonomy_level: effective,
      constraints: rule.constraints,
      binding_dimensions: binding,
    };
  }

  return {
    decision: 'require_approval',
    reason_codes: approval.present && !approval.valid ? [approval.reason, ...reasons] : reasons,
    autonomy_level: effective,
    constraints: rule.constraints,
    binding_dimensions: binding,
    minimum_authn_strength: rule.minimum_authn_strength,
  };
}

function isKnownResource(bundle: PolicyBundleBody, resource: string): boolean {
  if (bundle.known_resources.includes(resource)) return true;
  // A trailing `/*` is a prefix grant: `repo:team/*` covers `repo:team/api`. Anything looser
  // — a bare `*`, a substring match — would make "unknown denies" unfalsifiable.
  return bundle.known_resources.some(
    (known) => known.endsWith('/*') && resource.startsWith(known.slice(0, -1)),
  );
}
