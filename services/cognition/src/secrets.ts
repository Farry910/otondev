/**
 * Secret detection over assembled context.
 *
 * cognition-router.md is explicit about the standing of this module: *"Secret detection is
 * defense in depth; the primary protection is that credentials are never fetched into
 * context."* So this is the second line, and it is written to behave like one — it reports
 * what it found and where, and the caller decides. A detector that silently redacted would
 * turn "a credential reached the gateway" into an invisible event, and the fact that it
 * happened at all is a defect worth surfacing loudly rather than papering over.
 *
 * Patterns are deliberately shape-based rather than a vendor list. A vendor list is a
 * maintenance treadmill that is always one provider behind; high-entropy-with-a-known-prefix
 * catches the same things and keeps catching them.
 */

export type SecretKind =
  | 'private_key'
  | 'aws_access_key'
  | 'bearer_token'
  | 'github_token'
  | 'slack_token'
  | 'jwt'
  | 'connection_string'
  | 'generic_assignment';

export interface SecretFinding {
  readonly kind: SecretKind;
  /** Where it was found, as a section label — never the secret itself. */
  readonly section: string;
  /**
   * Enough to locate it in the source, and nothing more. The finding travels into audit
   * records, so a finding that carried the matched text would re-leak the credential into a
   * store with a longer retention than the prompt it came from.
   */
  readonly offset: number;
  readonly length: number;
}

interface Detector {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
}

const DETECTORS: readonly Detector[] = [
  { kind: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer_token', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  {
    kind: 'connection_string',
    pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g,
  },
  {
    // The catch-all: an assignment to a secret-shaped name with a long opaque value. Kept
    // last and kept narrow — it is the one most likely to fire on prose, so it demands both
    // a suggestive key and a value that does not look like a sentence.
    kind: 'generic_assignment',
    pattern: /\b(?:api[_-]?key|secret|password|passwd|token|credential)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{16,})["']?/gi,
  },
];

export function detectSecrets(text: string, section: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const detector of DETECTORS) {
    // `lastIndex` is shared state on a module-level RegExp with /g, so each scan gets its own.
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      findings.push({
        kind: detector.kind,
        section,
        offset: match.index,
        length: match[0].length,
      });
      if (match[0].length === 0) {
        pattern.lastIndex++;
      }
    }
  }
  return findings;
}

/**
 * Replace every finding with a marker of the same shape.
 *
 * Used only when policy says to continue despite a finding. Redaction runs right-to-left so
 * earlier offsets stay valid as the string shrinks.
 */
export function redactSecrets(text: string, findings: readonly SecretFinding[]): string {
  const ordered = [...findings].sort((a, b) => b.offset - a.offset);
  let output = text;
  for (const finding of ordered) {
    output = `${output.slice(0, finding.offset)}[redacted:${finding.kind}]${output.slice(finding.offset + finding.length)}`;
  }
  return output;
}
