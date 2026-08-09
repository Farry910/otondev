/**
 * The versioned verifier manifest — parser and validator.
 *
 * Shape from `doc/02-architecture/components/task-engine.md` "Definition of done": every
 * repository integrated with Agent Dev MUST provide one, and it is versioned because the set
 * of things "done" means changes over time and the change has to be visible in evidence.
 *
 * This module takes an already-parsed object rather than YAML text. That is deliberate and it
 * is what {@link import('@otondev/sdk').VerifierClient.validateManifest} is typed as: the
 * verifier's job is to decide whether a manifest is *usable*, and deserialising it is the
 * caller's. Keeping the parser out means no YAML dependency in the trust-critical path, and a
 * malformed document fails in the caller rather than producing a half-built manifest here.
 *
 * Everything below fails **closed**. The S12 exit criterion is "a manifest version mismatch
 * fails closed", but a version check alone is not enough to earn that: a manifest carrying a
 * rule this build cannot enforce is exactly as dangerous as one carrying a version this build
 * does not know, and it is much easier to write by accident.
 */

/**
 * Manifest versions this build implements.
 *
 * A pinned ref rather than a bare number because it is what travels in evidence
 * (`EvidenceBundle.verifier.version`, a `PinnedVersionRef`) and what an auditor reads. The
 * manifest document itself writes `version: 3`; {@link normaliseVersion} maps between them so
 * the document stays as the design wrote it and the record stays as contracts §12 requires.
 */
export const SUPPORTED_MANIFEST_VERSIONS: readonly string[] = ['verifier-v3'];

/**
 * Rules the manifest may forbid, and that this build knows how to enforce.
 *
 * An unrecognised entry invalidates the manifest. That looks strict until you consider the
 * alternative: silently ignoring `modified-protected-paths-without-approval` because it was
 * spelled slightly differently produces a verifier that reports a clean pass precisely when
 * the rule it dropped would have failed the build.
 */
export const FORBIDDEN_RULES = [
  'generated-secrets',
  'modified-protected-paths-without-approval',
  'incompatible-licence',
] as const;
export type ForbiddenRule = (typeof FORBIDDEN_RULES)[number];

export const SCREENSHOT_POLICIES = ['never', 'always', 'on_ui_change'] as const;
export type ScreenshotPolicy = (typeof SCREENSHOT_POLICIES)[number];

export interface ManifestCheck {
  name: string;
  command: string;
  /** Absent in the document means "no ceiling declared", which is not the same as "forever". */
  timeout_seconds: number;
}

export interface ManifestEvidencePolicy {
  retain_logs_days: number;
  screenshots: ScreenshotPolicy;
}

export interface VerifierManifest {
  /** The pinned ref, e.g. `verifier-v3`. This is what lands in the evidence bundle. */
  version: string;
  /** Checks that must run and pass on every workflow. */
  required: readonly ManifestCheck[];
  /** Checks that apply only when the named condition holds, e.g. `frontend-change`. */
  conditional: Readonly<Record<string, readonly ManifestCheck[]>>;
  evidence: ManifestEvidencePolicy;
  forbidden: readonly ForbiddenRule[];
}

export interface ManifestValidation {
  valid: boolean;
  /** The pinned ref when one could be read at all, even if unsupported. Null otherwise. */
  version: string | null;
  errors: string[];
  /** Present only when `valid`. There is no such thing as a partly usable manifest. */
  manifest: VerifierManifest | null;
}

/** Default when the manifest omits a per-check timeout. Bounded, because unbounded is a hang. */
const DEFAULT_TIMEOUT_SECONDS = 900;

const KNOWN_KEYS = new Set(['version', 'required', 'conditional', 'evidence', 'forbidden']);

/**
 * Map a manifest `version` field to a pinned ref.
 *
 * Accepts `3` and `'3'` (what the document in task-engine.md writes) and `'verifier-v3'`
 * (what the SDK interface and the evidence bundle carry). Returns null for anything else,
 * including a version that parses but names a release this build does not implement — the
 * caller distinguishes "unreadable" from "unsupported" using the returned ref.
 */
export function normaliseVersion(raw: unknown): string | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? `verifier-v${raw}` : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^[0-9]+$/.test(trimmed)) return `verifier-v${Number(trimmed)}`;
  if (/^verifier-v[0-9]+$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * A type predicate rather than a plain boolean, so a caller that has checked the version
 * cannot then pass `string | null` to something expecting a version. The compiler enforces
 * the ordering the fail-closed rule depends on.
 */
export function isSupportedVersion(version: string | null): version is string {
  return version !== null && SUPPORTED_MANIFEST_VERSIONS.includes(version);
}

/**
 * Validate a manifest and, when it is usable, return it normalised.
 *
 * Never throws. A validator that threw would push every caller into a try/catch whose catch
 * block is the easiest place in the system to accidentally write "assume it was fine".
 */
export function validateManifest(input: unknown): ManifestValidation {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, version: null, errors: ['manifest is not an object'], manifest: null };
  }

  const raw = input as Record<string, unknown>;

  // Read the version first and report it even when the rest is unusable: "which version was
  // this?" is the first question asked about a rejected manifest.
  const version = normaliseVersion(raw['version']);
  if (!('version' in raw)) {
    // Not "assume current". An unversioned manifest is the one case where guessing is most
    // tempting and most wrong: it is what a hand-written first attempt looks like.
    errors.push('manifest has no version; a versionless manifest is invalid, not assumed current');
  } else if (version === null) {
    errors.push(`manifest version is unreadable: ${describe(raw['version'])}`);
  } else if (!isSupportedVersion(version)) {
    errors.push(
      `unsupported manifest version ${version}; this build implements ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}`,
    );
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      // A key this build does not know is a rule this build cannot enforce. Ignoring it would
      // make the manifest's author believe something is being checked that is not.
      errors.push(`unknown manifest key "${key}"; this build cannot honour it, so it fails closed`);
    }
  }

  const required = readChecks(raw['required'], 'required', errors);
  const conditional = readConditional(raw['conditional'], errors);
  const evidence = readEvidence(raw['evidence'], errors);
  const forbidden = readForbidden(raw['forbidden'], errors);

  if (required !== null && required.length === 0) {
    // A manifest that requires nothing would make every workflow pass its definition of done
    // by having no definition of done.
    errors.push('manifest declares no required checks; "done" would then mean nothing');
  }

  const names = new Set<string>();
  for (const check of [...(required ?? []), ...Object.values(conditional ?? {}).flat()]) {
    if (names.has(check.name)) {
      // Two checks with one name make a verdict unattributable, and the evidence bundle
      // records checks by name.
      errors.push(`duplicate check name "${check.name}"`);
    }
    names.add(check.name);
  }

  if (
    errors.length > 0 ||
    version === null ||
    required === null ||
    conditional === null ||
    evidence === null ||
    forbidden === null
  ) {
    return { valid: false, version, errors, manifest: null };
  }

  return {
    valid: true,
    version,
    errors: [],
    manifest: { version, required, conditional, evidence, forbidden },
  };
}

function readChecks(raw: unknown, label: string, errors: string[]): ManifestCheck[] | null {
  if (raw === undefined) {
    errors.push(`manifest has no "${label}" list`);
    return null;
  }
  if (!Array.isArray(raw)) {
    errors.push(`"${label}" must be a list`);
    return null;
  }

  const checks: ManifestCheck[] = [];
  let sound = true;

  for (const [index, entry] of raw.entries()) {
    const at = `${label}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${at} is not an object`);
      sound = false;
      continue;
    }
    const item = entry as Record<string, unknown>;
    const name = item['name'];
    const command = item['command'];
    const timeout = item['timeout'] ?? item['timeout_seconds'];

    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${at} has no name`);
      sound = false;
      continue;
    }
    if (typeof command !== 'string' || command.trim() === '') {
      // A check with no command cannot run, and a check that cannot run must never be able to
      // look like one that ran and passed.
      errors.push(`${at} ("${name}") has no command`);
      sound = false;
      continue;
    }
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0)) {
      errors.push(`${at} ("${name}") has a non-positive or non-integer timeout`);
      sound = false;
      continue;
    }

    checks.push({
      name: name.trim(),
      command: command.trim(),
      timeout_seconds: typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT_SECONDS,
    });
  }

  return sound ? checks : null;
}

function readConditional(
  raw: unknown,
  errors: string[],
): Record<string, ManifestCheck[]> | null {
  // Optional: a repository with no conditional checks is normal, unlike one with no required
  // checks.
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('"conditional" must be a mapping of condition to check list');
    return null;
  }

  const out: Record<string, ManifestCheck[]> = {};
  let sound = true;
  for (const [condition, value] of Object.entries(raw as Record<string, unknown>)) {
    if (condition.trim() === '') {
      errors.push('"conditional" has an empty condition name');
      sound = false;
      continue;
    }
    const checks = readChecks(value, `conditional.${condition}`, errors);
    if (checks === null) {
      sound = false;
      continue;
    }
    out[condition] = checks;
  }
  return sound ? out : null;
}

function readEvidence(raw: unknown, errors: string[]): ManifestEvidencePolicy | null {
  if (raw === undefined) {
    errors.push('manifest has no "evidence" policy');
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('"evidence" must be an object');
    return null;
  }
  const item = raw as Record<string, unknown>;
  const retain = item['retain_logs_days'];
  const screenshots = item['screenshots'] ?? 'never';

  let sound = true;
  if (typeof retain !== 'number' || !Number.isInteger(retain) || retain < 0) {
    errors.push('"evidence.retain_logs_days" must be a non-negative integer');
    sound = false;
  }
  if (typeof screenshots !== 'string' || !isScreenshotPolicy(screenshots)) {
    errors.push(`"evidence.screenshots" must be one of ${SCREENSHOT_POLICIES.join(', ')}`);
    sound = false;
  }

  if (!sound || typeof retain !== 'number' || typeof screenshots !== 'string' || !isScreenshotPolicy(screenshots)) {
    return null;
  }
  return { retain_logs_days: retain, screenshots };
}

function readForbidden(raw: unknown, errors: string[]): ForbiddenRule[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('"forbidden" must be a list');
    return null;
  }

  const rules: ForbiddenRule[] = [];
  let sound = true;
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || !isForbiddenRule(entry)) {
      errors.push(
        `forbidden[${index}] is not a rule this build can enforce: ${describe(entry)}. ` +
          `Known rules: ${FORBIDDEN_RULES.join(', ')}`,
      );
      sound = false;
      continue;
    }
    rules.push(entry);
  }
  return sound ? rules : null;
}

function isForbiddenRule(value: string): value is ForbiddenRule {
  return (FORBIDDEN_RULES as readonly string[]).includes(value);
}

function isScreenshotPolicy(value: string): value is ScreenshotPolicy {
  return (SCREENSHOT_POLICIES as readonly string[]).includes(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? 'a list' : typeof value;
}
