#!/usr/bin/env node
/**
 * The egress allow-list.
 *
 * "Deny-by-default network with explicit allow-list, and egress logging" (S10) cannot be
 * expressed with container networking alone. A container is either on a network or it is
 * not; Docker has no notion of "may reach registry.npmjs.org and nothing else". So the
 * workspace goes on an `internal` network with no route off the host, and the *only* thing
 * it can reach is this proxy. Everything the workspace wants from outside has to be named.
 *
 * Two properties matter more than the code:
 *
 *   - **The allow-list is a host list, matched exactly or by explicit suffix.** No regex, no
 *     substring matching. `evil-registry.npmjs.org.attacker.test` must not match
 *     `registry.npmjs.org`, and substring matching is how it would.
 *   - **Every decision is logged, including the allowed ones.** A log of denials tells you
 *     what was blocked; the S10 criterion is "egress is logged", and an exfiltration through
 *     an *allowed* host is exactly the case the denial-only log cannot see.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const PORT = Number(process.env.PROXY_PORT ?? 3128);
const LOG_PATH = process.env.EGRESS_LOG ?? '/egress/egress.jsonl';

/** Exact hosts, plus `.suffix` entries that match a domain and its subdomains. */
const ALLOW = (process.env.ALLOW_HOSTS ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

function isAllowed(host) {
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return ALLOW.some((rule) =>
    rule.startsWith('.')
      // A leading dot means "this domain and anything under it", and the boundary is a real
      // label boundary. `endsWith(rule)` alone would admit `notnpmjs.org` for `.npmjs.org`
      // if the rule were written without the dot, which is why the dot is required here.
      ? name === rule.slice(1) || name.endsWith(rule)
      : name === rule,
  );
}

function log(entry) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // The log volume may not be mounted in some runs; stdout is still captured by the driver.
  }
}

const server = http.createServer((request, response) => {
  // Plain HTTP forward-proxy requests. Rare for us — npm is HTTPS — but a workspace that
  // tried one must be logged and refused rather than silently failing.
  let host;
  try {
    host = new URL(request.url).host;
  } catch {
    host = request.headers.host ?? 'unparseable';
  }

  const allowed = isAllowed(host);
  log({ event: 'http', method: request.method, host, url: request.url, decision: allowed ? 'allow' : 'deny' });

  if (!allowed) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end(`egress to ${host} is not on the allow-list\n`);
    return;
  }

  const upstream = http.request(request.url, { method: request.method, headers: request.headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    log({ event: 'http-error', host, error: error.code ?? error.message });
    response.writeHead(502).end();
  });
  request.pipe(upstream);
});

/**
 * HTTPS goes through CONNECT. The proxy sees the host name and nothing else — it cannot read
 * the traffic, and deliberately does not try to. TLS interception would let it log URLs, at
 * the cost of a private CA in the workspace trust store and a proxy that can read every
 * credential in flight. For a sandbox whose entire purpose is containment, that trade is the
 * wrong way round; host-level logging is what this can honestly provide.
 */
server.on('connect', (request, clientSocket, head) => {
  const host = request.url ?? '';
  const [hostname, port = '443'] = host.split(':');
  const allowed = isAllowed(hostname);
  log({ event: 'connect', host: hostname, port: Number(port), decision: allowed ? 'allow' : 'deny' });

  if (!allowed) {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.end();
    return;
  }

  const upstream = net.connect(Number(port), hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (error) => {
    log({ event: 'connect-error', host: hostname, error: error.code ?? error.message });
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  log({ event: 'proxy-start', port: PORT, allow: ALLOW });
});
