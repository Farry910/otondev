/**
 * S12 — Verifier and Definition of Done.
 *
 * The public surface is the service, the ports it drives, and the verdict rules. The rules
 * are exported as functions rather than kept private because two of the exit criteria are
 * about them holding *outside* this service as well: the task engine is what holds both the
 * verifier's verdict and the executor's claim, and
 * {@link reconcileWithExecutorClaim} is how it resolves them without being able to get the
 * direction wrong.
 */

export { VerifierService } from './verifier.js';
export type { ConditionEvaluator, ManifestSource, VerifierConfig, VerifierDeps } from './verifier.js';

export {
  FORBIDDEN_RULES,
  SCREENSHOT_POLICIES,
  SUPPORTED_MANIFEST_VERSIONS,
  isSupportedVersion,
  normaliseVersion,
  validateManifest,
} from './manifest.js';
export type {
  ForbiddenRule,
  ManifestCheck,
  ManifestEvidencePolicy,
  ManifestValidation,
  ScreenshotPolicy,
  VerifierManifest,
} from './manifest.js';

export type {
  CheckOutcome,
  CheckRunner,
  ExecutorClaim,
  ScanFinding,
  ScanResult,
  Scanner,
  ScannerKind,
  VerificationTarget,
} from './ports.js';

export {
  FORBIDDEN_VERIFIER_METHODS,
  aggregateVerdict,
  assertNoPublishSurface,
  limitationsFrom,
  projectVerifyInput,
  reconcileWithExecutorClaim,
  summarise,
  unavailable,
} from './verdict.js';
export type { Verdict } from './verdict.js';
