/**
 * S19 — Evaluation and Conformance Harness.
 *
 * The gate that turns W0's reporting machinery into something a build can fail on, plus the
 * four suites the design asks for: fault injection, the adversarial corpus, canary
 * exfiltration, and task-quality benchmarking with cost and latency regression.
 *
 * One rule runs through all of it, inherited from S12 and applied here to the harness itself:
 * **a check that could not run is never a pass.** A safety harness that reports green when it
 * is broken is worse than no harness, because it is believed.
 */

export { SEVERITIES, CHECK_STATUSES, exitCodeFor, finding, formatReport, summarise } from './findings.js';
export type { CheckStatus, Finding, HarnessReport, Severity } from './findings.js';

export { INJECTION_CHANNELS, INJECTION_CORPUS, INJECTION_VECTORS, carries, corpusCoverage } from './adversarial.js';
export type { InjectionCase, InjectionChannel, InjectionVector } from './adversarial.js';

export { CANARY, EXFIL_CHANNELS, probeOver, runProbe, unobservable } from './canary.js';
export type { ExfilChannel, ExfilProbe, ExfilVerdict } from './canary.js';

export { FAULT_CLASSES, FAULT_SCENARIOS, classesCovered, scenariosFor } from './faults.js';
export type { FaultClass, FaultScenario } from './faults.js';

export { freezeTask, runAttempt, summariseBenchmark, visibleOnly } from './benchmark.js';
export type {
  Attempt,
  BenchmarkSummary,
  FrozenTask,
  HiddenTest,
  Submission,
  TaskScore,
  VisibleTask,
} from './benchmark.js';

export { BaselineStore, DEFAULT_THRESHOLDS, compareToBaseline, versionKey } from './regression.js';
export type { Measurement, PinnedVersions, RegressionOutcome, RegressionVerdict, Thresholds } from './regression.js';

export { REAL_SUBJECTS, runFakeConformance, runRealParity } from './conformance.js';
export type { RealSubjectSpec } from './conformance.js';

export { KNOWN_GAPS, applyKnownGaps } from './gaps.js';
export type { GapApplication, KnownGap } from './gaps.js';

export { classify, coverageFor, readCardCriteria } from './coverage.js';
export type { CardCriterion, ClassifiedCriterion, CoverageReport, Expression } from './coverage.js';

export { runAdversarialSuite, runCanarySuite, runCoverageSuite, runFaultSuite, runHarness } from './harness.js';
export type { HarnessOptions } from './harness.js';
