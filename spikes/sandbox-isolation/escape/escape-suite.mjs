#!/usr/bin/env node
/**
 * The escape suite. Runs *inside* the workspace and tries to reach everything the workspace
 * must not reach:
 *
 *   host socket · vault · cloud metadata endpoint · LAN · another workspace
 *
 * Written in plain Node with no dependencies, deliberately. If this needed curl or netcat,
 * a stripped image would make every probe "fail" for the wrong reason and the suite would
 * report perfect isolation on a sandbox that had none. Node is the toolchain the worker
 * already has, so a probe that cannot connect really did fail to connect.
 *
 * Every probe reports `reached: true|false` plus how it failed, because the distinction
 * between "connection refused" and "no route to host" is the difference between a closed
 * port and an enforced boundary.
 */
import net from 'node:net';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import http from 'node:http';

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 3000);

/** A TCP connect that always settles, and says why it did not. */
function tcpProbe(host, port, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    const done = (reached, detail) => {
      socket.destroy();
      resolve({ reached, detail, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, `connected to ${host}:${port}`));
    socket.once('timeout', () => done(false, 'timed out (no route, or silently dropped)'));
    socket.once('error', (error) => done(false, `${error.code ?? error.name}: ${error.message}`));
    socket.connect(port, host);
  });
}

async function probe(name, target, fn) {
  try {
    const result = await fn();
    return { name, target, ...result };
  } catch (error) {
    return { name, target, reached: false, detail: `${error.code ?? error.name}: ${error.message}`, ms: 0 };
  }
}

/**
 * The Docker socket is the canonical container escape: reaching it is equivalent to root on
 * the host, because it can start a new container with the host filesystem mounted.
 * Checked twice — the file must not be present, and if it is, it must not answer.
 */
async function hostSocketProbe() {
  const path = '/var/run/docker.sock';
  if (!fs.existsSync(path)) {
    return { reached: false, detail: `${path} is not present in the mount namespace` };
  }
  return new Promise((resolve) => {
    const request = http.request(
      { socketPath: path, path: '/version', method: 'GET', timeout: TIMEOUT_MS },
      (response) => {
        resolve({ reached: true, detail: `docker API answered HTTP ${response.statusCode} — this is host root` });
        response.destroy();
      },
    );
    request.on('timeout', () => { request.destroy(); resolve({ reached: false, detail: 'socket present but did not answer' }); });
    request.on('error', (error) => resolve({ reached: false, detail: `socket present but unusable: ${error.code}` }));
    request.end();
  });
}

async function main() {
  const peer = process.env.PEER_WORKSPACE_ADDR ?? '';
  const vault = process.env.VAULT_ADDR ?? 'host.docker.internal:8200';
  const lan = process.env.LAN_ADDR ?? 'host.docker.internal:8899';

  const [vaultHost, vaultPort] = vault.split(':');
  const [lanHost, lanPort] = lan.split(':');

  const probes = [
    probe('host-socket', '/var/run/docker.sock', hostSocketProbe),

    // The credential store. security-and-credentials.md is explicit that the broker is the
    // only component permitted to retrieve secrets; a workspace that can open a TCP session
    // to the vault has made that a convention rather than a boundary.
    probe('vault', vault, () => tcpProbe(vaultHost, Number(vaultPort))),

    // 169.254.169.254 is the cloud instance metadata service on AWS, GCP and Azure. It hands
    // out instance role credentials to anything that asks, without authentication. On a cloud
    // host this single address is the most valuable thing a sandbox can fail to block.
    probe('cloud-metadata', '169.254.169.254:80', () => tcpProbe('169.254.169.254', 80, 2000)),

    probe('lan-host-service', lan, () => tcpProbe(lanHost, Number(lanPort))),

    // The default gateway is the workspace's route to everything else on the network. If it
    // answers, "deny by default" is not in force.
    probe('default-gateway', 'default route', async () => {
      const gateway = readDefaultGateway();
      if (gateway === null) return { reached: false, detail: 'no default route in this namespace' };
      const result = await tcpProbe(gateway, 22, 2000);
      return { ...result, detail: `gateway ${gateway}: ${result.detail}` };
    }),

    probe('public-internet', '1.1.1.1:443', () => tcpProbe('1.1.1.1', 443, 2000)),

    probe('dns-resolution', 'registry.npmjs.org', async () => {
      const addresses = await dns.resolve4('registry.npmjs.org');
      return { reached: true, detail: `resolved to ${addresses.join(', ')}` };
    }),
  ];

  if (peer !== '') {
    const [peerHost, peerPort] = peer.split(':');
    probes.push(probe('another-workspace', peer, () => tcpProbe(peerHost, Number(peerPort))));
  }

  const results = await Promise.all(probes);
  const reached = results.filter((r) => r.reached);

  process.stdout.write(`${JSON.stringify({
    schema: 'otondev.spike.escape-suite.v1',
    ranAt: new Date().toISOString(),
    contained: reached.length === 0,
    reachedCount: reached.length,
    results,
  }, null, 2)}\n`);

  // Non-zero when anything was reachable, so the driver cannot mistake a breach for a pass.
  process.exit(reached.length === 0 ? 0 : 1);
}

/** Parse /proc/net/route for the default gateway, without assuming `ip` is installed. */
function readDefaultGateway() {
  try {
    const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const line of lines) {
      const [, destination, gateway] = line.split(/\s+/);
      if (destination === '00000000' && gateway !== '00000000') {
        const bytes = gateway.match(/../g).reverse().map((h) => parseInt(h, 16));
        return bytes.join('.');
      }
    }
    return null;
  } catch {
    return null;
  }
}

await main();
