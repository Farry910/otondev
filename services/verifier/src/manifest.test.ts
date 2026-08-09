import { describe, expect, it } from 'vitest';
import { SUPPORTED_MANIFEST_VERSIONS, isSupportedVersion, normaliseVersion, validateManifest } from './manifest.js';
import { validManifestDocument } from './testing/harness.js';

describe('manifest version', () => {
  it('accepts the numeric form the design document writes and the pinned ref evidence carries', () => {
    // task-engine.md writes `version: 3`; EvidenceBundle.verifier.version is a PinnedVersionRef.
    // Both have to mean the same release or the manifest and the audit record disagree.
    expect(normaliseVersion(3)).toBe('verifier-v3');
    expect(normaliseVersion('3')).toBe('verifier-v3');
    expect(normaliseVersion('verifier-v3')).toBe('verifier-v3');
  });

  it('refuses versions it cannot read rather than guessing at them', () => {
    for (const bad of [null, undefined, '', '  ', 'v3', 'verifier-3', 'latest', 3.5, -1, 0, {}, []]) {
      expect(normaliseVersion(bad), `${JSON.stringify(bad)} must not parse`).toBeNull();
    }
  });

  it('distinguishes "unreadable" from "readable but unsupported"', () => {
    // The difference matters to whoever has to fix it: one is a typo, the other is an upgrade.
    expect(normaliseVersion('verifier-v99')).toBe('verifier-v99');
    expect(isSupportedVersion('verifier-v99')).toBe(false);
    expect(isSupportedVersion('verifier-v3')).toBe(true);
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain('verifier-v3');
  });
});

describe('validateManifest', () => {
  it('accepts the manifest exactly as the design document writes it', () => {
    const result = validateManifest(validManifestDocument({ conditional: { 'frontend-change': [{ name: 'ui', command: 'make test-ui' }] } }));

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.version).toBe('verifier-v3');
    expect(result.manifest?.required.map((check) => check.name)).toEqual(['unit', 'lint']);
    expect(result.manifest?.conditional['frontend-change']?.[0]?.name).toBe('ui');
    expect(result.manifest?.forbidden).toEqual(['generated-secrets']);
  });

  it('defaults a missing per-check timeout to a bounded value rather than to none', () => {
    const result = validateManifest(validManifestDocument({ required: [{ name: 'ui', command: 'make test-ui' }] }));
    expect(result.valid).toBe(true);
    // Unbounded is a hang, and a hung check is indistinguishable from a slow one.
    expect(result.manifest?.required[0]?.timeout_seconds).toBeGreaterThan(0);
  });

  it('treats a versionless manifest as invalid, not as current', () => {
    const result = validateManifest({ checks: [] });

    expect(result.valid).toBe(false);
    expect(result.version).toBeNull();
    expect(result.errors.join(' ')).toMatch(/no version/i);
  });

  it('fails closed on a version this build does not implement', () => {
    const result = validateManifest(validManifestDocument({ version: 99 }));

    expect(result.valid).toBe(false);
    expect(result.version).toBe('verifier-v99');
    expect(result.manifest).toBeNull();
    expect(result.errors.join(' ')).toMatch(/unsupported manifest version/i);
  });

  it('fails closed on a forbidden rule it cannot enforce', () => {
    // The dangerous direction: silently dropping an unknown rule produces a clean pass
    // exactly when the dropped rule would have failed the build.
    const result = validateManifest(validManifestDocument({ forbidden: ['generated-secrets', 'no-eval-in-prod'] }));

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/no-eval-in-prod/);
    expect(result.errors.join(' ')).toMatch(/cannot enforce|not a rule this build/i);
  });

  it('fails closed on a key it does not know', () => {
    const result = validateManifest(validManifestDocument({ 'required-later': [] }));

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown manifest key/i);
  });

  it('refuses a manifest that requires nothing', () => {
    const result = validateManifest(validManifestDocument({ required: [] }));

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/no required checks/i);
  });

  it('refuses a check that cannot run', () => {
    const noCommand = validateManifest(validManifestDocument({ required: [{ name: 'unit' }] }));
    expect(noCommand.valid).toBe(false);
    expect(noCommand.errors.join(' ')).toMatch(/no command/i);

    const noName = validateManifest(validManifestDocument({ required: [{ command: 'make test' }] }));
    expect(noName.valid).toBe(false);
    expect(noName.errors.join(' ')).toMatch(/no name/i);
  });

  it('refuses duplicate check names, because evidence records checks by name', () => {
    const result = validateManifest(
      validManifestDocument({
        required: [
          { name: 'unit', command: 'make a' },
          { name: 'unit', command: 'make b' },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/duplicate check name/i);
  });

  it('catches a duplicate that spans required and conditional groups', () => {
    const result = validateManifest(
      validManifestDocument({ conditional: { 'frontend-change': [{ name: 'unit', command: 'make ui' }] } }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/duplicate check name "unit"/i);
  });

  it('refuses an invalid evidence policy', () => {
    expect(validateManifest(validManifestDocument({ evidence: { retain_logs_days: -1, screenshots: 'never' } })).valid).toBe(false);
    expect(validateManifest(validManifestDocument({ evidence: { retain_logs_days: 14, screenshots: 'sometimes' } })).valid).toBe(false);
    expect(validateManifest(validManifestDocument({ evidence: undefined })).valid).toBe(false);
  });

  it('never returns a partly usable manifest', () => {
    // If any rule failed, `manifest` is null. A caller cannot accidentally proceed on the
    // half that parsed.
    const result = validateManifest(validManifestDocument({ forbidden: ['nonsense'] }));
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 42, 'yaml', [], [{ version: 3 }], new Date(0)]) {
      expect(() => validateManifest(input)).not.toThrow();
      expect(validateManifest(input).valid).toBe(false);
    }
  });
});
