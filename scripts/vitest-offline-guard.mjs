import http from 'node:http';
import https from 'node:https';

/**
 * Offline gate (implementation-plan §1 property 6).
 *
 * "Tests run green with all peers faked and no network" is only true if something enforces
 * it. Convention does not survive a session that adds one convenient live call at 2am, and
 * the failure mode is a suite that passes on a laptop and hangs in CI. So outbound HTTP is
 * made to throw with a message that says what to do instead.
 *
 * This does not sandbox the process — a determined test can still open a raw socket. It
 * closes the path people actually take by accident.
 */
const OFFLINE_MESSAGE =
  'Network access is disabled in tests. Consume the peer through its @otondev/sdk interface ' +
  'backed by a fake, or record a fixture. See implementation-plan §1 property 6.';

function refuse() {
  throw new Error(OFFLINE_MESSAGE);
}

globalThis.fetch = () => Promise.reject(new Error(OFFLINE_MESSAGE));

for (const mod of [http, https]) {
  mod.request = refuse;
  mod.get = refuse;
}
