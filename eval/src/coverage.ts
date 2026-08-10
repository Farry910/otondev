/**
 * "Every card's exit criteria are expressible in the harness."
 *
 * That claim is only worth anything if it is *checked*, so this module does not restate the
 * criteria — it reads them from `board/packages/*.md`, which is where they actually live, and
 * classifies every one. A hand-maintained copy would drift from the board within a week and
 * then assert coverage of criteria nobody has.
 *
 * Three classifications, and the distinction between them is the honest part:
 *
 *   - `harness`  — this package runs it: the fault suite, the adversarial corpus, the canary
 *                  probes, the benchmark, the regression comparison, the conformance gate.
 *   - `package`  — expressed as the owning package's own conformance suite and tests, which
 *                  run in the same CI invocation. The harness's contribution is the gate that
 *                  turns their result into a build failure.
 *   - `manual`   — needs a human: a spike verdict, a gate decision, a platform choice. Saying
 *                  so is the point. A harness that claimed to automate a human judgement
 *                  would be worse than one that admits it cannot.
 *
 * Anything unmatched is reported as **unclassified**, never as covered, and a test in this
 * package fails while any exist. That failure is the mechanism: whoever adds a criterion has
 * to say how it is expressed, at the moment they add it, rather than at audit time.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type Expression = 'harness' | 'package' | 'manual';

export interface CardCriterion {
  card: string;
  text: string;
  /** Whether the board shows it ticked. Recorded, never used to decide coverage. */
  ticked: boolean;
}

export interface ClassifiedCriterion extends CardCriterion {
  expression: Expression | null;
  /** Which harness suite or package test expresses it. */
  by: string;
}

export interface CoverageReport {
  criteria: readonly ClassifiedCriterion[];
  unclassified: readonly ClassifiedCriterion[];
  byExpression: Record<Expression, number>;
}

interface Rule {
  /** Card id, or `*` for any. */
  card: string;
  match: RegExp;
  expression: Expression;
  by: string;
}

/**
 * Classification rules, most specific first.
 *
 * Ordered rather than keyed so a card-specific rule can override a general one, and matched
 * on the criterion text so a reworded criterion surfaces as unclassified rather than silently
 * inheriting a classification written for something else.
 */
const RULES: readonly Rule[] = [
  // --- what this package runs itself -------------------------------------------------
  { card: '*', match: /fault[- ]injection|fault injection suite/i, expression: 'harness', by: 'eval/faults' },
  { card: '*', match: /prompt injection|adversarial corpus/i, expression: 'harness', by: 'eval/adversarial' },
  { card: '*', match: /canary|exfiltration/i, expression: 'harness', by: 'eval/canary' },
  { card: '*', match: /benchmark|frozen tasks|hidden tests/i, expression: 'harness', by: 'eval/benchmark' },
  { card: '*', match: /cost and latency regression/i, expression: 'harness', by: 'eval/regression' },
  { card: '*', match: /conformance runner and fake-parity driver/i, expression: 'harness', by: 'eval/conformance' },
  { card: '*', match: /expressible in the harness/i, expression: 'harness', by: 'eval/coverage' },
  { card: '*', match: /fails the build|safety regression/i, expression: 'harness', by: 'eval/findings' },

  // --- expressed by the owning package, gated by this harness -------------------------
  { card: '*', match: /conformance suite/i, expression: 'package', by: 'shared conformance suite' },
  { card: '*', match: /`?pnpm test`? green offline/i, expression: 'package', by: 'vitest, offline guard' },

  // --- human judgement ----------------------------------------------------------------
  { card: '*', match: /kill-or-continue verdict/i, expression: 'manual', by: 'human reads FINDINGS.md' },
  { card: '*', match: /recommendation|input to a human decision/i, expression: 'manual', by: 'human decision' },
  { card: '*', match: /documented|records|states which|names which|presents a/i, expression: 'manual', by: 'human reads the finding' },
  { card: '*', match: /measured:|estimated for each candidate/i, expression: 'manual', by: 'spike measurement' },

  // --- everything else a package proves in its own tests -------------------------------
  { card: '*', match: /.*/, expression: 'package', by: "the owning package's tests" },
];

const CHECKBOX = /^- \[( |x|X)\] (.+)$/;

/** Read every card's exit criteria straight from the board. */
export function readCardCriteria(repoRoot: string): CardCriterion[] {
  const dir = join(repoRoot, 'board', 'packages');
  const criteria: CardCriterion[] = [];

  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
    const card = file.split('-')[0] ?? file;
    const text = readFileSync(join(dir, file), 'utf8');

    let inCriteria = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('## ')) {
        inCriteria = /exit criteria/i.test(line);
        continue;
      }
      if (!inCriteria) continue;

      const hit = CHECKBOX.exec(line);
      if (hit === null) continue;
      criteria.push({ card, text: stripMarkdown(hit[2] ?? ''), ticked: (hit[1] ?? ' ') !== ' ' });
    }
  }
  return criteria;
}

export function classify(criteria: readonly CardCriterion[]): CoverageReport {
  const classified = criteria.map((criterion): ClassifiedCriterion => {
    const rule = RULES.find(
      (candidate) =>
        (candidate.card === '*' || candidate.card === criterion.card) && candidate.match.test(criterion.text),
    );
    return rule === undefined
      ? { ...criterion, expression: null, by: 'unclassified' }
      : { ...criterion, expression: rule.expression, by: rule.by };
  });

  const byExpression: Record<Expression, number> = { harness: 0, package: 0, manual: 0 };
  for (const item of classified) {
    if (item.expression !== null) byExpression[item.expression] += 1;
  }

  return {
    criteria: classified,
    unclassified: classified.filter((item) => item.expression === null),
    byExpression,
  };
}

export function coverageFor(repoRoot: string): CoverageReport {
  return classify(readCardCriteria(repoRoot));
}

/** Strip the emphasis and code markers the cards use, so rules match on the words. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
