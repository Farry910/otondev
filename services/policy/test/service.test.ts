import { describe, expect, it } from 'vitest';
import { isContractError } from '@otondev/contracts';
import type { ApprovalBinding } from '@otondev/sdk';
import { baseQuery, buildHarness, keypair, testBundleBody, SHA_A, SHA_B, TENANT } from './helpers.js';

const deployBinding: ApprovalBinding = {
  action: 'staging.deploy',
  resource: 'service:api',
  environment: 'staging',
  parameter_digest: SHA_A,
  plan_digest: SHA_A,
};

const approver = { human_id: 'usr_00000000000000000000000001', authn_strength: 'mfa' as const };

describe('the service refuses to start on a bundle it cannot verify', () => {
  it('throws at construction rather than on the first decision', async () => {
    const { privateKeyPem } = keypair();
    const stranger = keypair();
    const { signBundle } = await import('../src/bundle.js');
    const signed = signBundle(testBundleBody(), privateKeyPem, 'some-key');
    const { PolicyService } = await import('../src/service.js');
    const { FakeClock, deterministicIdFactory } = await import('@otondev/testkit');
    const { createFakeRegistry } = await import('@otondev/sdk');
    const clock = new FakeClock('2026-07-30T08:00:00.000Z');

    expect(
      () =>
        new PolicyService({
          tenantId: TENANT,
          clock,
          ids: deterministicIdFactory({ clock }),
          bundle: signed,
          trustedKeys: new Map([['some-key', stranger.publicKeyPem]]),
          audit: createFakeRegistry({ clock }).services.audit,
        }),
    ).toThrow(/bad_signature/);
  });
});

describe('decisions are reproducible from their logged inputs and the bundle hash', () => {
  it('produces the same decision, bundle ref and reasons for the same query', async () => {
    const a = buildHarness();
    const b = buildHarness();
    const first = await a.service.evaluate(baseQuery());
    const second = await b.service.evaluate(baseQuery());

    // Everything except the minted id, which is deliberately unique per record.
    const comparable = ({ id: _id, ...rest }: Record<string, unknown>) => rest;
    expect(comparable(second)).toEqual(comparable(first));
  });

  it('records the exact bundle reference on every decision', async () => {
    const { service } = buildHarness();
    const decision = await service.evaluate(baseQuery());
    expect(decision.policy_bundle).toBe(await service.bundleRef());
    expect(decision.policy_bundle).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('always carries at least one reason code', async () => {
    const { service } = buildHarness();
    for (const query of [baseQuery(), baseQuery({ action: 'presence.speak' }), baseQuery({ environment: 'prod' })]) {
      const decision = await service.evaluate(query);
      expect(decision.reason_codes.length).toBeGreaterThan(0);
      for (const code of decision.reason_codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('writes a security-severity audit record for every decision', async () => {
    const { service, audit } = buildHarness();
    await service.evaluate(baseQuery());
    const records = await audit.query({ partition: `${TENANT}:policy` });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ severity: 'security', event: 'policy.decision.recorded' });
  });
});

describe('chat text, emoji, ticket labels and model output never produce an approval', () => {
  for (const weak of ['none', 'password', 'sso'] as const) {
    it(`refuses to mint an approval from a ${weak}-authenticated approver`, async () => {
      const { service } = buildHarness();
      await expect(
        service.createApproval({
          decision_request_id: 'drq_00000000000000000000000001',
          approver: { human_id: 'usr_00000000000000000000000001', authn_strength: weak },
          binding: deployBinding,
          expires_at: '2030-01-01T00:00:00Z',
          max_uses: 1,
        }),
      ).rejects.toThrow();
    });
  }

  it('has no path that turns prose into an approval', () => {
    // The structural argument, asserted so it stays true: the service exposes no method that
    // takes free text, and `createApproval` demands a complete binding plus an authenticated
    // approver. An adapter wanting to approve from a thumbs-up must fabricate all of it in
    // reviewable code.
    const { service } = buildHarness();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
    for (const forbidden of ['approveFromText', 'parseApproval', 'approveFromChat', 'interpret']) {
      expect(surface).not.toContain(forbidden);
    }
    expect(service.createApproval).toHaveLength(1);
  });

  it('refuses an approval that is already expired when created', async () => {
    const { service } = buildHarness();
    await expect(
      service.createApproval({
        decision_request_id: 'drq_00000000000000000000000001',
        approver,
        binding: deployBinding,
        expires_at: '2020-01-01T00:00:00Z',
        max_uses: 1,
      }),
    ).rejects.toThrow();
  });
});

describe('approval lifecycle through the service', () => {
  const create = async (harness: ReturnType<typeof buildHarness>, maxUses = 1) =>
    harness.service.createApproval({
      decision_request_id: 'drq_00000000000000000000000001',
      approver,
      binding: deployBinding,
      expires_at: '2026-07-30T09:00:00Z',
      max_uses: maxUses,
    });

  it('mints, then consumes exactly once', async () => {
    const harness = buildHarness();
    const approval = await create(harness);
    const used = await harness.service.consumeApproval(approval.id, deployBinding);
    expect(used).toMatchObject({ uses: 1, status: 'consumed' });
    await expect(harness.service.consumeApproval(approval.id, deployBinding)).rejects.toThrow(
      /APPROVAL_CONSUMED/,
    );
  });

  it('lets exactly one of two concurrent claimants win a single-use approval', async () => {
    const harness = buildHarness();
    const approval = await create(harness);
    const results = await Promise.allSettled([
      harness.service.consumeApproval(approval.id, deployBinding),
      harness.service.consumeApproval(approval.id, deployBinding),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses a consumption whose binding differs', async () => {
    const harness = buildHarness();
    const approval = await create(harness);
    await expect(
      harness.service.consumeApproval(approval.id, { ...deployBinding, parameter_digest: SHA_B }),
    ).rejects.toThrow(/APPROVAL_BINDING_MISMATCH/);
  });

  it('refuses after expiry, using the injected clock', async () => {
    const harness = buildHarness();
    const approval = await create(harness);
    harness.clock.advance(61 * 60 * 1000);
    await expect(harness.service.consumeApproval(approval.id, deployBinding)).rejects.toThrow(
      /APPROVAL_EXPIRED/,
    );
  });

  it('surfaces failures as ContractErrors with stable codes', async () => {
    const harness = buildHarness();
    await harness.service.consumeApproval('apr_00000000000000000000000099', deployBinding).then(
      () => expect.unreachable('should have failed'),
      (error: unknown) => {
        expect(isContractError(error)).toBe(true);
        if (isContractError(error)) expect(error.code).toBe('APPROVAL_BINDING_MISMATCH');
      },
    );
  });

  it('does not leak another tenant’s approval', async () => {
    const harness = buildHarness();
    const approval = await create(harness);
    // A second service for a different tenant must not see it, even given the exact id.
    const other = buildHarness({ body: testBundleBody({ tenant_id: 'ten_00000000000000000000000099' }) });
    expect(await other.service.getApproval(approval.id)).toBeNull();
  });

  it('an approval turns a require_approval into an allow, once', async () => {
    const harness = buildHarness();
    const query = baseQuery({ action: 'staging.deploy', resource: 'service:api', environment: 'staging' });
    expect((await harness.service.evaluate(query)).decision).toBe('require_approval');

    const approval = await create(harness);
    const allowed = await harness.service.evaluate({ ...query, approval_id: approval.id });
    expect(allowed.decision).toBe('allow');
    expect(allowed.reason_codes).toContain('APPROVAL_PRESENT');
  });

  it('an approval for different parameters does not authorise the action', async () => {
    const harness = buildHarness();
    const approval = await create(harness);
    const query = baseQuery({
      action: 'staging.deploy',
      resource: 'service:api',
      environment: 'staging',
      parameter_digest: SHA_B,
      approval_id: approval.id,
    });
    const decision = await harness.service.evaluate(query);
    expect(decision.decision).toBe('require_approval');
    expect(decision.reason_codes).toContain('APPROVAL_BINDING_MISMATCH');
  });
});

describe('emergency stop', () => {
  it('a denied policy service stops issuing allows', async () => {
    const harness = buildHarness();
    expect((await harness.service.evaluate(baseQuery())).decision).toBe('allow');

    await harness.service.deny({
      incident_id: 'inc_1',
      scope: { kind: 'global' },
      reason: 'drill',
      requested_by: 'operator',
      requested_at: harness.clock.nowIso(),
    });

    const denied = await harness.service.evaluate(baseQuery());
    expect(denied.decision).toBe('deny');
    expect(denied.autonomy_level).toBe('A0');
    expect((await harness.service.health()).denying).toBe(true);
  });

  it('revoking marks live approvals so none can be replayed afterwards', async () => {
    const harness = buildHarness();
    const approval = await harness.service.createApproval({
      decision_request_id: 'drq_00000000000000000000000001',
      approver,
      binding: deployBinding,
      expires_at: '2026-07-30T09:00:00Z',
      max_uses: 5,
    });

    const ack = await harness.service.revoke({
      incident_id: 'inc_2',
      scope: { kind: 'global' },
      reason: 'drill',
      requested_by: 'operator',
      requested_at: harness.clock.nowIso(),
      revocation_epoch: 1,
    });
    expect(ack.contained).toContain(approval.id);

    await expect(harness.service.consumeApproval(approval.id, deployBinding)).rejects.toThrow();
  });

  it('reports quarantine as not applicable rather than claiming containment', async () => {
    const harness = buildHarness();
    const ack = await harness.service.quarantine({
      incident_id: 'inc_3',
      scope: { kind: 'global' },
      reason: 'drill',
      requested_by: 'operator',
      requested_at: harness.clock.nowIso(),
    });
    expect(ack.outcome).toBe('not_applicable');
  });
});

describe('resilience', () => {
  it('a decision still stands when the audit peer fails', async () => {
    const harness = buildHarness();
    const broken = {
      ...harness.audit,
      append: async () => {
        throw new Error('audit is down');
      },
    };
    const { PolicyService } = await import('../src/service.js');
    const service = new PolicyService({
      tenantId: TENANT,
      clock: harness.clock,
      ids: harness.ids,
      bundle: harness.signed,
      trustedKeys: harness.trustedKeys,
      audit: broken as unknown as typeof harness.audit,
    });
    // Refusing to decide because the record of the decision could not be written would turn
    // an audit outage into a policy outage.
    await expect(service.evaluate(baseQuery())).resolves.toMatchObject({ decision: 'allow' });
  });
});
