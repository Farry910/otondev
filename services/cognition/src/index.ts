/**
 * S6 — Cognition Gateway.
 *
 * The egress control point between agents and model providers. Nothing here returns an
 * authorization: `CognitionResult` has no field for one, and none of the exported functions
 * can express one.
 *
 * Landed so far: the routing algorithm's selection half (steps 1–5), which is the part a
 * prompt-injection attack would most want to influence and the part several exit criteria
 * depend on. Steps 6–9, the context builder, the provider adapters, budget reservation and
 * the audit record are still to come.
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
