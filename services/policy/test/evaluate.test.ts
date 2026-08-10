import { describe, expect, it } from 'vitest';
import { AUTONOMY_LEVELS } from '@otondev/contracts';
import { evaluate } from '../src/evaluate.js';
import { resolveEffectiveAutonomy } from '../src/autonomy.js';
import { baseQuery, testBundleBody, AGENT } from './helpers.js';

const bundle = testBundleBody();
const noApproval = { present: false } as const;

const decide = (overrides: Record<string, unknown> = {}) =>
  evaluate({ bundle, query: baseQuery(overrides), approval: noApproval });

describe('effective autonomy is the minimum across every dimension', () => {
  it('takes the lowest contributing ceiling, not the agent’s own', () => {
    // agent A3, resource A3, action A3, data class A3, but prod caps at A1.
    const resolution = resolveEffectiveAutonomy(bundle.ceilings, {
      agentId: AGENT,
      resource: 'repo:team/api',
      environment: 'prod',
      dataClasses: ['internal_source'],
      actionClass: 'jira.comment',
      incidentMode: false,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.effective).toBe('A1');
      expect(resolution.contributions.find((c) => c.dimension === 'environment')?.level).toBe('A1');
    }
  });

  it('includes incident mode in the same minimum', () => {
    const withIncident = resolveEffectiveAutonomy(bundle.ceilings, {
      agentId: AGENT,
      resource: 'repo:team/api',
      environment: 'dev',
      dataClasses: ['public'],
      actionClass: 'cognition.generate',
      incidentMode: true,
    });
    expect(withIncident.ok && withIncident.effective).toBe('A1');
  });

  it('does not let incident mode RAISE the ceiling when it is not declared', () => {
    const quiet = resolveEffectiveAutonomy(bundle.ceilings, {
      agentId: AGENT,
      resource: 'repo:team/api',
      environment: 'dev',
      dataClasses: ['public'],
      actionClass: 'cognition.generate',
      incidentMode: false,
    });
    expect(quiet.ok && quiet.contributions.some((c) => c.dimension === 'incident_mode')).toBe(false);
  });

  it('uses the most restrictive data class when several are present', () => {
    const mixed = resolveEffectiveAutonomy(bundle.ceilings, {
      agentId: AGENT,
      resource: 'repo:team/api',
      environment: 'dev',
      dataClasses: ['public', 'confidential'],
      actionClass: 'jira.comment',
      incidentMode: false,
    });
    expect(mixed.ok && mixed.effective).toBe('A1');
  });

  it('reports an unknown dimension instead of guessing a level', () => {
    const unknown = resolveEffectiveAutonomy(bundle.ceilings, {
      agentId: AGENT,
      resource: 'repo:team/api',
      environment: 'dev',
      dataClasses: [],
      actionClass: 'jira.comment',
      incidentMode: false,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.unknown[0]?.dimension).toBe('data_class');
  });

  it('never returns a level outside the ladder', () => {
    const resolution = resolveEffectiveAutonomy(bundle.ceilings, {
      agentId: AGENT,
      resource: 'repo:team/api',
      environment: 'nonprod',
      dataClasses: ['internal_source'],
      actionClass: 'jira.comment',
      incidentMode: false,
    });
    expect(resolution.ok && AUTONOMY_LEVELS).toContain(resolution.ok ? resolution.effective : 'A0');
  });
});

describe('unknown or unclassified input denies', () => {
  it('denies an action the bundle has no rule for', () => {
    const outcome = decide({ action: 'presence.speak' });
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason_codes).toContain('DENIED_UNKNOWN_ACTION');
  });

  it('denies a resource the bundle does not list', () => {
    const outcome = decide({ resource: 'repo:someone-else/secrets' });
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason_codes).toContain('DENIED_UNKNOWN_RESOURCE');
  });

  it('denies an empty data-class set rather than treating it as public', () => {
    const outcome = decide({ data_classes: [] });
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason_codes).toContain('DENIED_UNKNOWN_INPUT');
  });

  it('denies a query for a tenant this bundle does not govern', () => {
    const outcome = decide({ tenant_id: 'ten_00000000000000000000000099' });
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason_codes).toContain('DENIED_TENANT_MISMATCH');
  });

  it('reports A0 when it denies, never a level it could not establish', () => {
    expect(decide({ resource: 'repo:unknown/thing' }).autonomy_level).toBe('A0');
  });

  it('accepts a prefix-granted resource but not a lookalike', () => {
    expect(decide({ resource: 'repo:team/other' }).decision).not.toBe('deny');
    // `repo:team/*` must not admit `repo:teamevil/...`.
    expect(decide({ resource: 'repo:teamevil/api' }).reason_codes).toContain('DENIED_UNKNOWN_RESOURCE');
  });

  it('denies secret-class data outright', () => {
    const outcome = decide({ data_classes: ['secret'] });
    expect(outcome.reason_codes).toContain('DENIED_SECRET_DATA_CLASS');
  });
});

describe('the decision matrix', () => {
  it('allows when autonomy is sufficient and cost is inside the budget', () => {
    const outcome = decide();
    expect(outcome.decision).toBe('allow');
    expect(outcome.reason_codes).toContain('AUTONOMY_SUFFICIENT');
  });

  it('denies an environment the action rule does not permit', () => {
    const outcome = decide({ action: 'git.open_draft_pr', resource: 'repo:team/api', environment: 'prod' });
    expect(outcome.reason_codes).toContain('DENIED_ENVIRONMENT_NOT_PERMITTED');
  });

  it('denies data above the action rule ceiling', () => {
    const outcome = decide({ action: 'git.push', resource: 'repo:team/api', environment: 'dev', data_classes: ['confidential'] });
    expect(outcome.decision).toBe('deny');
  });

  it('requires approval when the rule always demands one, whatever the autonomy', () => {
    const outcome = decide({ action: 'staging.deploy', resource: 'service:api', environment: 'staging' });
    expect(outcome.decision).toBe('require_approval');
    expect(outcome.reason_codes).toContain('APPROVAL_REQUIRED_BY_RULE');
    expect(outcome.minimum_authn_strength).toBe('mfa');
  });

  it('requires approval when effective autonomy falls short', () => {
    // git.push needs A4; nothing in this bundle reaches A4 outside dev/public.
    const outcome = decide({ action: 'git.push', resource: 'repo:team/api', environment: 'dev', data_classes: ['internal'] });
    expect(outcome.decision).toBe('require_approval');
    expect(outcome.reason_codes).toContain('APPROVAL_REQUIRED_AUTONOMY');
  });

  it('requires approval above the cost threshold and denies above the ceiling', () => {
    expect(decide({ estimated_cost_usd: 5 }).decision).toBe('require_approval');
    expect(decide({ estimated_cost_usd: 5 }).reason_codes).toContain('APPROVAL_REQUIRED_COST');
    expect(decide({ estimated_cost_usd: 50 }).decision).toBe('deny');
    expect(decide({ estimated_cost_usd: 50 }).reason_codes).toContain('DENIED_COST_ABOVE_CEILING');
  });

  it('treats absent cost as zero, not as unknown', () => {
    expect(decide().decision).toBe('allow');
  });

  it('names incident mode when it is what pushed the action to approval', () => {
    const outcome = decide({ incident_mode: true });
    expect(outcome.decision).toBe('require_approval');
    expect(outcome.reason_codes).toContain('DENIED_INCIDENT_MODE');
  });

  it('allows when a valid approval satisfies a requirement', () => {
    const outcome = evaluate({
      bundle,
      query: baseQuery({ action: 'staging.deploy', resource: 'service:api', environment: 'staging' }),
      approval: { present: true, valid: true, approvalId: 'apr_1' },
    });
    expect(outcome.decision).toBe('allow');
    expect(outcome.reason_codes).toContain('APPROVAL_PRESENT');
  });

  it('does NOT allow when the supplied approval is invalid', () => {
    const outcome = evaluate({
      bundle,
      query: baseQuery({ action: 'staging.deploy', resource: 'service:api', environment: 'staging' }),
      approval: { present: true, valid: false, approvalId: 'apr_1', reason: 'APPROVAL_EXPIRED' },
    });
    expect(outcome.decision).toBe('require_approval');
    expect(outcome.reason_codes).toContain('APPROVAL_EXPIRED');
  });
});

describe('determinism', () => {
  it('gives byte-identical outcomes for identical inputs', () => {
    const once = JSON.stringify(decide({ estimated_cost_usd: 3 }));
    const twice = JSON.stringify(decide({ estimated_cost_usd: 3 }));
    expect(once).toBe(twice);
  });

  it('explains the number: the binding dimensions are reported', () => {
    const outcome = decide({ environment: 'prod', action: 'jira.comment' });
    expect(outcome.binding_dimensions.map((d) => d.dimension)).toContain('environment');
  });
});
