import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  auditOwnership,
  cardFromBranch,
  checkChangedFiles,
  compileOwnership,
  globToRegExp,
  ownersOf,
} from '../lib/ownership.mjs';
import { OWNERSHIP } from '../lib/ownership-map.mjs';

const compiled = compileOwnership();

describe('glob translation', () => {
  it('matches a directory reservation and everything under it', () => {
    const re = globToRegExp('services/ingress/**');
    expect(re.test('services/ingress')).toBe(true);
    expect(re.test('services/ingress/package.json')).toBe(true);
    expect(re.test('services/ingress/src/deep/nested/file.ts')).toBe(true);
    expect(re.test('services/ingress-extra/file.ts')).toBe(false);
    expect(re.test('services/workflow/src/file.ts')).toBe(false);
  });

  it('keeps `*` inside one path segment', () => {
    const re = globToRegExp('packages/*/package.json');
    expect(re.test('packages/sdk/package.json')).toBe(true);
    expect(re.test('packages/sdk/nested/package.json')).toBe(false);
  });

  it('does not let a regex metacharacter in a glob widen the match', () => {
    const re = globToRegExp('docker-compose.dev.yml');
    expect(re.test('docker-compose.dev.yml')).toBe(true);
    expect(re.test('docker-composeXdevXyml')).toBe(false);
  });
});

describe('the ownership map', () => {
  it('gives every card in implementation-plan §4 a home', () => {
    const ids = OWNERSHIP.map((e) => e.id);
    for (let n = 1; n <= 20; n += 1) expect(ids).toContain(`S${n}`);
    expect(ids).toContain('W0');
  });

  it('claims no path twice', () => {
    // Overlap is the exact defect the board exists to prevent, so the map may not contain it
    // even for paths that do not exist yet.
    const probes = OWNERSHIP.flatMap((e) =>
      e.owns.map((g) => (g.endsWith('/**') ? `${g.slice(0, -3)}/probe.ts` : g)),
    );
    for (const probe of probes) {
      const hits = ownersOf(probe, compiled);
      expect(hits.map((h) => h.id), `"${probe}" is claimed more than once`).toHaveLength(1);
    }
  });
});

describe('audit — every tracked file is owned', () => {
  it('holds for the real repository', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    const result = auditOwnership(files, compiled);
    expect({ unowned: result.unowned, conflicts: result.conflicts }).toEqual({
      unowned: [],
      conflicts: [],
    });
  });

  it('reports a file no card claims', () => {
    const result = auditOwnership(['some/unclaimed/path.ts'], compiled);
    expect(result.ok).toBe(false);
    expect(result.unowned).toEqual(['some/unclaimed/path.ts']);
  });

  it('reports two cards claiming one file', () => {
    const overlapping = compileOwnership([
      { id: 'SA', title: 'a', owns: ['services/shared/**'] },
      { id: 'SB', title: 'b', owns: ['services/**'] },
    ]);
    const result = auditOwnership(['services/shared/src/index.ts'], overlapping);
    expect(result.ok).toBe(false);
    expect(result.conflicts[0].owners).toEqual(['SA:services/shared/**', 'SB:services/**']);
  });
});

describe('diff — a branch may only change what its card owns', () => {
  it('accepts a change inside the card', () => {
    expect(checkChangedFiles('S7', ['services/connectors/src/github.ts'], compiled).ok).toBe(true);
  });

  it('FAILS a change to a peer package', () => {
    const result = checkChangedFiles('S7', ['services/policy/src/evaluate.ts'], compiled);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ file: 'services/policy/src/evaluate.ts', owner: 'S4' }]);
  });

  it('FAILS a change to a shared file — contracts are frozen after Wave 0', () => {
    const result = checkChangedFiles('S7', ['packages/contracts/src/capability.ts'], compiled);
    expect(result.ok).toBe(false);
    expect(result.violations[0].owner).toBe('W0');
  });

  it('FAILS a change to root config', () => {
    expect(checkChangedFiles('S7', ['tsconfig.base.json'], compiled).ok).toBe(false);
    expect(checkChangedFiles('S7', ['.github/workflows/ci.yml'], compiled).ok).toBe(false);
  });

  it('FAILS a change to a path no card owns', () => {
    const result = checkChangedFiles('S7', ['random.ts'], compiled);
    expect(result.violations).toEqual([{ file: 'random.ts', owner: null }]);
  });

  it('lets W0 and S20 change the shared files, and nobody else', () => {
    expect(checkChangedFiles('W0', ['packages/contracts/src/capability.ts'], compiled).ok).toBe(true);
    expect(checkChangedFiles('S20', ['docker-compose.dev.yml'], compiled).ok).toBe(true);
    expect(checkChangedFiles('S4', ['docker-compose.dev.yml'], compiled).ok).toBe(false);
  });

  it('lets any card append to the board and file a contract request', () => {
    expect(checkChangedFiles('S12', ['board/packages/S12-verifier.md'], compiled).ok).toBe(true);
    expect(checkChangedFiles('S12', ['CONTRACT-REQUESTS.md'], compiled).ok).toBe(true);
  });
});

describe('branch to card', () => {
  it('reads the card from the naming convention', () => {
    expect(cardFromBranch('wf/W0-foundation')).toBe('W0');
    expect(cardFromBranch('svc/S7-connectors')).toBe('S7');
    expect(cardFromBranch('svc/S20-integration')).toBe('S20');
  });

  it('returns null rather than guessing', () => {
    expect(cardFromBranch('main')).toBeNull();
    expect(cardFromBranch('feature/whatever')).toBeNull();
  });
});
