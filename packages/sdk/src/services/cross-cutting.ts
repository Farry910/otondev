import type { ServiceClient, ContainmentReport, ControlScope } from '../hooks.js';

/**
 * Cross-cutting client interfaces, S18-S20.
 */

// --------------------------------------------------------------------------- S18 Operator

export interface OperatorIdentity {
  operator_id: string;
  /**
   * Out-of-band authentication with RBAC and MFA, or a signed administrative command
   * (implementation-plan §5 S18). A chat command "may be an interface but never the
   * authority", which is why this field exists and why `chat` is not one of its values.
   */
  authn: 'mfa' | 'hardware_key' | 'signed_command';
}

export interface EmergencyRequest {
  incident_id: string;
  operator: OperatorIdentity;
  scope: ControlScope;
  reason: string;
}

/**
 * The six-step emergency sequence. Ordered, and the order is the safety property: denying
 * new capabilities before cancelling work stops the cancelled work from grabbing more on the
 * way out. S18's exit criterion is that it "completes in order", so the order is data.
 */
export const EMERGENCY_SEQUENCE = [
  'pause_agent',
  'deny_new_work',
  'deny_new_capabilities',
  'cancel_workflows',
  'revoke_tokens',
  'quarantine_workers',
] as const;
export type EmergencyStep = (typeof EMERGENCY_SEQUENCE)[number];

export interface EmergencyOutcome {
  incident_id: string;
  /** One entry per step, in {@link EMERGENCY_SEQUENCE} order, including steps that failed. */
  steps: { step: EmergencyStep; report: ContainmentReport }[];
  /** Verified, not requested. False whenever any service could not confirm containment. */
  contained: boolean;
  /** Wall-clock for the deny propagation; the p95 < 10 s target measures this. */
  deny_propagation_ms: number;
}

export interface OperatorClient extends ServiceClient {
  pauseAgent(request: EmergencyRequest): Promise<ContainmentReport>;
  denyNewWork(request: EmergencyRequest): Promise<ContainmentReport>;
  cancelWorkflow(request: EmergencyRequest & { workflow_id: string }): Promise<ContainmentReport>;
  revokeTokens(request: EmergencyRequest): Promise<ContainmentReport>;
  quarantineWorker(request: EmergencyRequest & { workspace_id: string }): Promise<ContainmentReport>;
  /** Runs the whole sequence, in order, and reports what it could and could not verify. */
  emergencyStop(request: EmergencyRequest): Promise<EmergencyOutcome>;
  /** Re-reads the world. Not a replay of what was requested — a check of what is true. */
  containmentReport(incidentId: string): Promise<ContainmentReport>;
  lift(incidentId: string, operator: OperatorIdentity): Promise<void>;
}

// ------------------------------------------------------------------------ S19 Evaluation

export interface EvalCaseResult {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string | null;
}

export interface EvalReport {
  suite: string;
  results: EvalCaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** Version pins, so a cost or latency regression is attributable. */
  pinned: Record<string, string>;
}

export interface RegressionVerdict {
  metric: string;
  baseline: number;
  observed: number;
  regressed: boolean;
  /** A safety regression fails the build; a cost regression reports (S19 exit criterion). */
  severity: 'safety' | 'quality' | 'cost' | 'latency';
}

export interface EvaluationClient extends ServiceClient {
  runSuite(name: string): Promise<EvalReport>;
  /** Direct, indirect, encoded and multimodal injection, plus canary exfiltration. */
  runAdversarialCorpus(): Promise<EvalReport>;
  regressionCheck(baseline: string): Promise<RegressionVerdict[]>;
}

// ----------------------------------------------------------------------- S20 Integration

export interface ScenarioStepResult {
  step: number;
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string | null;
}

export interface ScenarioResult {
  scenario: string;
  steps: ScenarioStepResult[];
  passed: boolean;
  /**
   * Which peers were faked during the run. The Stage-1 acceptance requires this to be empty:
   * "passes end to end with no fakes in the path".
   */
  faked_peers: string[];
}

export interface IntegrationHarness extends ServiceClient {
  runScenario(name: string): Promise<ScenarioResult>;
  listScenarios(): Promise<string[]>;
}
