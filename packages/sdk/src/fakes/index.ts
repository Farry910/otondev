import { ID_PREFIX, ulid } from '@otondev/contracts';
import type { Clock, IdFactory } from '@otondev/contracts';
import { createIdFactory, systemClock } from '../runtime.js';
import type { RuntimeContext } from '../runtime.js';
import type { ServiceClient } from '../hooks.js';
import type { ServiceRegistry } from '../services/index.js';
import type { FakeDefaults } from './base.js';
import {
  FakeAgentCore,
  FakeAudit,
  FakeCapabilityBroker,
  FakeCognition,
  FakeConnectorBroker,
  FakeIngress,
  FakePolicy,
  FakeWorkflowEngine,
} from './control-plane.js';
import { FakeEvidence, FakeExecutor, FakeVerifier, FakeWorkspace } from './execution-plane.js';
import { FakeMemory, FakeMemoryStore } from './data-plane.js';
import { FakePresence, FakePresentationController, FakeWindowsSupervisor } from './presence-plane.js';
import { FakeEvaluation, FakeIntegrationHarness, FakeOperator } from './cross-cutting.js';

export * from './base.js';
export * from './support.js';
export * from './control-plane.js';
export * from './execution-plane.js';
export * from './data-plane.js';
export * from './presence-plane.js';
export * from './cross-cutting.js';

/**
 * Every fake, wired together, in one call.
 *
 * "Registered in one place" is W0-D's requirement and it is not bookkeeping. A session that
 * needs three peers should not have to know how to construct seventeen, and — more
 * importantly — every session must get the *same* wiring, or two sessions will discover at
 * integration time that they built against differently-connected worlds.
 *
 * ```ts
 * const { services, runtime } = createFakeRegistry({ clock: new FakeClock('2026-07-30T08:00:00Z') });
 * const decision = await services.policy.evaluate(query);
 * ```
 */
export interface FakeRegistryOptions {
  /** Pass the testkit's `FakeClock` to make everything deterministic. */
  clock?: Clock;
  ids?: IdFactory;
  /** Override the tenant, agent and workload the fakes stamp on their records. */
  defaults?: Partial<FakeDefaults>;
}

export interface FakeRegistry {
  services: ServiceRegistry;
  runtime: RuntimeContext;
  defaults: FakeDefaults;
  /** Every fake as a flat list — what the operator fan-out and a health sweep iterate. */
  all(): ServiceClient[];
}

function fixedId(prefix: string, seed: number): string {
  const randomness = new Uint8Array(10);
  randomness[9] = seed;
  return prefix + ulid(0, randomness);
}

export function createFakeRegistry(options: FakeRegistryOptions = {}): FakeRegistry {
  const clock = options.clock ?? systemClock;
  const runtime: RuntimeContext = { clock, ids: options.ids ?? createIdFactory(clock) };

  // Stable by default so a golden file or a snapshot does not churn between runs. A caller
  // that wants realistic identities passes its own.
  const defaults: FakeDefaults = {
    tenantId: options.defaults?.tenantId ?? fixedId(ID_PREFIX.tenant, 1),
    agentId: options.defaults?.agentId ?? fixedId(ID_PREFIX.agent, 2),
    workloadId: options.defaults?.workloadId ?? fixedId(ID_PREFIX.workload, 3),
  };

  const workflow = new FakeWorkflowEngine(runtime, defaults);
  const broker = new FakeCapabilityBroker(runtime, defaults);
  const core = new FakeAgentCore(runtime, defaults, { workflow });
  const workspace = new FakeWorkspace(runtime, defaults);
  const memoryStore = new FakeMemoryStore(runtime, defaults);

  const services: ServiceRegistry = {
    ingress: new FakeIngress(runtime, defaults),
    workflow,
    core,
    policy: new FakePolicy(runtime, defaults),
    broker,
    cognition: new FakeCognition(runtime, defaults),
    connectors: new FakeConnectorBroker(runtime, defaults, { broker }),
    audit: new FakeAudit(runtime, defaults),
    evidence: new FakeEvidence(runtime, defaults),
    workspace,
    executor: new FakeExecutor(runtime, defaults, { workspace }),
    verifier: new FakeVerifier(runtime, defaults),
    memory: new FakeMemory(runtime, defaults, { store: memoryStore }),
    memoryStore,
    presence: new FakePresence(runtime, defaults, { core }),
    companion: new FakePresentationController(runtime, defaults),
    supervisor: new FakeWindowsSupervisor(runtime, defaults),
    // Built last and given a *lazy* view of its peers: the operator fans hooks out across
    // every service including, harmlessly, itself.
    operator: new FakeOperator(runtime, defaults, { peers: () => peers }),
    eval: new FakeEvaluation(runtime, defaults),
    integration: new FakeIntegrationHarness(runtime, defaults),
  };

  const peers: ServiceClient[] = Object.values(services);

  return {
    services,
    runtime,
    defaults,
    all: () => [...peers],
  };
}
