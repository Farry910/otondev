# S1 — Event Ingress and Dedupe

The front door. Contracts §2, as one ordering:

> Ingress acknowledges only after authentication, dedupe persistence, and durable enqueue
> succeed. Duplicate events return the existing canonical event ID. Out-of-order source
> versions are retained but do not silently roll state backward.

## The ordering is the contract

`ingest()` reads top to bottom as a series of refusals, and the acknowledgement is unreachable
except by passing all of them:

1. **size** — first, because every step below touches the bytes and an oversized body is a
   cheap way to make an expensive verifier work hard;
2. **schema major** — unknown majors fail closed rather than being normalised optimistically;
3. **authentication** — HMAC over the *raw body bytes*, never over re-serialised JSON;
4. **replay window** — after the signature, so an unauthenticated caller learns nothing from
   the difference between "stale timestamp" and "wrong signature";
5. **dedupe reservation** — mints the canonical event id, once;
6. **store → enqueue → commit** — and only then, acknowledge.

## Two-phase dedupe, and why

The exit criterion *"a crash between persist and ack neither loses nor duplicates an
acknowledged event"* cannot be met with a single-phase ledger. Write-then-enqueue loses the
event if the process dies before the enqueue; enqueue-then-write duplicates it if the process
dies before the write.

So the dedupe key is **reserved** with its canonical event id up front, and **committed** only
once the enqueue is durable. A redelivery of a reserved-but-uncommitted key *resumes* the same
reservation — same event id, re-enqueued idempotently. `lookupByDedupeKey` reports only
committed rows, because an uncommitted reservation is not an acknowledged event.

## Out-of-order versions

A late event is accepted, stored and enqueued like any other, and separately marked
`superseded` in the ingress ledger; the subject's high-water version does not move. Nothing is
dropped, because "we never saw it" and "we saw it and ignored it" have to stay distinguishable.

Version comparison handles a monotonic integer and a dotted sequence, and **refuses everything
else**. There is deliberately no lexicographic fallback: `"10"` sorts before `"9"` as text, so
a fallback would classify a newer event as older, silently and in the direction that loses data.
An unorderable version moves the watermark in neither direction.

## Untrusted fields

Each source declares which payload paths carry attacker-controlled prose, and `sourceRule()`
refuses to build a rule for an external source that declares none. `IngressEvent.untrusted_fields`
is documented as "never empty by accident"; this is what makes that true on purpose.

## Authentication is a port

How a deployment authenticates a delivery differs legitimately — HMAC, JWT, mTLS from inside
the boundary. What must not differ is that a delivery failing authentication is refused before
anything else looks at it.

`createIngressService` wires `HmacAuthenticator`, strictly. The permissive
`PresenceAuthenticator` exists only under `src/testing/`, exported from nowhere else, because
the shared conformance suite sends a signature literal no HMAC can verify — see the contract
request raised on the S1 card, and the `the default wiring is strict` test that would fail if
the default ever regressed to it.

Tests: `npx vitest run services/ingress`. Typecheck: `npx tsc -b services/ingress --force`
(the root `pnpm run typecheck` does not cover `services/*` yet — raised from S12).
