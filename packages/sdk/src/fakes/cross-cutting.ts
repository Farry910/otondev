import { FakeServiceBase } from './base.js';
import type { FakeDefaults } from './base.js';
import { fanOutControlHook } from '../hooks.js';
import type { ContainmentReport, ServiceClient } from '../hooks.js';
import type { RuntimeContext } from '../runtime.js';
import { EMERGENCY_SEQUENCE } from '../services/cross-cutting.js';
import type {
  EmergencyOutcome,
  EmergencyRequest,
  EvalReport,
  EvaluationClient,
  IntegrationHarness,
  OperatorClient,
  RegressionVerdict,
  ScenarioResult,
} from '../services/cross-cutting.js';

/** Minimal in-memory fakes, S18-S20. */

// ------------------------------------------------------------------------------- S18

export class FakeOperator extends FakeServiceBase implements OperatorClient {
  readonly serviceId = 'operator' as const;
  readonly #reports = new Map<string, ContainmentReport>();
  readonly #peers: () => readonly ServiceClient[];
  #epoch = 0;

  constructor(runtime: RuntimeContext, defaults: FakeDefaults, deps: { peers: () => readonly ServiceClient[] }) {
    super(runtime, defaults);
    this.#peers = deps.peers;
  }

  async pauseAgent(request: EmergencyRequest): Promise<ContainmentReport> {
    return this.#fan('deny', request);
  }

  async denyNewWork(request: EmergencyRequest): Promise<ContainmentReport> {
    return this.#fan('deny', request);
  }

  async cancelWorkflow(request: EmergencyRequest & { workflow_id: string }): Promise<ContainmentReport> {
    return this.#fan('quarantine', { ...request, scope: { kind: 'workflow', id: request.workflow_id } });
  }

  async revokeTokens(request: EmergencyRequest): Promise<ContainmentReport> {
    this.#epoch += 1;
    return this.#fan('revoke', request);
  }

  async quarantineWorker(request: EmergencyRequest & { workspace_id: string }): Promise<ContainmentReport> {
    return this.#fan('quarantine', { ...request, scope: { kind: 'workspace', id: request.workspace_id } });
  }

  /**
   * The six steps, in order. The order is the safety property: new capabilities stop being
   * issued before work is cancelled, so a workflow on its way out cannot grab one more.
   */
  async emergencyStop(request: EmergencyRequest): Promise<EmergencyOutcome> {
    const steps: EmergencyOutcome['steps'] = [];
    let denyPropagationMs = 0;

    for (const step of EMERGENCY_SEQUENCE) {
      const report = await this.#runStep(step, request);
      steps.push({ step, report });
      if (step === 'deny_new_work') denyPropagationMs = report.slowest_ms;
    }

    return {
      incident_id: request.incident_id,
      steps,
      // Verified, not requested. One unreachable peer means containment is *not* confirmed,
      // and saying otherwise during an incident is the worst possible lie to tell.
      contained: steps.every(({ report }) => report.contained),
      deny_propagation_ms: denyPropagationMs,
    };
  }

  async containmentReport(incidentId: string): Promise<ContainmentReport> {
    const report = this.#reports.get(incidentId);
    if (report === undefined) this.fail('INTERNAL', { reason: 'no such incident' });
    return report;
  }

  async lift(incidentId: string, _operator: EmergencyRequest['operator']): Promise<void> {
    this.#reports.delete(incidentId);
  }

  #runStep(step: (typeof EMERGENCY_SEQUENCE)[number], request: EmergencyRequest): Promise<ContainmentReport> {
    switch (step) {
      case 'pause_agent':
      case 'deny_new_work':
      case 'deny_new_capabilities':
        return this.#fan('deny', request);
      case 'cancel_workflows':
      case 'quarantine_workers':
        return this.#fan('quarantine', request);
      case 'revoke_tokens':
        this.#epoch += 1;
        return this.#fan('revoke', request);
    }
  }

  async #fan(
    hook: 'deny' | 'quarantine' | 'revoke',
    request: EmergencyRequest,
  ): Promise<ContainmentReport> {
    const report = await fanOutControlHook(
      hook,
      this.#peers() as (ServiceClient & Record<string, unknown>)[],
      {
        incident_id: request.incident_id,
        scope: request.scope,
        reason: request.reason,
        requested_by: request.operator.operator_id,
        requested_at: this.runtime.clock.nowIso(),
        revocation_epoch: this.#epoch,
      },
      { clock: this.runtime.clock },
    );
    this.#reports.set(request.incident_id, report);
    return report;
  }
}

// ------------------------------------------------------------------------------- S19

export class FakeEvaluation extends FakeServiceBase implements EvaluationClient {
  readonly serviceId = 'eval' as const;
  readonly suites = new Map<string, EvalReport>();
  readonly baselines = new Map<string, RegressionVerdict[]>();

  async runSuite(name: string): Promise<EvalReport> {
    const report = this.suites.get(name);
    if (report === undefined) this.fail('INTERNAL', { reason: `no such suite: ${name}` });
    return report;
  }

  async runAdversarialCorpus(): Promise<EvalReport> {
    return this.runSuite('adversarial');
  }

  async regressionCheck(baseline: string): Promise<RegressionVerdict[]> {
    return this.baselines.get(baseline) ?? [];
  }
}

// ------------------------------------------------------------------------------- S20

export class FakeIntegrationHarness extends FakeServiceBase implements IntegrationHarness {
  readonly serviceId = 'integration' as const;
  readonly scenarios = new Map<string, ScenarioResult>();

  async runScenario(name: string): Promise<ScenarioResult> {
    const result = this.scenarios.get(name);
    if (result === undefined) this.fail('INTERNAL', { reason: `no such scenario: ${name}` });
    return result;
  }

  async listScenarios(): Promise<string[]> {
    return [...this.scenarios.keys()];
  }
}
