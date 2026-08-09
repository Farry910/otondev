# Contract request - S1

- **Raised:** 2026-08-09 15:05
- **Card:** S1
- **By:** agent-sess-ec39663a
- **Status:** open

## Need

The shared ingress conformance suite cannot distinguish a real signature verifier from a presence check. CONFORMANCE_SUITES.ingress sends 'x-signature: sig' -- a literal no HMAC can verify -- on both of its accepting cases; it sends that header for a GitHub delivery, whose real header is x-hub-signature-256; and it sends no timestamp, so any replay window rejects it. A correct verifier fails all three cases. S1 therefore satisfies 'fake and implementation both pass the shared conformance suite' by wiring a PresenceAuthenticator for the suite run only. That double is confined to services/ingress/src/testing/, is exported from nowhere else, and a test ('the default wiring is strict') asserts createIngressService refuses exactly the delivery the suite accepts. The real HMAC path -- raw-body signing, Slack v0:timestamp:body, wrong-secret, case-insensitive headers, stale/future/missing timestamp -- is covered in ingress.test.ts. Suggested fix: give the suite a 'signing' capability so a subject can declare it, and add cases that sign with a secret the subject supplies; today the suite would pass against a service with authentication removed entirely.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->