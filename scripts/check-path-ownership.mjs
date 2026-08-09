#!/usr/bin/env node
/**
 * Path-ownership check — implementation-plan §1 property 1, §6 rule 2.
 *
 *   node scripts/check-path-ownership.mjs audit
 *       every tracked file is owned by exactly one card.
 *
 *   node scripts/check-path-ownership.mjs diff [--base <ref>] [--card <ID>]
 *       every file this branch changes is owned by this branch's card. The card is read
 *       from the branch name (`wf/W0-foundation` -> W0) unless --card says otherwise.
 *
 * Exit code 1 on any violation, so CI fails rather than reports.
 */
import { execFileSync } from 'node:child_process';
import { auditOwnership, checkChangedFiles, cardFromBranch, compileOwnership } from './lib/ownership.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function gitLines(args) {
  const out = git(args);
  return out === '' ? [] : out.split(/\r?\n/).filter(Boolean);
}

function parseArgs(argv) {
  const [command = 'audit'] = argv;
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return { command, flags };
}

function runAudit() {
  const files = gitLines(['ls-files']);
  const { ok, unowned, conflicts } = auditOwnership(files, compileOwnership());

  if (ok) {
    console.log(`path-ownership: OK — ${files.length} tracked files, each owned by exactly one card.`);
    return 0;
  }
  if (unowned.length > 0) {
    console.error(`\npath-ownership: ${unowned.length} file(s) owned by no card.`);
    console.error('Add the path to scripts/lib/ownership-map.mjs (a W0/S20-owned file) via a');
    console.error('contract request, or move the file under a path your card already owns.\n');
    for (const f of unowned) console.error(`  unowned  ${f}`);
  }
  if (conflicts.length > 0) {
    console.error(`\npath-ownership: ${conflicts.length} file(s) claimed by more than one card.`);
    console.error('Overlapping ownership is the defect the board exists to prevent.\n');
    for (const c of conflicts) console.error(`  overlap  ${c.file}  <-  ${c.owners.join('  ')}`);
  }
  return 1;
}

function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const candidate of ['origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', '--quiet', candidate]);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function runDiff(flags) {
  const branch = flags.branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const card = flags.card ?? cardFromBranch(branch);
  if (!card) {
    console.error(`path-ownership: cannot tell which card owns branch "${branch}".`);
    console.error('Branches are named wf/<ID>-<slug> or svc/<ID>-<slug> (implementation-plan §6).');
    console.error('Pass --card <ID> if you are checking a branch you did not create.');
    return 1;
  }

  const base = resolveBase(flags.base);
  if (!base) {
    console.log('path-ownership: no base ref to diff against; skipping the changed-file check.');
    return 0;
  }

  let mergeBase = base;
  try {
    mergeBase = git(['merge-base', base, 'HEAD']);
  } catch {
    /* unrelated histories — fall back to the ref itself */
  }
  const files = gitLines(['diff', '--name-only', '--diff-filter=ACMRT', `${mergeBase}..HEAD`]);
  const { ok, violations } = checkChangedFiles(card, files, compileOwnership());

  if (ok) {
    console.log(
      `path-ownership: OK — ${files.length} file(s) changed on ${branch}, all owned by ${card}.`,
    );
    return 0;
  }
  console.error(`\npath-ownership: branch ${branch} (card ${card}) changed files it does not own.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}\n      owned by ${v.owner ?? 'no card at all'}`);
  }
  console.error('\nThis is not a merge hazard to resolve locally — it is the ownership rule doing');
  console.error('its job. Revert the change and raise: board.ps1 request ' + card + ' -Note "..."\n');
  return 1;
}

const { command, flags } = parseArgs(process.argv.slice(2));
let code;
switch (command) {
  case 'audit':
    code = runAudit();
    break;
  case 'diff':
    code = runDiff(flags);
    break;
  default:
    console.error(`unknown command "${command}". Use: audit | diff`);
    code = 2;
}
process.exit(code);
