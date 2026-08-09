import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import { ArtifactId, EventId } from './ids.js';
import { BoundedText, Rfc3339Utc, Rfc3339WithOffset } from './primitives.js';

/**
 * Canonical ingress event, contracts §2.
 *
 *   "Ingress acknowledges only after authentication, dedupe persistence, and durable enqueue
 *    succeed. Duplicate events return the existing canonical event ID. Out-of-order source
 *    versions are retained but do not silently roll state backward."
 *
 * Two fields carry most of the weight:
 *
 * `untrusted_fields` names the parts of the payload that came from a human or a third party.
 * Everything downstream — the context builder's section 5, the memory ingestion pipeline,
 * the executor's tool-output handling — keys off it. An event that forgets to mark its
 * description untrusted is how a ticket comment becomes an instruction.
 *
 * `subject.version` is what makes out-of-order delivery survivable: it is the source's own
 * version of the subject, so a late-arriving older event is recognisable as older rather
 * than newer.
 */

export const EVENT_SOURCE_SYSTEMS = ['github', 'jira', 'slack', 'ci', 'calendar', 'operator', 'internal'] as const;

export const EventSource = z.object({
  system: z.enum(EVENT_SOURCE_SYSTEMS),
  /** Which installation/tenant of that system. Part of the dedupe key. */
  installation_id: z.string().min(1).max(128),
  /** The vendor's own event id, opaque to us. */
  event_id: z.string().min(1).max(256),
  /** The source's timestamp, with its offset preserved (contracts §1). */
  occurred_at: Rfc3339WithOffset,
  /** Who the signature proved this came from — not who typed it. */
  authenticated_principal: z.string().min(1).max(256),
});
export type EventSource = z.infer<typeof EventSource>;

export const EventSubject = z.object({
  type: z.enum(['ticket', 'pull_request', 'issue', 'commit', 'message', 'run', 'meeting']),
  id: z.string().min(1).max(256),
  /** The source system's version of the subject, as a string: sources are not consistent. */
  version: z.string().min(1).max(64),
});
export type EventSubject = z.infer<typeof EventSubject>;

export const IngressEvent = envelopeExtend({
  schema: z.literal('agentdev.event.v2'),
  id: EventId,
  source: EventSource,
  /** Dotted, source-normalised: `ticket.created`, `pull_request.review_requested`. */
  kind: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).max(128),
  subject: EventSubject,
  /** The immutable normalized payload lives in the artifact store, never inline. */
  payload_ref: ArtifactId,
  /** Payload paths whose content is attacker-controlled. Never empty by accident. */
  untrusted_fields: z.array(BoundedText(128)).max(64),
  /** `<tenant>:<system>:<installation>:<vendor event id>` — contracts §2. */
  dedupe_key: z.string().min(5).max(768),
  received_at: Rfc3339Utc,
});
export type IngressEvent = z.infer<typeof IngressEvent>;

/**
 * The one correct way to build a dedupe key. Dedupe is only as good as the agreement between
 * the writer and the reader on what "the same event" means, so there is exactly one function.
 */
export function dedupeKey(parts: {
  tenant_id: string;
  system: string;
  installation_id: string;
  source_event_id: string;
}): string {
  return `${parts.tenant_id}:${parts.system}:${parts.installation_id}:${parts.source_event_id}`;
}
