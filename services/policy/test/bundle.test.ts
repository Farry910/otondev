import { describe, expect, it } from 'vitest';
import { BundleRejected, bundleRef, loadBundle, signBundle } from '../src/bundle.js';
import { keypair, testBundleBody, KEY_ID } from './helpers.js';

describe('signed, versioned policy bundles', () => {
  const { publicKeyPem, privateKeyPem } = keypair();
  const trusted = new Map([[KEY_ID, publicKeyPem]]);
  const body = testBundleBody();

  it('loads a correctly signed bundle and reports the reference contracts §5 records', () => {
    const loaded = loadBundle(signBundle(body, privateKeyPem, KEY_ID), trusted);
    expect(loaded.ref).toMatch(/^engineering-pilot@sha256:[0-9a-f]{64}$/);
    expect(loaded.keyId).toBe(KEY_ID);
  });

  it('produces a stable reference — the same bundle always hashes the same', () => {
    // Reproducibility of a decision rests on this: the bundle hash in an audit record has to
    // still identify the same bundle when someone re-serialises it a year later.
    const reordered = { ...body, tenant_id: body.tenant_id, name: body.name };
    expect(bundleRef(reordered)).toBe(bundleRef(body));
  });

  it('changes the reference when any rule changes', () => {
    const changed = testBundleBody({
      rules: body.rules.map((rule) =>
        rule.action === 'jira.comment' ? { ...rule, min_autonomy: 'A4' as const } : rule,
      ),
    });
    expect(bundleRef(changed)).not.toBe(bundleRef(body));
  });
});

describe('the loader fails closed', () => {
  const { publicKeyPem, privateKeyPem } = keypair();
  const trusted = new Map([[KEY_ID, publicKeyPem]]);
  const body = testBundleBody();

  it('refuses an unsigned bundle', () => {
    expect(() => loadBundle({ body }, trusted)).toThrow(BundleRejected);
  });

  it('refuses a bundle signed by a key it does not trust', () => {
    const stranger = keypair();
    const signed = signBundle(body, stranger.privateKeyPem, 'attacker-key');
    expect(() => loadBundle(signed, trusted)).toThrow(/unknown_key/);
  });

  it('refuses a bundle whose body changed after signing', () => {
    const signed = signBundle(body, privateKeyPem, KEY_ID);
    const tampered = {
      ...signed,
      body: { ...signed.body, ceilings: { ...signed.body.ceilings, incident_mode: 'A4' as const } },
    };
    expect(() => loadBundle(tampered, trusted)).toThrow(/bad_signature/);
  });

  it('refuses a bundle signed by the right key id but the wrong key', () => {
    // The dangerous variant: an attacker who can pick the key *id* but not the key.
    const stranger = keypair();
    expect(() => loadBundle(signBundle(body, stranger.privateKeyPem, KEY_ID), trusted)).toThrow(
      /bad_signature/,
    );
  });

  it('refuses everything when no keys are trusted — an empty map is not a bypass', () => {
    expect(() => loadBundle(signBundle(body, privateKeyPem, KEY_ID), new Map())).toThrow(/unknown_key/);
  });

  it('refuses a bundle with two rules for one action', () => {
    const ambiguous = testBundleBody({ rules: [...body.rules, body.rules[0]!] });
    expect(() => loadBundle(signBundle(ambiguous, privateKeyPem, KEY_ID), trusted)).toThrow(/ambiguous/);
  });

  it('refuses a bundle whose approval band is empty', () => {
    // deny_above < approval_above means there is no cost at which a human could approve.
    const incoherent = testBundleBody({
      rules: body.rules.map((rule) =>
        rule.action === 'jira.comment'
          ? { ...rule, cost: { approval_above_usd: 50, deny_above_usd: 10 } }
          : rule,
      ),
    });
    expect(() => loadBundle(signBundle(incoherent, privateKeyPem, KEY_ID), trusted)).toThrow(/incoherent/);
  });

  it('refuses a malformed bundle rather than filling in defaults', () => {
    expect(() => loadBundle({ body: { name: 'x' }, signature: {} }, trusted)).toThrow(/malformed/);
    expect(() => loadBundle(null, trusted)).toThrow(BundleRejected);
  });
});
