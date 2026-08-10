import { generateKeyPairSync } from 'node:crypto';
import type { Clock, IdFactory } from '@otondev/contracts';
import { createFakeRegistry } from '@otondev/sdk';
import type { AuditClient } from '@otondev/sdk';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import { signBundle } from '../src/bundle.js';
import type { PolicyBundleBody, SignedPolicyBundle } from '../src/bundle.js';
import { PolicyService } from '../src/service.js';

export const TENANT = 'ten_00000000000000000000000001';
export const AGENT = 'agt_00000000000000000000000002';
export const WORKLOAD = 'wl_000000000000000000000003';
export const KEY_ID = 'policy-signing-2026a';

export const SHA_A = `sha256:${'ab'.repeat(32)}`;
export const SHA_B = `sha256:${'cd'.repeat(32)}`;

/** A bundle wide enough to exercise every branch and narrow enough to reason about. */
export function testBundleBody(overrides: Partial<PolicyBundleBody> = {}): PolicyBundleBody {
  return {
    name: 'engineering-pilot',
    version: 2,
    tenant_id: TENANT,
    known_resources: ['repo:team/api', 'repo:team/*', 'ticket:jira:ENG-42', 'service:api'],
    ceilings: {
      agents: { [AGENT]: 'A3', '*': 'A1' },
      resources: { 'repo:team/api': 'A3', 'ticket:jira:ENG-42': 'A3', 'service:api': 'A3', '*': 'A2' },
      environments: { dev: 'A4', nonprod: 'A3', staging: 'A2', prod: 'A1' },
      data_classes: {
        public: 'A4',
        internal: 'A3',
        internal_source: 'A3',
        customer: 'A2',
        confidential: 'A1',
        restricted: 'A0',
        secret: 'A0',
      },
      action_classes: {
        'jira.comment': 'A3',
        'git.open_draft_pr': 'A3',
        'git.push': 'A3',
        'staging.deploy': 'A3',
        'worker.command': 'A3',
        'worker.file_write': 'A3',
        'git.create_branch': 'A3',
        'git.commit': 'A3',
        'git.open_pr': 'A3',
        'jira.transition': 'A3',
        'slack.post': 'A3',
        'cognition.generate': 'A4',
        'memory.write': 'A3',
        'presence.speak': 'A2',
      },
      incident_mode: 'A1',
    },
    rules: [
      {
        action: 'jira.comment',
        min_autonomy: 'A2',
        environments: ['dev', 'nonprod', 'staging', 'prod'],
        max_data_class: 'internal_source',
        risk: 'low',
        always_requires_approval: false,
        minimum_authn_strength: 'mfa',
        cost: { approval_above_usd: 1, deny_above_usd: 10 },
        constraints: { max_uses: 1 },
      },
      {
        action: 'git.open_draft_pr',
        min_autonomy: 'A2',
        environments: ['dev', 'nonprod'],
        max_data_class: 'internal_source',
        risk: 'medium',
        always_requires_approval: false,
        minimum_authn_strength: 'mfa',
        cost: { approval_above_usd: 2, deny_above_usd: 20 },
        constraints: { branch_prefix: 'agent/', max_uses: 1 },
      },
      {
        action: 'staging.deploy',
        min_autonomy: 'A3',
        environments: ['staging'],
        max_data_class: 'internal_source',
        risk: 'high',
        always_requires_approval: true,
        minimum_authn_strength: 'mfa',
        cost: { approval_above_usd: 0, deny_above_usd: 100 },
        constraints: { max_uses: 1 },
      },
      {
        action: 'git.push',
        min_autonomy: 'A4',
        environments: ['dev'],
        max_data_class: 'internal',
        risk: 'high',
        always_requires_approval: false,
        minimum_authn_strength: 'hardware_key',
        cost: { approval_above_usd: 5, deny_above_usd: 50 },
        constraints: {},
      },
    ],
    ...overrides,
  };
}

export interface Harness {
  service: PolicyService;
  clock: FakeClock;
  ids: IdFactory;
  audit: AuditClient;
  signed: SignedPolicyBundle;
  trustedKeys: Map<string, string>;
  publicKeyPem: string;
  privateKeyPem: string;
}

export function keypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function buildHarness(
  options: { body?: PolicyBundleBody; clock?: FakeClock; ids?: IdFactory } = {},
): Harness {
  const clock = options.clock ?? new FakeClock('2026-07-30T08:00:00.000Z');
  const ids = options.ids ?? deterministicIdFactory({ clock });
  const { publicKeyPem, privateKeyPem } = keypair();
  const body = options.body ?? testBundleBody();
  const signed = signBundle(body, privateKeyPem, KEY_ID);
  const trustedKeys = new Map([[KEY_ID, publicKeyPem]]);
  const audit = createFakeRegistry({ clock, ids }).services.audit;

  const service = new PolicyService({
    tenantId: TENANT,
    clock: clock as Clock,
    ids,
    bundle: signed,
    trustedKeys,
    audit,
  });

  return { service, clock, ids, audit, signed, trustedKeys, publicKeyPem, privateKeyPem };
}

/** A query that is allowed by the test bundle, so a test can vary one field at a time. */
export function baseQuery(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    agent_id: AGENT,
    workload_id: WORKLOAD,
    workflow_id: 'wf_00000000000000000000000004',
    plan_id: 'plan_0000000000000000000005',
    action: 'jira.comment' as const,
    resource: 'ticket:jira:ENG-42',
    environment: 'nonprod' as const,
    parameter_digest: SHA_A,
    data_classes: ['internal_source' as const],
    ...overrides,
  };
}
