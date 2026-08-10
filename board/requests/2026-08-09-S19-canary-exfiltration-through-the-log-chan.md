# Contract request - S19

- **Raised:** 2026-08-09 18:20
- **Card:** S19
- **By:** agent-sess-ec39663a
- **Status:** open

## Need

Canary exfiltration through the log channel: a secret in a free-text field is not redacted. Found by the S19 harness on its first run, against the real @otondev/sdk logger -- not hypothesised. createLogger redacts via contracts' redact(), which keys on FIELD NAME (contracts section 1: 'Logs redact/hide fields by schema, not only string matching'). So logger.info('x', { token: SECRET }) is redacted, but logger.warn('x', { detail: 'value=' + SECRET }) reaches the sink verbatim -- and 'detail'/'message'/'reason' are exactly where an untrusted ticket body or a provider error string gets quoted. The canary probe in eval/src/harness.ts reproduces it in two lines. Owner is W0 (packages/sdk/src/observability/logger.ts + packages/contracts/src/redaction.ts), both shared files I must not edit. Recorded in eval/src/gaps.ts as a KNOWN GAP so it is reported on every harness run and does not fail the build -- a pre-existing defect is not a regression, and turning main red on the day the harness lands gets the harness disabled rather than the gap fixed. Any NEW leak still fails the build, and a test asserts that. Suggested fix: pattern-scan string values for high-entropy/credential shapes in addition to field-name redaction, or forbid raw interpolation into log fields.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->