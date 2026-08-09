/**
 * Delivery authentication as a port.
 *
 * Signature verification and the replay window are one concern — "is this delivery authentic"
 * — and they belong behind one interface because *how* a deployment answers that differs
 * legitimately. A source may sign with an HMAC, present a JWT, or arrive over mTLS from
 * inside the boundary; a local development stack may accept a header. What must not differ is
 * the rule that a delivery which fails authentication is refused before anything else looks
 * at it, and that is in {@link import('./ingress.js').IngressService}, not here.
 *
 * The default is strict. {@link HmacAuthenticator} is what `createIngressService` wires, and a
 * test asserts that — because a permissive authenticator reachable by default is the same
 * defect as no authenticator at all.
 */

import type { Clock, ErrorCode } from '@otondev/contracts';
import type { WebhookDelivery } from '@otondev/sdk';
import { header, verifySignature } from './sources.js';
import type { SourceRule } from './sources.js';

export type AuthOutcome = { ok: true } | { ok: false; code: ErrorCode; detail: string };

export interface DeliveryAuthenticator {
  authenticate(rule: SourceRule, delivery: WebhookDelivery, secret: string | null): AuthOutcome;
}

export interface HmacAuthenticatorOptions {
  clock: Clock;
  /** How far a delivery's own timestamp may be from now, in either direction. */
  replayWindowSeconds: number;
  /**
   * Whether a source that declares a timestamp header must actually send one.
   *
   * True in production: a source that declares the header and then omits it is not a fresh
   * delivery, it is a delivery with the replay defence removed.
   */
  requireTimestamp: boolean;
}

export class HmacAuthenticator implements DeliveryAuthenticator {
  readonly #options: HmacAuthenticatorOptions;

  constructor(options: HmacAuthenticatorOptions) {
    this.#options = options;
  }

  authenticate(rule: SourceRule, delivery: WebhookDelivery, secret: string | null): AuthOutcome {
    const signature = verifySignature(rule, delivery.headers, delivery.body, secret);
    if (!signature.ok) {
      return { ok: false, code: 'SIGNATURE_INVALID', detail: signature.reason };
    }

    // Checked after the signature, never before: an unauthenticated caller must not learn
    // anything from the difference between "your timestamp is stale" and "your signature is
    // wrong".
    const replay = this.#replayVerdict(rule, delivery);
    if (replay !== 'fresh') {
      return { ok: false, code: 'REPLAY_DETECTED', detail: replay };
    }
    return { ok: true };
  }

  #replayVerdict(rule: SourceRule, delivery: WebhookDelivery): 'fresh' | 'stale' | 'future' | 'unparseable' {
    if (rule.timestampHeader === null) return 'fresh';

    const raw = header(delivery.headers, rule.timestampHeader);
    if (raw === undefined) return this.#options.requireTimestamp ? 'unparseable' : 'fresh';

    const sent = parseTimestamp(raw);
    if (sent === null) return 'unparseable';

    const skewMs = this.#options.clock.nowMs() - sent;
    const windowMs = this.#options.replayWindowSeconds * 1000;
    if (skewMs > windowMs) return 'stale';
    // A delivery from the future is just as suspicious: it is how a captured request is made
    // to look fresh for longer than the window allows.
    if (skewMs < -windowMs) return 'future';
    return 'fresh';
  }
}

export function parseTimestamp(raw: string): number | null {
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}
