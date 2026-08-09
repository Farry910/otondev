import { ID_PREFIX, ulid } from './ids.js';
import type { IdKind } from './ids.js';
import type { IngressEvent } from './event.js';
import type { WorkflowRecord, WorkflowTransition } from './workflow.js';
import type { ExecutionCommand, Plan } from './plan.js';
import type { Approval, DecisionRequest, PolicyDecision } from './policy.js';
import type { Capability } from './capability.js';
import type { ExternalAction } from './action.js';
import type { CognitionRequest, CognitionResult } from './cognition.js';
import type { MemoryRecord } from './memory.js';
import type { EvidenceBundle } from './evidence.js';
import type { AuditRecord } from './audit.js';
import type { ErrorContract } from './errors.js';
import type { RegisteredSchemaId } from './registry.js';

/**
 * One valid example of every registered schema.
 *
 * Two jobs, both of which pay for the verbosity:
 *
 *   1. A schema nobody can satisfy is a normal and expensive kind of bug — two `.min(1)`
 *      constraints that cannot both hold, a `.refine` that rejects everything. The contract
 *      test parses each example under its own schema, so an unsatisfiable schema fails in
 *      Wave 0 rather than in the Wave-1 session that first tries to construct the record.
 *
 *   2. Every S1-S20 session needs a known-good record to build a test around, and the
 *      alternative is fifteen sessions each inventing one, each subtly wrong.
 *
 * The values are drawn from the illustrative YAML in contracts-and-data.md so a reader can
 * hold the document and the code side by side.
 */

const EXAMPLE_TIME_MS = Date.parse('2026-07-30T08:00:03.000Z');

let counter = 0;
function exampleId(kind: IdKind): string {
  counter += 1;
  const randomness = new Uint8Array(10);
  randomness[8] = (counter >> 8) & 0xff;
  randomness[9] = counter & 0xff;
  return ID_PREFIX[kind] + ulid(EXAMPLE_TIME_MS, randomness);
}

const hex = (seed: string, length: number): string =>
  seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

const DIGEST_HEX = hex('a1b2c3d4e5f60718', 64);
const SHA256 = `sha256:${DIGEST_HEX}` as const;
const GIT_SHA = hex('9f8e7d6c5b4a3021', 40);

export const EXAMPLE_IDS = {
  tenant: exampleId('tenant'),
  agent: exampleId('agent'),
  user: exampleId('user'),
  workflow: exampleId('workflow'),
  event: exampleId('event'),
  correlation: exampleId('correlation'),
  plan: exampleId('plan'),
  policyDecision: exampleId('policyDecision'),
  approval: exampleId('approval'),
  decisionRequest: exampleId('decisionRequest'),
  capability: exampleId('capability'),
  action: exampleId('action'),
  memory: exampleId('memory'),
  evidence: exampleId('evidence'),
  artifact: exampleId('artifact'),
  checkpoint: exampleId('checkpoint'),
  cognitionRequest: exampleId('cognitionRequest'),
  context: exampleId('context'),
  workspace: exampleId('workspace'),
  workload: exampleId('workload'),
} as const;

const envelope = {
  tenant_id: EXAMPLE_IDS.tenant,
  agent_id: EXAMPLE_IDS.agent,
  workflow_id: EXAMPLE_IDS.workflow,
  correlation_id: EXAMPLE_IDS.correlation,
  created_at: '2026-07-30T08:00:03Z',
  producer: { service: 'ingress', instance: 'ingress-7', version: '0.1.0' },
  data_classes: ['internal_source' as const],
  integrity: { alg: 'sha256' as const, digest: DIGEST_HEX },
  trace: { trace_id: hex('4bf92f3577b34da6', 32), span_id: hex('00f067aa0ba902b7', 16) },
};

export const EXAMPLE_EVENT: IngressEvent = {
  ...envelope,
  schema: 'agentdev.event.v2',
  id: EXAMPLE_IDS.event,
  source: {
    system: 'jira',
    installation_id: 'jira_acme',
    event_id: 'vendor_event_123',
    occurred_at: '2026-07-30T08:00:02Z',
    authenticated_principal: 'jira_cloud_app',
  },
  kind: 'ticket.created',
  subject: { type: 'ticket', id: 'ENG-42', version: '10419' },
  payload_ref: EXAMPLE_IDS.artifact,
  untrusted_fields: ['description', 'comments'],
  dedupe_key: `${EXAMPLE_IDS.tenant}:jira:jira_acme:vendor_event_123`,
  received_at: '2026-07-30T08:00:03Z',
};

export const EXAMPLE_WORKFLOW: WorkflowRecord = {
  ...envelope,
  schema: 'agentdev.workflow.v2',
  id: EXAMPLE_IDS.workflow,
  producer: { service: 'workflow', instance: 'workflow-1', version: '0.1.0' },
  type: 'ticket_delivery',
  state: 'EXECUTING',
  state_version: 17,
  goal_ref: EXAMPLE_IDS.artifact,
  source_refs: [EXAMPLE_IDS.event, 'ticket:jira:ENG-42@10419'],
  definition_of_done_ref: 'dod_repo_api_v3',
  risk: 'medium',
  data_classes: ['internal_source'],
  autonomy_required: 'A2',
  priority: 50,
  budget: { usd_max: 5, deadline: '2026-07-30T10:00:00Z', cpu_seconds: 7200 },
  lease: {
    owner: EXAMPLE_IDS.workload,
    expires_at: '2026-07-30T08:30:00Z',
    fencing_token: 22,
  },
  locks: ['ticket:jira:ENG-42', 'repo:api:branch:agent/ENG-42'],
  attempt: 2,
  next_wakeup_at: null,
  last_checkpoint_ref: EXAMPLE_IDS.checkpoint,
};

export const EXAMPLE_TRANSITION: WorkflowTransition = {
  ...envelope,
  schema: 'agentdev.transition.v2',
  id: exampleId('audit'),
  producer: { service: 'workflow', instance: 'workflow-1', version: '0.1.0' },
  from_state: 'LEASED',
  to_state: 'EXECUTING',
  state_version: 17,
  channel: 'normal',
  accepted: true,
  reason_codes: ['LEASE_HELD'],
  fencing_token: 22,
  occurred_at: '2026-07-30T08:00:03Z',
};

export const EXAMPLE_PLAN: Plan = {
  ...envelope,
  schema: 'agentdev.plan.v2',
  id: EXAMPLE_IDS.plan,
  producer: { service: 'core', instance: 'core-1', version: '0.1.0' },
  goal_digest: SHA256,
  assumptions: ['the failing test reproduces on the pinned worker image'],
  unknowns: ['whether the flake is timezone dependent'],
  expected_files: ['src/auth.py', 'tests/test_auth.py'],
  expected_external_effects: ['git.create_branch', 'git.open_draft_pr', 'jira.comment'],
  steps: [
    {
      step_id: 's1',
      purpose: 'reproduce',
      action_class: 'worker.command',
      risk: 'low',
      success_condition: 'failing_test_captured',
    },
  ],
  definition_of_done_ref: 'dod_repo_api_v3',
  rollback_or_compensation: {
    before_publish: 'destroy_workspace',
    after_publish: 'close_draft_pr',
  },
  limits: { files_changed: 12, commands: 40, wall_seconds: 7200 },
};

export const EXAMPLE_EXECUTION_COMMAND: ExecutionCommand = {
  ...envelope,
  schema: 'agentdev.execution_command.v2',
  id: exampleId('checkpoint'),
  producer: { service: 'core', instance: 'core-1', version: '0.1.0' },
  plan_id: EXAMPLE_IDS.plan,
  step_id: 's1',
  fencing_token: 22,
  policy_decision_id: EXAMPLE_IDS.policyDecision,
  capability_ids: [EXAMPLE_IDS.capability],
  workspace_id: EXAMPLE_IDS.workspace,
  base_sha: GIT_SHA,
  plan_digest: SHA256,
  repository: 'repo:team/api',
  timeout_at: '2026-07-30T10:00:00Z',
  limits: { cpu_seconds: 3600, memory_mb: 4096, disk_mb: 20480, wall_seconds: 7200, usd_max: 5 },
  cancellation_token: 'cxl_7f3a',
  response_schema: 'StepResultV2',
};

export const EXAMPLE_POLICY_DECISION: PolicyDecision = {
  ...envelope,
  schema: 'agentdev.policy_decision.v2',
  id: EXAMPLE_IDS.policyDecision,
  producer: { service: 'policy', instance: 'policy-1', version: '0.1.0' },
  subject: { agent_id: EXAMPLE_IDS.agent, workload_id: EXAMPLE_IDS.workload },
  action: 'git.open_draft_pr',
  resource: 'repo:team/api',
  environment: 'nonprod',
  parameter_digest: SHA256,
  plan_id: EXAMPLE_IDS.plan,
  autonomy_level: 'A2',
  data_classes: ['internal_source'],
  decision: 'allow',
  policy_bundle: `engineering-pilot-v2@sha256:${DIGEST_HEX}`,
  constraints: { branch_prefix: 'agent/', max_uses: 1 },
  expires_at: '2026-07-30T09:00:00Z',
  reason_codes: ['A2_ALLOWED_REPO', 'DRAFT_ONLY'],
};

export const EXAMPLE_DECISION_REQUEST: DecisionRequest = {
  ...envelope,
  schema: 'agentdev.decision_request.v2',
  id: EXAMPLE_IDS.decisionRequest,
  producer: { service: 'core', instance: 'core-1', version: '0.1.0' },
  plan_id: EXAMPLE_IDS.plan,
  action: 'staging.deploy',
  resource: 'service:api',
  environment: 'staging',
  parameter_digest: SHA256,
  plan_digest: SHA256,
  summary: 'Deploy the ENG-42 fix to staging so the integration suite can run against it.',
  blast_radius: 'Staging API only. No customer traffic. Rollback is a redeploy of the prior tag.',
  requested_autonomy: 'A3',
  data_classes: ['internal_source'],
  expires_at: '2026-07-30T09:00:00Z',
  minimum_authn_strength: 'mfa',
};

export const EXAMPLE_APPROVAL: Approval = {
  ...envelope,
  schema: 'agentdev.approval.v2',
  id: EXAMPLE_IDS.approval,
  producer: { service: 'policy', instance: 'policy-1', version: '0.1.0' },
  approver: { human_id: EXAMPLE_IDS.user, authn_strength: 'mfa' },
  decision_request_id: EXAMPLE_IDS.decisionRequest,
  action: 'staging.deploy',
  resource: 'service:api',
  environment: 'staging',
  parameter_digest: SHA256,
  plan_digest: SHA256,
  expires_at: '2026-07-30T09:00:00Z',
  max_uses: 1,
  uses: 0,
  status: 'active',
  signature: { alg: 'ed25519', key_id: 'approval-signing-2026a', value: 'c2lnbmF0dXJl' },
};

export const EXAMPLE_CAPABILITY: Capability = {
  ...envelope,
  schema: 'agentdev.capability.v2',
  id: EXAMPLE_IDS.capability,
  producer: { service: 'broker', instance: 'broker-1', version: '0.1.0' },
  subject: { workload_id: EXAMPLE_IDS.workload, agent_id: EXAMPLE_IDS.agent },
  action_id: EXAMPLE_IDS.action,
  operation: 'jira.comment',
  resource: 'ticket:jira:ENG-42',
  constraints: { parameter_digest: SHA256, max_uses: 1 },
  lease_fencing_token: 22,
  issued_at: '2026-07-30T08:00:03Z',
  expires_at: '2026-07-30T08:15:03Z',
  revocation_epoch: 54,
  broker_signature: { alg: 'ed25519', key_id: 'broker-2026a', value: 'YnJva2Vy' },
};

export const EXAMPLE_ACTION: ExternalAction = {
  ...envelope,
  schema: 'agentdev.action.v2',
  id: EXAMPLE_IDS.action,
  producer: { service: 'connectors', instance: 'connectors-1', version: '0.1.0' },
  adapter: 'github',
  operation: 'pull_request.create_draft',
  action_class: 'git.open_draft_pr',
  resource: 'repo:team/api',
  parameter_digest: SHA256,
  idempotency_key: `${EXAMPLE_IDS.tenant}:${EXAMPLE_IDS.action}`,
  state: 'prepared',
  attempts: 0,
  policy_decision_id: EXAMPLE_IDS.policyDecision,
  approval_id: null,
  capability_id: EXAMPLE_IDS.capability,
  remote_ref: null,
  last_error: null,
  updated_at: '2026-07-30T08:00:03Z',
};

export const EXAMPLE_COGNITION_REQUEST: CognitionRequest = {
  ...envelope,
  schema: 'agentdev.cognition_request.v2',
  id: EXAMPLE_IDS.cognitionRequest,
  producer: { service: 'cognition', instance: 'cognition-1', version: '0.1.0' },
  purpose: 'plan',
  risk: 'medium',
  data_classes: ['internal_source'],
  untrusted_sources: ['jira_description', 'repo_files'],
  required_capabilities: ['tool_reasoning', 'python'],
  quality_tier: 'standard',
  latency_budget_ms: 12000,
  cost_budget_usd: 0.4,
  context_refs: [EXAMPLE_IDS.context],
  response_schema: 'PlanV2',
  provider_constraints: { regions: ['eu'], retention: 'disabled' },
};

export const EXAMPLE_COGNITION_RESULT: CognitionResult = {
  ...envelope,
  schema: 'agentdev.cognition_result.v2',
  id: exampleId('cognitionRequest'),
  producer: { service: 'cognition', instance: 'cognition-1', version: '0.1.0' },
  request_id: EXAMPLE_IDS.cognitionRequest,
  provider: 'local',
  model: 'reference-slm',
  model_version: '2026.07',
  prompt_template: { version: 'plan-v4', digest: SHA256 },
  authorized_context_digest: SHA256,
  content: { steps: [{ step_id: 's1', purpose: 'reproduce' }] },
  schema_verdict: 'valid',
  usage: { input_tokens: 1840, output_tokens: 260, cost_usd: 0.012, latency_ms: 2310 },
  uncertainty: 0.22,
  citations: ['run:ci:991'],
  completion_reason: 'stop',
  completed_at: '2026-07-30T08:00:06Z',
};

export const EXAMPLE_MEMORY: MemoryRecord = {
  ...envelope,
  schema: 'agentdev.memory.v2',
  id: EXAMPLE_IDS.memory,
  producer: { service: 'memory', instance: 'memory-1', version: '0.1.0' },
  owner_scope: { type: 'agent', id: EXAMPLE_IDS.agent },
  record_type: 'fact',
  source_or_derived: 'derived',
  claim: 'CI test X is known to flake on Windows image 4',
  scope: { repo: 'team/api', platform: 'windows-image-4' },
  provenance: {
    source_refs: ['run:ci:991', 'review:github:778'],
    derivation: { model: 'reference-slm', template: 'reflection-v3' },
  },
  confidence: 0.78,
  status: 'contested',
  observed_at: '2026-07-29T14:02:00Z',
  valid_from: '2026-07-29T14:02:00Z',
  valid_until: null,
  data_class: 'internal',
  acl: { read: ['team-x'], publish: ['maintainers'] },
  retention: { expires_at: '2027-07-29T14:02:00Z', legal_hold: false },
  supersedes: null,
  integrity: { alg: 'sha256', digest: DIGEST_HEX, version: 4 },
};

export const EXAMPLE_EVIDENCE: EvidenceBundle = {
  ...envelope,
  schema: 'agentdev.evidence.v2',
  id: EXAMPLE_IDS.evidence,
  producer: { service: 'evidence', instance: 'evidence-1', version: '0.1.0' },
  task_source: 'ticket:jira:ENG-42@10419',
  repository: {
    url: 'https://github.com/team/api',
    base_sha: GIT_SHA,
    head_sha: hex('1122334455667788', 40),
    diff_digest: SHA256,
  },
  environment: {
    worker_image: `ghcr.io/otondev/worker@sha256:${DIGEST_HEX}`,
    toolchain: ['python-3.12.4', 'pytest-8.3.2'],
  },
  checks: [
    {
      name: 'unit',
      command_digest: SHA256,
      status: 'pass',
      exit_code: 0,
      log_ref: EXAMPLE_IDS.artifact,
      log_digest: SHA256,
      reason: null,
    },
    {
      name: 'integration',
      command_digest: SHA256,
      status: 'skipped',
      exit_code: null,
      log_ref: null,
      log_digest: null,
      reason: 'no staging environment was allocated for this attempt',
    },
  ],
  verifier: {
    version: 'verifier-v3',
    verdict: 'pass',
    limitations: ['integration suite did not run'],
  },
  policy_refs: [EXAMPLE_IDS.policyDecision],
  approval_refs: [],
  action_refs: [EXAMPLE_IDS.action],
  artifacts: [
    {
      ref: EXAMPLE_IDS.artifact,
      kind: 'junit',
      digest: SHA256,
      retention: { expires_at: '2027-07-30T08:00:03Z', legal_hold: false },
    },
  ],
  supersedes: null,
  signature: { alg: 'ed25519', key_id: 'evidence-2026a', value: 'ZXZpZGVuY2U' },
};

export const EXAMPLE_AUDIT: AuditRecord = {
  ...envelope,
  schema: 'agentdev.audit.v2',
  id: exampleId('audit'),
  producer: { service: 'audit', instance: 'audit-1', version: '0.1.0' },
  partition: `${EXAMPLE_IDS.tenant}:policy`,
  sequence: 4201,
  prev_digest: DIGEST_HEX,
  severity: 'security',
  component: 'policy',
  event: 'policy.decision.recorded',
  subject_refs: [EXAMPLE_IDS.policyDecision, 'repo:team/api'],
  attributes: { decision: 'allow', autonomy_level: 'A2' },
  message: 'Draft pull request permitted under engineering-pilot-v2.',
  occurred_at: '2026-07-30T08:00:03Z',
};

export const EXAMPLE_ERROR: ErrorContract = {
  schema: 'agentdev.error.v2',
  code: 'ACTION_OUTCOME_UNKNOWN',
  retryable: false,
  public_message: 'The outcome of the external action is unknown and must be reconciled first.',
  diagnostic_ref: `audit:${EXAMPLE_IDS.tenant}:policy#4201`,
  component: 'connectors',
  recommended_transition: 'RECOVERING',
  occurred_at: '2026-07-30T08:00:09Z',
};

/** Keyed by schema id so a test can iterate the registry and find the matching example. */
export const EXAMPLES: Record<RegisteredSchemaId, unknown> = {
  'agentdev.event.v2': EXAMPLE_EVENT,
  'agentdev.workflow.v2': EXAMPLE_WORKFLOW,
  'agentdev.transition.v2': EXAMPLE_TRANSITION,
  'agentdev.plan.v2': EXAMPLE_PLAN,
  'agentdev.execution_command.v2': EXAMPLE_EXECUTION_COMMAND,
  'agentdev.policy_decision.v2': EXAMPLE_POLICY_DECISION,
  'agentdev.approval.v2': EXAMPLE_APPROVAL,
  'agentdev.decision_request.v2': EXAMPLE_DECISION_REQUEST,
  'agentdev.capability.v2': EXAMPLE_CAPABILITY,
  'agentdev.action.v2': EXAMPLE_ACTION,
  'agentdev.cognition_request.v2': EXAMPLE_COGNITION_REQUEST,
  'agentdev.cognition_result.v2': EXAMPLE_COGNITION_RESULT,
  'agentdev.memory.v2': EXAMPLE_MEMORY,
  'agentdev.evidence.v2': EXAMPLE_EVIDENCE,
  'agentdev.audit.v2': EXAMPLE_AUDIT,
  'agentdev.error.v2': EXAMPLE_ERROR,
};
