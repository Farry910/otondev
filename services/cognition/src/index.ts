/**
 * S6 — Cognition Gateway.
 *
 * The egress control point between agents and model providers. It builds the minimum
 * authorized context, routes by data policy before capability, calls providers behind stable
 * adapters, validates structured output, enforces spend, and emits privacy-aware audit
 * metadata.
 *
 * It does **not** authorize anything. `CognitionResult` has no field for an authorization,
 * none of the exported operations can express one, and an authorization-shaped field in a
 * model response is a hard failure rather than a stripped key — stripping would let a
 * compromised model keep trying silently.
 */

export {
  DEFAULT_ROUTING_POLICY,
  selectRoute,
  type ModelCandidate,
  type ProviderHealth,
  type QualityTier,
  type Retention,
  type RouteOutcome,
  type RouteRefusalCode,
  type RouteTrace,
  type RoutingPolicy,
} from './routing.js';

export {
  DEFAULT_CONTEXT_POLICY,
  SECTION_ORDER,
  buildContext,
  type BuiltContext,
  type ContextBuilderPolicy,
  type ContextFragment,
  type ContextOutcome,
  type DroppedFragment,
  type SectionName,
} from './context-builder.js';

export {
  detectSecrets,
  redactSecrets,
  type SecretFinding,
  type SecretKind,
} from './secrets.js';

export {
  LocalAdapter,
  providerFailure,
  type FinishReason,
  type ProviderAdapter,
  type ProviderCallInput,
  type ProviderCompletion,
  type ProviderUsage,
} from './providers.js';

export {
  ResponseSchemaRegistry,
  findForbiddenField,
  schemaFrom,
  validateResponse,
  type ResponseSchema,
  type ValidationFailure,
  type ValidationOutcome,
} from './validation.js';

export {
  BudgetLedger,
  authorizeIncrease,
  type BudgetState,
  type IncreaseAuthorization,
  type IncreasePrincipal,
  type Reservation,
  type ReserveOutcome,
} from './budget.js';

export {
  FORBIDDEN_AUDIT_FIELDS,
  InMemoryAuditSink,
  summariseContextForAudit,
  type AuditSink,
  type CognitionAuditRecord,
  type CognitionPayloadRecord,
} from './audit.js';

export {
  INJECTION_CORPUS,
  assessContainment,
  responseIsContained,
  runInjectionCorpus,
  type ContainmentResult,
  type CorpusReport,
  type InjectionCase,
  type InjectionClass,
} from './injection-corpus.js';

export { CognitionGateway, type CognitionGatewayOptions, type ContextSource } from './gateway.js';
