import { createHash, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { z } from 'zod';
import {
  ActionClass,
  AutonomyLevel,
  DataClass,
  Environment,
  RiskLevel,
} from '@otondev/contracts';
import { canonicalise } from './normalize.js';
import type { Normalisable } from './normalize.js';

/**
 * Policy bundles.
 *
 * Contracts §5 records `policy_bundle: engineering-pilot-v2@sha256:...` on every decision, and
 * the S4 exit criterion is that decisions are "reproducible from logged inputs plus bundle
 * hash". That only works if the hash is over a canonical encoding — otherwise re-serialising
 * the same bundle produces a different hash and reproducibility becomes unfalsifiable.
 *
 * Bundles are signed because a policy engine that will load any well-formed bundle is a policy
 * engine with no policy. Verification happens at load and the loader **fails closed**: an
 * unsigned bundle, a bundle signed by an unknown key, and a bundle whose bytes changed after
 * signing are all refused, and there is no flag to skip the check. A "development mode" that
 * accepts unsigned bundles is how unsigned bundles reach production.
 */

/** A ceiling on one dimension. Effective autonomy is the minimum across all of them. */
const AutonomyCeilings = z.object({
  /** Per-agent ceiling, keyed by agent id. `*` is the default for unlisted agents. */
  agents: z.record(z.string().min(1), AutonomyLevel),
  /** Per-repository/resource ceiling. Keys are resource refs or `*`. */
  resources: z.record(z.string().min(1), AutonomyLevel),
  environments: z.record(Environment, AutonomyLevel),
  data_classes: z.record(DataClass, AutonomyLevel),
  action_classes: z.record(ActionClass, AutonomyLevel),
  /**
   * The ceiling that applies while an incident is declared. Not a separate mode with its own
   * rules — just one more dimension in the same minimum, which is what stops it from being
   * forgotten in a branch somewhere.
   */
  incident_mode: AutonomyLevel,
});
export type AutonomyCeilings = z.infer<typeof AutonomyCeilings>;

/** What an action costs to attempt, and what a decision may authorise without approval. */
const CostRule = z.object({
  /** Above this, the action requires approval regardless of autonomy. */
  approval_above_usd: z.number().nonnegative(),
  /** Above this, the action is denied outright. */
  deny_above_usd: z.number().nonnegative(),
});

const ActionRule = z.object({
  action: ActionClass,
  /** The lowest effective autonomy that may perform this action unattended. */
  min_autonomy: AutonomyLevel,
  /** Environments this action may target at all. Absent from the list means denied. */
  environments: z.array(Environment).min(1),
  /** Data classes this action may touch. */
  max_data_class: DataClass,
  risk: RiskLevel,
  /** Always require a human approval, whatever the autonomy. */
  always_requires_approval: z.boolean(),
  /** Minimum authentication strength of the approver, when approval is required. */
  minimum_authn_strength: z.enum(['mfa', 'hardware_key', 'signed_command']),
  cost: CostRule,
  /** Constraints copied onto the decision and, from there, onto the capability. */
  constraints: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()])),
});
export type ActionRule = z.infer<typeof ActionRule>;

export const PolicyBundleBody = z.object({
  /** `engineering-pilot-v2` — the name half of the `name@sha256:...` reference. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64),
  /** Monotonic. Two bundles with the same name and version must be byte-identical. */
  version: z.number().int().positive(),
  tenant_id: z.string().min(1),
  ceilings: AutonomyCeilings,
  /**
   * Resources the bundle knows about. An action against a resource not listed here is
   * *unknown*, and unknown denies — see `evaluate.ts`.
   */
  known_resources: z.array(z.string().min(1)).min(1),
  rules: z.array(ActionRule).min(1),
});
export type PolicyBundleBody = z.infer<typeof PolicyBundleBody>;

export const SignedPolicyBundle = z.object({
  body: PolicyBundleBody,
  signature: z.object({
    alg: z.literal('ed25519'),
    key_id: z.string().min(1).max(128),
    /** base64 over the canonical encoding of `body`. */
    value: z.string().min(1),
  }),
});
export type SignedPolicyBundle = z.infer<typeof SignedPolicyBundle>;

export class BundleRejected extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`policy bundle refused (${reason}): ${detail}`);
    this.name = 'BundleRejected';
    this.reason = reason;
  }
}

/** The bytes that get signed and hashed. Canonical, so the hash is stable. */
export function bundleBytes(body: PolicyBundleBody): Buffer {
  return Buffer.from(canonicalise(body as unknown as Normalisable), 'utf8');
}

/** `<name>@sha256:<hex>` — the exact form contracts §5 records on every decision. */
export function bundleRef(body: PolicyBundleBody): string {
  const digest = createHash('sha256').update(bundleBytes(body)).digest('hex');
  return `${body.name}@sha256:${digest}`;
}

/** Sign a bundle body. Used by the bundle-publishing tool and by tests. */
export function signBundle(body: PolicyBundleBody, privateKeyPem: string, keyId: string): SignedPolicyBundle {
  const key = createPrivateKey(privateKeyPem);
  // ed25519 signs the message directly; the algorithm argument must be null.
  const signature = cryptoSign(null, bundleBytes(body), key);
  return { body, signature: { alg: 'ed25519', key_id: keyId, value: signature.toString('base64') } };
}

export interface LoadedBundle {
  body: PolicyBundleBody;
  ref: string;
  keyId: string;
}

/**
 * Verify and load. The only way a bundle enters the service.
 *
 * `trustedKeys` maps key id to a PEM public key. An empty map cannot be used to disable
 * verification — it means nothing is trusted, so everything is refused.
 */
export function loadBundle(
  candidate: unknown,
  trustedKeys: ReadonlyMap<string, string>,
): LoadedBundle {
  const parsed = SignedPolicyBundle.safeParse(candidate);
  if (!parsed.success) {
    throw new BundleRejected(
      'malformed',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`).join('; '),
    );
  }

  const { body, signature } = parsed.data;
  const publicKeyPem = trustedKeys.get(signature.key_id);
  if (publicKeyPem === undefined) {
    throw new BundleRejected('unknown_key', `no trusted key with id "${signature.key_id}"`);
  }

  let verified = false;
  try {
    verified = cryptoVerify(
      null,
      bundleBytes(body),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.value, 'base64'),
    );
  } catch (error) {
    throw new BundleRejected('signature_error', error instanceof Error ? error.message : String(error));
  }
  if (!verified) {
    throw new BundleRejected('bad_signature', `signature by "${signature.key_id}" does not verify over the bundle body`);
  }

  // A bundle that names the same action twice has no single answer for that action, and
  // whichever one wins would depend on array order.
  const seen = new Set<string>();
  for (const rule of body.rules) {
    if (seen.has(rule.action)) {
      throw new BundleRejected('ambiguous', `action "${rule.action}" has more than one rule`);
    }
    seen.add(rule.action);
  }

  for (const rule of body.rules) {
    if (rule.cost.deny_above_usd < rule.cost.approval_above_usd) {
      throw new BundleRejected(
        'incoherent',
        `action "${rule.action}" denies above $${rule.cost.deny_above_usd} but only requires approval above ` +
          `$${rule.cost.approval_above_usd}; the approval band is empty`,
      );
    }
  }

  return { body, ref: bundleRef(body), keyId: signature.key_id };
}
