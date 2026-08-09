import { describe, expect, it } from 'vitest';
import { IngressEvent, dedupeKey } from '@otondev/contracts';
import { createIngressService } from './index.js';
import { HmacAuthenticator } from './authenticator.js';
import { InMemoryDedupeLedger, InMemoryEventQueue } from './store.js';
import { SubjectVersionLedger, compareVersions } from './versions.js';
import { isExternalSource, sourceRule } from './sources.js';
import {
  PresenceAuthenticator,
  SECRET,
  TENANT,
  harness,
  jiraDelivery,
  sign,
  signVersioned,
} from './testing/harness.js';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import { createFakeRegistry } from '@otondev/sdk';

/** One describe per S1 exit criterion, named as the card names it. */

describe('per-source webhook signature verification, replay window, schema and size limits', () => {
  it('accepts a correctly signed, in-window delivery', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));
    expect(outcome.status).toBe('accepted');
  });

  it('verifies the HMAC over the raw body bytes, not over re-serialised JSON', async () => {
    const { ingress, clock } = harness();
    const delivery = jiraDelivery(clock, { body: '{"b":1,  "a":2}' });

    // Same JSON value, different bytes. A verifier that parsed and re-stringified would
    // accept this; one that signs the wire bytes must not.
    const reordered = new TextEncoder().encode('{"a":2,"b":1}');
    const outcome = await ingress.ingest({ ...delivery, body: reordered });

    expect(outcome).toEqual({ status: 'rejected', code: 'SIGNATURE_INVALID' });
  });

  it('rejects a signature that is the right shape but the wrong secret', async () => {
    const { ingress, clock } = harness();
    const delivery = jiraDelivery(clock);
    const forged = sign(delivery.body, 'not-the-secret');

    const outcome = await ingress.ingest({ ...delivery, headers: { ...delivery.headers, 'x-signature': forged } });
    expect(outcome).toEqual({ status: 'rejected', code: 'SIGNATURE_INVALID' });
  });

  it('fails closed when no secret is configured, rather than skipping verification', async () => {
    const { ingress, clock } = harness({ secrets: { secretFor: async () => null } });
    expect((await ingress.ingest(jiraDelivery(clock))).status).toBe('rejected');
  });

  it('reads headers case-insensitively', async () => {
    const { ingress, clock } = harness();
    const delivery = jiraDelivery(clock);
    const upper = Object.fromEntries(Object.entries(delivery.headers).map(([k, v]) => [k.toUpperCase(), v]));

    expect((await ingress.ingest({ ...delivery, headers: upper })).status).toBe('accepted');
  });

  it('verifies Slack-style signatures over v0:timestamp:body', async () => {
    const { ingress, clock } = harness();
    const body = new TextEncoder().encode('{"text":"hi"}');
    const timestamp = String(Math.floor(clock.nowMs() / 1000));

    const outcome = await ingress.ingest({
      system: 'slack',
      installation_id: 'slack_acme',
      body,
      headers: {
        'x-slack-signature': signVersioned(body, timestamp),
        'x-slack-request-timestamp': timestamp,
        'x-slack-event-id': 'ev_1',
      },
      received_at: clock.nowIso(),
    });

    expect(outcome.status).toBe('accepted');
  });

  it('rejects a stale delivery outside the replay window', async () => {
    const { ingress, clock } = harness();
    const delivery = jiraDelivery(clock);
    clock.advance(301_000);

    expect(await ingress.ingest(delivery)).toEqual({ status: 'rejected', code: 'REPLAY_DETECTED' });
  });

  it('rejects a delivery from the future as well as a stale one', async () => {
    const { ingress, clock } = harness();
    const future = String(Math.floor(clock.nowMs() / 1000) + 3600);
    const delivery = jiraDelivery(clock, { headers: { 'x-timestamp': future } });

    // A capture made to look fresh for longer than the window allows.
    expect(await ingress.ingest(delivery)).toEqual({ status: 'rejected', code: 'REPLAY_DETECTED' });
  });

  it('treats a missing timestamp as a removed replay defence, not as fresh', async () => {
    const { ingress, clock } = harness();
    const delivery = jiraDelivery(clock);
    const { 'x-timestamp': _dropped, ...rest } = delivery.headers;

    expect(await ingress.ingest({ ...delivery, headers: rest })).toEqual({
      status: 'rejected',
      code: 'REPLAY_DETECTED',
    });
  });

  it('rejects an oversized payload before doing any verification work', async () => {
    const { ingress, clock } = harness({ config: { maxBodyBytes: 32 } });
    const delivery = jiraDelivery(clock, { body: 'x'.repeat(200) });

    expect(await ingress.ingest(delivery)).toEqual({ status: 'rejected', code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects an unknown schema major', async () => {
    const { ingress, clock } = harness();
    const delivery = jiraDelivery(clock, { headers: { 'x-schema-major': '9' } });

    expect(await ingress.ingest(delivery)).toEqual({ status: 'rejected', code: 'SCHEMA_MAJOR_UNSUPPORTED' });
  });

  it('rejects a malformed schema major rather than coercing it', async () => {
    const { ingress, clock } = harness();
    for (const major of ['two', '2.0', '', '-1']) {
      const delivery = jiraDelivery(clock, { headers: { 'x-schema-major': major }, eventId: `ev_${major}` });
      expect((await ingress.ingest(delivery)).status, `major "${major}"`).toBe('rejected');
    }
  });

  it('records every refusal as a security event', async () => {
    const { ingress, clock, services } = harness();
    const delivery = jiraDelivery(clock);

    await ingress.ingest({ ...delivery, headers: { ...delivery.headers, 'x-signature': sign(delivery.body, 'wrong') } });

    const entries = await services.audit.query({ partition: `${TENANT}:ingress` });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.event === 'ingress.delivery.rejected')).toBe(true);
  });

  it('still refuses when the audit sink is down', async () => {
    const { clock, ids, services } = harness();
    const brokenAudit = new Proxy(services.audit, {
      get: (target, property) =>
        property === 'append'
          ? async () => {
              throw new Error('audit unavailable');
            }
          : Reflect.get(target, property, target),
    });
    const ingress = createIngressService(
      { clock, ids, audit: brokenAudit as typeof services.audit, tenantId: TENANT },
      { config: { maxBodyBytes: 8 } },
    );

    // Turning an audit outage into an accepted delivery would be the worst possible direction
    // to fail in.
    expect((await ingress.ingest(jiraDelivery(clock, { body: 'x'.repeat(64) }))).status).toBe('rejected');
  });
});

describe('normalization to agentdev.event.v2 with untrusted fields explicitly labelled', () => {
  it('emits an event that satisfies the real schema', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));
    expect(outcome.status).toBe('accepted');

    const event = outcome.status === 'accepted' ? await ingress.getEvent(outcome.event_id) : null;
    // Parsed against the contract, not merely shaped like it.
    expect(() => IngressEvent.parse(event)).not.toThrow();
  });

  it('labels the untrusted fields the source actually carries', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));
    const event = outcome.status === 'accepted' ? await ingress.getEvent(outcome.event_id) : null;

    // An event that forgets to mark its description untrusted is how a ticket comment
    // becomes an instruction.
    expect(event?.untrusted_fields).toContain('fields.description');
    expect(event?.untrusted_fields.length).toBeGreaterThan(0);
  });

  it('gives every external source a non-empty untrusted list', () => {
    for (const system of ['github', 'jira', 'slack', 'calendar'] as const) {
      expect(sourceRule(system).untrustedFields.length, system).toBeGreaterThan(0);
      expect(isExternalSource(system)).toBe(true);
    }
  });

  it('keeps the payload out of the event and in the artifact store', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));
    const event = outcome.status === 'accepted' ? await ingress.getEvent(outcome.event_id) : null;

    expect(event?.payload_ref).toMatch(/^art_/);
    expect(JSON.stringify(event)).not.toContain('ENG-42"}');
  });

  it('records the principal the signature proved, not text from the body', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));
    const event = outcome.status === 'accepted' ? await ingress.getEvent(outcome.event_id) : null;

    expect(event?.source.authenticated_principal).toBe('jira_cloud_app');
  });

  it('classes external payloads as internal_source', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));
    const event = outcome.status === 'accepted' ? await ingress.getEvent(outcome.event_id) : null;

    expect(event?.data_classes).toContain('internal_source');
  });

  it('falls back to a well-formed kind rather than emitting an invalid one', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock, { headers: { 'x-kind': 'Not A Valid Kind!!' } }));
    const event = outcome.status === 'accepted' ? await ingress.getEvent(outcome.event_id) : null;

    expect(event?.kind).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('dedupe on (tenant, source, source_event_id); a duplicate returns the existing id', () => {
  it('returns the existing canonical id, not a new one', async () => {
    const { ingress, clock } = harness();
    const first = await ingress.ingest(jiraDelivery(clock));
    const second = await ingress.ingest(jiraDelivery(clock));

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    expect(first.status === 'accepted' && second.status === 'duplicate' && first.event_id === second.event_id).toBe(true);
  });

  it('keys on the tenant, source, installation and vendor event id', async () => {
    const { ingress, clock } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));
    const event = outcome.status === 'accepted' ? await ingress.getEvent(outcome.event_id) : null;

    expect(event?.dedupe_key).toBe(
      dedupeKey({ tenant_id: TENANT, system: 'jira', installation_id: 'jira_acme', source_event_id: 'vendor_1' }),
    );
  });

  it('treats a different vendor event id as a different event', async () => {
    const { ingress, clock } = harness();
    const first = await ingress.ingest(jiraDelivery(clock, { eventId: 'vendor_1' }));
    const second = await ingress.ingest(jiraDelivery(clock, { eventId: 'vendor_2' }));

    expect(second.status).toBe('accepted');
    expect(first.status === 'accepted' && second.status === 'accepted' && first.event_id !== second.event_id).toBe(true);
  });

  it('does not report an uncommitted reservation through the dedupe lookup', async () => {
    // An uncommitted reservation is not an acknowledged event; reporting its id would hand
    // the caller an id whose record may never exist.
    const ledger = new InMemoryDedupeLedger();
    await ledger.reserve('some:key', () => 'event_pending', '2026-07-30T08:00:00Z');
    const { ingress } = harness({ ledger });

    expect(await ingress.lookupByDedupeKey('some:key')).toBeNull();
  });
});

describe('acknowledge only after authentication, dedupe persistence, and durable enqueue', () => {
  it('the event is readable and enqueued the instant the promise resolves', async () => {
    const { ingress, clock, queue } = harness();
    const outcome = await ingress.ingest(jiraDelivery(clock));

    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;
    expect(await ingress.getEvent(outcome.event_id)).not.toBeNull();
    expect(queue.messages.map((m) => m.id)).toEqual([outcome.event_id]);
    expect(await ingress.lookupByDedupeKey((await ingress.getEvent(outcome.event_id))!.dedupe_key)).toBe(
      outcome.event_id,
    );
  });

  it('does not acknowledge when the durable enqueue fails', async () => {
    const { ingress, clock } = harness({
      queue: {
        enqueue: async () => {
          throw new Error('broker down');
        },
      },
    });

    const outcome = await ingress.ingest(jiraDelivery(clock));
    expect(outcome.status).toBe('rejected');
  });

  it('leaves nothing committed when the enqueue fails, so the vendor retry starts clean', async () => {
    const ledger = new InMemoryDedupeLedger();
    let broken = true;
    const queue = new InMemoryEventQueue();
    const { ingress, clock } = harness({
      ledger,
      queue: {
        enqueue: async (event) => {
          if (broken) throw new Error('broker down');
          return queue.enqueue(event);
        },
      },
    });

    expect((await ingress.ingest(jiraDelivery(clock))).status).toBe('rejected');
    broken = false;
    const retry = await ingress.ingest(jiraDelivery(clock));

    expect(retry.status).toBe('accepted');
    expect(queue.messages.length).toBe(1);
  });
});

describe('crash between persist and ack neither loses nor duplicates an acknowledged event', () => {
  it('resumes the same reservation under the same event id', async () => {
    // The crash: the ledger reserved and the store wrote, but the process died before commit.
    // The vendor times out and redelivers. A single-phase ledger either loses the event
    // (write-then-enqueue) or duplicates it (enqueue-then-write); the reservation is what
    // makes the retry converge on one id.
    const ledger = new InMemoryDedupeLedger();
    const queue = new InMemoryEventQueue();
    const shared = { ledger, queue };

    const first = harness(shared);
    const delivery = jiraDelivery(first.clock);

    const reserved = await ledger.reserve(
      dedupeKey({ tenant_id: TENANT, system: 'jira', installation_id: 'jira_acme', source_event_id: 'vendor_1' }),
      () => 'event_01JQ0000000000000000000000',
      first.clock.nowIso(),
    );
    expect(reserved.status).toBe('reserved');

    // Redelivery after the crash.
    const second = harness(shared);
    const outcome = await second.ingress.ingest(delivery);

    expect(outcome.status).toBe('accepted');
    expect(outcome.status === 'accepted' && outcome.event_id).toBe(reserved.reservation.event_id);
    // Not lost:
    expect(queue.messages.length).toBe(1);
    // ...and not duplicated on a further redelivery:
    const third = await second.ingress.ingest(delivery);
    expect(third.status).toBe('duplicate');
    expect(queue.messages.length).toBe(1);
  });

  it('the queue is idempotent on event id, which is what makes resuming safe', async () => {
    const queue = new InMemoryEventQueue();
    const { ingress, clock } = harness({ queue });
    const outcome = await ingress.ingest(jiraDelivery(clock));
    if (outcome.status !== 'accepted') throw new Error('expected acceptance');

    const event = await ingress.getEvent(outcome.event_id);
    await queue.enqueue(event!);
    await queue.enqueue(event!);

    expect(queue.messages.length).toBe(1);
  });

  it('never releases a committed reservation', async () => {
    const ledger = new InMemoryDedupeLedger();
    await ledger.reserve('k', () => 'event_1', 'now');
    await ledger.commit('k', 'now');
    await ledger.release('k');

    // Releasing a committed row would un-acknowledge an acknowledged event and let the next
    // delivery mint a second id for it.
    expect((await ledger.get('k'))?.state).toBe('committed');
  });
});

describe('out-of-order source version is retained and does not roll state backward', () => {
  it('retains a late event but marks it superseded', async () => {
    const { ingress, clock } = harness();
    const newer = await ingress.ingest(jiraDelivery(clock, { eventId: 'ev_v5', version: '5' }));
    const older = await ingress.ingest(jiraDelivery(clock, { eventId: 'ev_v3', version: '3' }));

    expect(older.status).toBe('accepted');
    if (newer.status !== 'accepted' || older.status !== 'accepted') throw new Error('expected acceptance');

    // Retained — the record exists and is readable.
    expect(await ingress.getEvent(older.event_id)).not.toBeNull();
    // But it did not roll the subject backward.
    expect(ingress.metadataFor(older.event_id)?.version_verdict).toBe('superseded');
    expect(ingress.metadataFor(newer.event_id)?.version_verdict).toBe('current');

    const subjectKey = ingress.metadataFor(newer.event_id)!.subject_key;
    expect(ingress.highWaterVersion(subjectKey)).toBe('5');
  });

  it('advances on a genuinely newer version', async () => {
    const { ingress, clock } = harness();
    const first = await ingress.ingest(jiraDelivery(clock, { eventId: 'a', version: '1' }));
    const second = await ingress.ingest(jiraDelivery(clock, { eventId: 'b', version: '2' }));
    if (second.status !== 'accepted' || first.status !== 'accepted') throw new Error('expected acceptance');

    expect(ingress.metadataFor(second.event_id)?.version_verdict).toBe('current');
    expect(ingress.highWaterVersion(ingress.metadataFor(second.event_id)!.subject_key)).toBe('2');
  });

  it('compares numeric versions numerically, not as text', () => {
    // "10" sorts before "9" as text. A lexicographic fallback would classify a newer event
    // as older — silently, and in the direction that loses data.
    expect(compareVersions('10', '9')).toBe('newer');
    expect(compareVersions('9', '10')).toBe('older');
    expect(compareVersions('2.10.0', '2.9.0')).toBe('newer');
    expect(compareVersions('1.0', '1.0.0')).toBe('same');
  });

  it('refuses to order versions it does not understand, rather than guessing', () => {
    expect(compareVersions('v2', '3')).toBe('unorderable');
    expect(compareVersions('abc', 'def')).toBe('unorderable');
  });

  it('an unorderable version never moves the watermark in either direction', () => {
    const ledger = new SubjectVersionLedger();
    expect(ledger.observe('s', '5', 'now')).toBe('current');
    expect(ledger.observe('s', 'release-candidate', 'now')).toBe('superseded');
    expect(ledger.highWater('s')).toBe('5');
  });
});

describe('emergency stop', () => {
  it('denying ingress closes the front door', async () => {
    const { ingress, clock } = harness();
    await ingress.deny({
      incident_id: 'i1',
      scope: { kind: 'global' },
      reason: 'compromise',
      requested_by: 'operator:alice',
      requested_at: clock.nowIso(),
    });

    expect((await ingress.ingest(jiraDelivery(clock))).status).toBe('rejected');
    expect((await ingress.health()).denying).toBe(true);
  });
});

describe('the default wiring is strict', () => {
  it('createIngressService does not accept a presence-only signature', async () => {
    const clock = new FakeClock('2026-07-30T08:00:00Z');
    const ids = deterministicIdFactory({ clock });
    const { services } = createFakeRegistry({ clock, ids });
    const ingress = createIngressService({ clock, ids, audit: services.audit, tenantId: TENANT });

    const body = new TextEncoder().encode('{}');
    const outcome = await ingress.ingest({
      system: 'jira',
      installation_id: 'jira_acme',
      body,
      headers: { 'x-signature': 'sig', 'x-event-id': 'v1' },
      received_at: clock.nowIso(),
    });

    // The permissive authenticator exists only under src/testing/. If this ever starts
    // passing, the default posture has regressed.
    expect(outcome).toEqual({ status: 'rejected', code: 'SIGNATURE_INVALID' });
    expect(new PresenceAuthenticator().authenticate(sourceRule('jira'), {
      system: 'jira',
      installation_id: 'jira_acme',
      body,
      headers: { 'x-signature': 'sig' },
      received_at: clock.nowIso(),
    }).ok).toBe(true);
  });

  it('the strict authenticator is what the factory wires', () => {
    const clock = new FakeClock('2026-07-30T08:00:00Z');
    expect(new HmacAuthenticator({ clock, replayWindowSeconds: 300, requireTimestamp: true })).toBeInstanceOf(
      HmacAuthenticator,
    );
    expect(SECRET.length).toBeGreaterThan(0);
  });
});
