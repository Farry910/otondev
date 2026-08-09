import { OWNERSHIP, BRANCH_CARD_PATTERN } from './ownership-map.mjs';

/**
 * Translate one ownership glob into an anchored regular expression.
 *
 * Supported: `**` (any depth, including none), `*` (one segment), `?` (one character).
 * `a/**` also matches the bare directory `a`, so a reservation covers the directory entry
 * itself and not only its contents.
 */
function translate(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}

export function globToRegExp(glob) {
  // `a/**` covers the directory entry itself as well as everything under it, so a
  // reservation is not defeated by a file being added at the directory root.
  if (glob.endsWith('/**')) {
    return new RegExp(`^(?:${translate(glob)}|${translate(glob.slice(0, -3))})$`);
  }
  return new RegExp(`^${translate(glob)}$`);
}

/** Precompiled ownership entries. */
export function compileOwnership(entries = OWNERSHIP) {
  return entries.map((entry) => ({
    ...entry,
    sharedWith: entry.sharedWith ?? [],
    matchers: entry.owns.map((glob) => ({ glob, re: globToRegExp(glob) })),
  }));
}

/** @returns {{id: string, glob: string}[]} every entry claiming `file`. */
export function ownersOf(file, compiled = compileOwnership()) {
  const path = file.replaceAll('\\', '/');
  const hits = [];
  for (const entry of compiled) {
    const matched = entry.matchers.find((m) => m.re.test(path));
    if (matched) hits.push({ id: entry.id, glob: matched.glob, sharedWith: entry.sharedWith });
  }
  return hits;
}

/**
 * Invariant 1 — the map is total and unambiguous over `files`.
 * @returns {{ok: boolean, unowned: string[], conflicts: {file: string, owners: string[]}[]}}
 */
export function auditOwnership(files, compiled = compileOwnership()) {
  const unowned = [];
  const conflicts = [];
  for (const file of files) {
    const hits = ownersOf(file, compiled);
    if (hits.length === 0) unowned.push(file);
    else if (hits.length > 1) conflicts.push({ file, owners: hits.map((h) => `${h.id}:${h.glob}`) });
  }
  return { ok: unowned.length === 0 && conflicts.length === 0, unowned, conflicts };
}

/**
 * Invariant 2 — `card` may only change files it owns.
 * @returns {{ok: boolean, violations: {file: string, owner: string|null}[]}}
 */
export function checkChangedFiles(card, files, compiled = compileOwnership()) {
  const violations = [];
  for (const file of files) {
    const hits = ownersOf(file, compiled);
    if (hits.length === 0) {
      violations.push({ file, owner: null });
      continue;
    }
    const permitted = hits.some(
      (h) => h.id === card || h.sharedWith.includes(card) || h.sharedWith.includes('*'),
    );
    if (!permitted) violations.push({ file, owner: hits.map((h) => h.id).join(', ') });
  }
  return { ok: violations.length === 0, violations };
}

/** `wf/W0-foundation` -> `W0`; `svc/S7-connectors` -> `S7`. */
export function cardFromBranch(branch) {
  const m = BRANCH_CARD_PATTERN.exec(branch.trim());
  return m ? m[1] : null;
}
