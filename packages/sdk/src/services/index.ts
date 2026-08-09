export * from './control-plane.js';
export * from './execution-plane.js';
export * from './data-plane.js';
export * from './presence-plane.js';
export * from './cross-cutting.js';

import type {
  AgentCoreClient,
  AuditClient,
  CapabilityBrokerClient,
  CognitionClient,
  ConnectorBrokerClient,
  IngressClient,
  PolicyClient,
  WorkflowEngineClient,
} from './control-plane.js';
import type {
  EvidenceClient,
  ExecutorClient,
  VerifierClient,
  WorkspaceClient,
} from './execution-plane.js';
import type { MemoryClient, MemoryStoreClient } from './data-plane.js';
import type {
  PresenceClient,
  PresentationControllerClient,
  WindowsSupervisorClient,
} from './presence-plane.js';
import type { EvaluationClient, IntegrationHarness, OperatorClient } from './cross-cutting.js';

/**
 * Every service, in one type.
 *
 * A session declares the peers it needs as a `Pick<ServiceRegistry, 'policy' | 'audit'>` and
 * takes them as a constructor argument. That is the whole dependency-injection story: no
 * container, no service locator, and no way to reach a peer that was not declared.
 */
export interface ServiceRegistry {
  ingress: IngressClient; // S1
  workflow: WorkflowEngineClient; // S2
  core: AgentCoreClient; // S3
  policy: PolicyClient; // S4
  broker: CapabilityBrokerClient; // S5
  cognition: CognitionClient; // S6
  connectors: ConnectorBrokerClient; // S7
  audit: AuditClient; // S8
  evidence: EvidenceClient; // S9
  workspace: WorkspaceClient; // S10
  executor: ExecutorClient; // S11
  verifier: VerifierClient; // S12
  memory: MemoryClient; // S13
  memoryStore: MemoryStoreClient; // S14
  presence: PresenceClient; // S15
  companion: PresentationControllerClient; // S16
  supervisor: WindowsSupervisorClient; // S17
  operator: OperatorClient; // S18
  eval: EvaluationClient; // S19
  integration: IntegrationHarness; // S20
}

export type ServiceName = keyof ServiceRegistry;

export const SERVICE_NAMES: readonly ServiceName[] = [
  'ingress',
  'workflow',
  'core',
  'policy',
  'broker',
  'cognition',
  'connectors',
  'audit',
  'evidence',
  'workspace',
  'executor',
  'verifier',
  'memory',
  'memoryStore',
  'presence',
  'companion',
  'supervisor',
  'operator',
  'eval',
  'integration',
];
