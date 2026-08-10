import { describe, expect, it } from 'vitest';
import { APPROVAL_BOUND_FIELDS } from '@otondev/contracts';
import type { Approval } from '@otondev/contracts';
import type { ApprovalBinding } from '@otondev/sdk';
import { checkBinding, checkConsumable, consumed, meetsAuthnStrength } from '../src/approvals.js';
import { SHA_A, SHA_B, TENANT } from './helpers.js';

const NOW = '2026-07-30T08:00:00Z';

const binding: ApprovalBinding = {
  action: 'staging.deploy',
  resource: 'service:api',
  environment: 'staging',
  parameter_digest: SHA_A,
  plan_digest: SHA_A,
};

function approvalFor(overrides: Partial<Approval> = {}): Approval {
  return {
    schema: 'agentdev.approval.v2',
    id: 'apr_00000000000000000000000001',
    tenant_id: TENANT,
    correlation_id: 'cor_00000000000000000000000001',
    created_at: NOW,
    producer: { service: 'policy', instance: 'policy-1', version: '0.0.0' },
    data_classes: ['internal'],
    integrity: { alg: 'sha256', digest: '0'.repeat(64) },
    approver: { human_id: 'usr_00000000000000000000000001', authn_strength: 'mfa' },
    decision_request_id: 'drq_00000000000000000000000001',
    action: binding.action,
    resource: binding.resource,
    environment: binding.environment,
    parameter_digest: binding.parameter_digest,
    plan_digest: binding.plan_digest,
    expires_at: '2026-07-30T09:00:00Z',
    max_uses: 1,
    uses: 0,
    status: 'active',
    signature: { alg: 'ed25519', key_id: 'k', value: 'sig' },
    ...overrides,
  };
}

describe('editing ANY bound field invalidates the approval', () => {
  /**
   * Driven from the contract's own list rather than a hand-written set of cases. If a field
   * is added to `APPROVAL_BOUND_FIELDS` and nobody updates the check, this test fails — which
   * is the only way the criterion stays true as the contract grows.
   */
  const mutations: Record<(typeof APPROVAL_BOUND_FIELDS)[number], ApprovalBinding> = {
    action: { ...binding, action: 'git.push' },
    resource: { ...binding, resource: 'service:other' },
    environment: { ...binding, environment: 'prod' },
    parameter_digest: { ...binding, parameter_digest: SHA_B },
    plan_digest: { ...binding, plan_digest: SHA_B },
  };

  it('covers every field the contract declares bound', () => {
    expect(Object.keys(mutations).sort()).toEqual([...APPROVAL_BOUND_FIELDS].sort());
  });

  for (const field of APPROVAL_BOUND_FIELDS) {
    it(`rejects a changed ${field}`, () => {
      const result = checkBinding(approvalFor(), mutations[field]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('APPROVAL_BINDING_MISMATCH');
        expect(result.field).toBe(field);
      }
    });
  }

  it('accepts the exact binding it was created for', () => {
    expect(checkBinding(approvalFor(), binding).ok).toBe(true);
  });
});

describe('a consumed or expired approval cannot be replayed', () => {
  it('refuses one already used to its limit', () => {
    const result = checkConsumable({ approval: approvalFor({ uses: 1, max_uses: 1 }), binding, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('APPROVAL_CONSUMED');
  });

  it('refuses one marked consumed even if the counter says otherwise', () => {
    const result = checkConsumable({ approval: approvalFor({ status: 'consumed' }), binding, now: NOW });
    expect(result.ok).toBe(false);
  });

  it('refuses one past its expiry', () => {
    const result = checkConsumable({ approval: approvalFor(), binding, now: '2026-07-30T09:00:01Z' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('APPROVAL_EXPIRED');
  });

  it('treats the expiry instant itself as expired', () => {
    const result = checkConsumable({ approval: approvalFor(), binding, now: '2026-07-30T09:00:00Z' });
    expect(result.ok).toBe(false);
  });

  it('compares expiry as an instant, not as a string', () => {
    // '…09:00:00Z' and '…09:00:00.000Z' are the same moment; a string compare disagrees.
    const result = checkConsumable({
      approval: approvalFor({ expires_at: '2026-07-30T09:00:00.000Z' }),
      binding,
      now: '2026-07-30T08:59:59Z',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a revoked approval', () => {
    const result = checkConsumable({ approval: approvalFor({ status: 'revoked' }), binding, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('APPROVAL_REVOKED');
  });

  it('reports a binding mismatch ahead of expiry when both are true', () => {
    // The more specific answer is the more useful one for whoever is debugging.
    const result = checkConsumable({
      approval: approvalFor(),
      binding: { ...binding, resource: 'service:other' },
      now: '2026-07-30T10:00:00Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('APPROVAL_BINDING_MISMATCH');
  });
});

describe('multi-use approvals', () => {
  it('stay active until the last use', () => {
    const first = consumed(approvalFor({ max_uses: 3, uses: 0 }));
    expect(first).toMatchObject({ uses: 1, status: 'active' });
    const last = consumed(approvalFor({ max_uses: 3, uses: 2 }));
    expect(last).toMatchObject({ uses: 3, status: 'consumed' });
  });

  it('do not mutate the record they were given', () => {
    const original = approvalFor();
    consumed(original);
    expect(original.uses).toBe(0);
  });
});

describe('approver authentication strength', () => {
  it('ranks the ladder correctly', () => {
    expect(meetsAuthnStrength('mfa', 'mfa')).toBe(true);
    expect(meetsAuthnStrength('hardware_key', 'mfa')).toBe(true);
    expect(meetsAuthnStrength('sso', 'mfa')).toBe(false);
    expect(meetsAuthnStrength('password', 'mfa')).toBe(false);
    expect(meetsAuthnStrength('none', 'mfa')).toBe(false);
  });

  it('does not let mfa satisfy a hardware-key requirement', () => {
    expect(meetsAuthnStrength('mfa', 'hardware_key')).toBe(false);
  });

  it('accepts a signed administrative command where mfa is required', () => {
    expect(meetsAuthnStrength('signed_command', 'mfa')).toBe(true);
  });

  it('refuses an unknown strength rather than admitting it', () => {
    expect(meetsAuthnStrength('carrier-pigeon', 'mfa')).toBe(false);
  });

  it('refuses an approval whose approver is too weak for the action rule', () => {
    const result = checkConsumable({
      approval: approvalFor({ approver: { human_id: 'usr_00000000000000000000000001', authn_strength: 'mfa' } }),
      binding,
      now: NOW,
      requiredAuthnStrength: 'hardware_key',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('APPROVAL_AUTHN_TOO_WEAK');
  });
});
