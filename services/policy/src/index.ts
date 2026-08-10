/**
 * S4 — Policy and Approval.
 *
 * Deterministic evaluation over actor, action, resource, environment, data class, incident
 * mode and cost; effective autonomy as the minimum across every dimension; signed, versioned
 * policy bundles; and approvals bound to exactly what was approved.
 *
 * Consumed through the `PolicyClient` interface in `@otondev/sdk`. Nothing outside this
 * package should import anything below the entrypoint.
 */

export { PolicyService } from './service.js';
export type { PolicyServiceConfig } from './service.js';

export { evaluate } from './evaluate.js';
export type { ApprovalVerdict, EvaluateInput, EvaluationOutcome, PolicyEvaluationQuery } from './evaluate.js';

export { bundleRef, bundleBytes, loadBundle, signBundle, BundleRejected, PolicyBundleBody, SignedPolicyBundle } from './bundle.js';
export type { ActionRule, AutonomyCeilings, LoadedBundle } from './bundle.js';

export { resolveEffectiveAutonomy, meetsAutonomy, bindingDimensions, AUTONOMY_DIMENSIONS } from './autonomy.js';
export type { AutonomyContribution, AutonomyDimension, AutonomyInputs, AutonomyResolution } from './autonomy.js';

export { checkBinding, checkConsumable, consumed, expired, meetsAuthnStrength } from './approvals.js';
export type { BindingCheck, LifecycleInput } from './approvals.js';

export { canonicalise, parameterDigest, digestOfText, NonCanonicalValueError } from './normalize.js';
export type { Normalisable } from './normalize.js';

export { InMemoryPolicyStore } from './store.js';
export type { PolicyStore } from './store.js';

export { REASON_CODES, ALL_REASON_CODES, REASON_CODE_PATTERN } from './reasons.js';
export type { ReasonCode } from './reasons.js';
