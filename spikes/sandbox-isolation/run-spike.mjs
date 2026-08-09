#!/usr/bin/env node
/**
 * SP2 — sandbox isolation spike driver.
 *
 * Answers delivery-plan Stage-0 spike 2: can a task workspace run a real test suite while
 * being unable to reach the vault, the host, the cloud metadata endpoint, the LAN, or another
 * workspace — with quotas that terminate rather than degrade, and a teardown that survives a
 * crash.
 *
 * Two rules this driver holds itself to, because a spike that gets them wrong produces a
 * confident wrong answer:
 *
 *   1. **Every negative result gets a positive control.** "Could not reach the vault" is
 *      worthless unless the same probe reaches the vault when isolation is deliberately
 *      removed. Otherwise a typo in a hostname reads as perfect containment.
 *   2. **Blocked is not passed.** Anything that could not be attempted on this host profile
 *      is reported as `blocked`, never omitted, so the verdict cannot be assembled from
 *      silence.
 *
 * Usage:  node run-spike.mjs [--keep] [--skip-tests]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const REPO = join(HERE, '..', '..');

const KEEP = process.argv.includes('--keep');
const SKIP_TESTS = process.argv.includes('--skip-tests');

const WORKER_IMAGE = 'otondev-spike/worker:sp2';
const PROXY_IMAGE = 'otondev-spike/proxy:sp2';
const VAULT_PORT = 8200;
const LAN_PORT = 8899;
const PEER_PORT = 9000;

const checks = [];
let stepIndex = 0;

function record(name, status, detail, extra = {}) {
  stepIndex += 1;
  const entry = { step: stepIndex, name, status, detail, ...extra };
  checks.push(entry);
  const mark = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCKED', info: 'INFO' }[status] ?? status.toUpperCase();
  const timing = extra.ms === undefined ? '' : `  ${Math.round(extra.ms)} ms`;
  console.log(`[${String(stepIndex).padStart(2, '0')}] ${mark.padEnd(8)} ${name}${timing}`);
  console.log(`     ${detail.replaceAll('\n', '\n     ')}`);
  return entry;
}

function run(command, args, { input, timeoutMs = 600_000, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      shell: false,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error), ms: Date.now() - started, timedOut });
    });
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  });
}

const docker = (...args) => run('docker', args);

async function quiet(...args) {
  await run('docker', args, { timeoutMs: 60_000 });
}

// ---------------------------------------------------------------- host stand-ins

/**
 * Stand-ins for the vault and a LAN service, listening on the host.
 *
 * Real targets, not mocks inside the sandbox: the question is whether the workspace can open
 * a socket to something outside itself, and only a real listener can answer it. They accept
 * and immediately say hello so a connect that succeeds is unambiguous.
 */
function startHostListener(port, label) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end(`${label} reachable\n`);
    });
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

// ---------------------------------------------------------------- phases

async function preflight() {
  const info = await docker('version', '--format', '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}');
  if (info.code !== 0) {
    record('docker-available', 'fail', info.stderr.trim() || 'docker not reachable');
    return false;
  }
  const [version, dockerOs, arch] = info.stdout.trim().split('|');
  record('docker-available', 'info', `server ${version} (${dockerOs}/${arch}) on ${os.platform()} ${os.release()}`);

  const driver = await docker('info', '--format', '{{.Driver}}|{{.CgroupVersion}}|{{.SecurityOptions}}');
  record('host-profile', 'info', driver.stdout.trim());

  const builds = [
    // Worker context is the spike root so the Dockerfile can COPY the escape suite in.
    [WORKER_IMAGE, ['-f', join(HERE, 'worker', 'Dockerfile'), HERE]],
    [PROXY_IMAGE, [join(HERE, 'proxy')]],
  ];
  for (const [image, contextArgs] of builds) {
    const build = await run('docker', ['build', '-q', '-t', image, ...contextArgs], { timeoutMs: 900_000 });
    if (build.code !== 0) {
      record(`build:${image}`, 'fail', build.stderr.trim().slice(-800));
      return false;
    }
    record(`build:${image}`, 'pass', build.stdout.trim(), { ms: build.ms });
  }
  return true;
}

/** Create a workspace container. Returns its name. */
async function createWorkspace(name, { network = 'none', extraArgs = [], env = {} } = {}) {
  const args = ['create', '--name', name, '--network', network, '--hostname', name];
  // Baseline hardening applied to every workspace, not just the hardened test. If any of
  // these were only present in the run being measured, the measurement would be a fiction.
  args.push(
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs', '/work:rw,exec,nosuid,size=2g,uid=10001,gid=10001',
    '--tmpfs', '/home/worker:rw,exec,nosuid,size=2g,uid=10001,gid=10001',
  );
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(...extraArgs, WORKER_IMAGE);
  const created = await docker(...args);
  if (created.code !== 0) throw new Error(`create ${name}: ${created.stderr.trim()}`);
  return name;
}

async function runEscapeSuite(container, env = {}) {
  const args = ['exec'];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(container, 'node', '/opt/escape-suite.mjs');
  const result = await run('docker', args, { timeoutMs: 120_000 });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* reported below */ }
  return { ...result, parsed };
}

/**
 * The isolated case: `--network none`, no capabilities, read-only root.
 */
async function escapeSuiteIsolated() {
  const name = 'sp2-escape-isolated';
  await quiet('rm', '-f', name);
  try {
    await createWorkspace(name, { network: 'none' });
    await docker('start', name);
    const result = await runEscapeSuite(name, {
      VAULT_ADDR: `host.docker.internal:${VAULT_PORT}`,
      LAN_ADDR: `host.docker.internal:${LAN_PORT}`,
    });

    if (result.parsed === null) {
      return record('escape-suite-isolated', 'fail', `suite produced no JSON: ${result.stderr.trim().slice(-500)}`);
    }
    const reached = result.parsed.results.filter((r) => r.reached);
    return record(
      'escape-suite-isolated',
      reached.length === 0 ? 'pass' : 'fail',
      reached.length === 0
        ? `all ${result.parsed.results.length} probes contained: ` +
          result.parsed.results.map((r) => r.name).join(', ')
        : `REACHED: ${reached.map((r) => `${r.name} (${r.detail})`).join('; ')}`,
      { ms: result.ms, probes: result.parsed.results },
    );
  } finally {
    if (!KEEP) await quiet('rm', '-f', name);
  }
}

/**
 * The positive control.
 *
 * Same suite, same image, isolation deliberately removed: default bridge network, host
 * gateway reachable. If this does not reach the vault and the LAN service, the isolated run
 * proved nothing — the probes would be broken rather than blocked.
 */
async function escapeSuiteControl() {
  const name = 'sp2-escape-control';
  await quiet('rm', '-f', name);
  try {
    const created = await docker(
      'create', '--name', name, '--hostname', name,
      '--add-host', 'host.docker.internal:host-gateway',
      WORKER_IMAGE,
    );
    if (created.code !== 0) throw new Error(created.stderr.trim());
    await docker('start', name);
    const result = await runEscapeSuite(name, {
      VAULT_ADDR: `host.docker.internal:${VAULT_PORT}`,
      LAN_ADDR: `host.docker.internal:${LAN_PORT}`,
    });

    if (result.parsed === null) {
      return record('escape-suite-control', 'fail', `control produced no JSON: ${result.stderr.trim().slice(-500)}`);
    }
    const reached = result.parsed.results.filter((r) => r.reached).map((r) => r.name);
    const provesProbesWork = reached.includes('vault') && reached.includes('lan-host-service');
    return record(
      'escape-suite-control',
      provesProbesWork ? 'pass' : 'fail',
      provesProbesWork
        ? `with isolation removed the same probes reach: ${reached.join(', ')} — so the isolated run's silence is enforcement, not a broken probe`
        : `control reached only [${reached.join(', ') || 'nothing'}]; the probes cannot distinguish blocked from broken`,
      { ms: result.ms, reached },
    );
  } finally {
    if (!KEEP) await quiet('rm', '-f', name);
  }
}

/**
 * Workspace-to-workspace isolation, with its own control.
 *
 * Two workspaces on one shared network reach each other (control); two workspaces each on
 * their own network do not. The pair is what makes "another workspace" a real answer instead
 * of an assumption about how Docker networks happen to be configured.
 */
async function workspaceIsolation() {
  const shared = 'sp2-net-shared';
  const netA = 'sp2-net-a';
  const netB = 'sp2-net-b';
  const peer = 'sp2-peer';
  const prober = 'sp2-prober';

  for (const n of [peer, prober]) await quiet('rm', '-f', n);
  for (const n of [shared, netA, netB]) await quiet('network', 'rm', n);

  try {
    for (const [n, internal] of [[shared, true], [netA, true], [netB, true]]) {
      const created = await docker('network', 'create', ...(internal ? ['--internal'] : []), n);
      if (created.code !== 0) throw new Error(`network create ${n}: ${created.stderr.trim()}`);
    }

    const startPeer = async (network) => {
      await quiet('rm', '-f', peer);
      const created = await docker(
        'create', '--name', peer, '--network', network, '--hostname', peer,
        WORKER_IMAGE, 'node', '-e',
        `require('net').createServer(s=>s.end('peer\\n')).listen(${PEER_PORT},'0.0.0.0')`,
      );
      if (created.code !== 0) throw new Error(created.stderr.trim());
      await docker('start', peer);
      const ip = await docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, peer);
      return ip.stdout.trim();
    };

    // ---- control: same network, peer must be reachable --------------------------------
    const sharedIp = await startPeer(shared);
    await quiet('rm', '-f', prober);
    await createWorkspace(prober, { network: shared });
    await docker('start', prober);
    const control = await runEscapeSuite(prober, { PEER_WORKSPACE_ADDR: `${sharedIp}:${PEER_PORT}` });
    const controlPeer = control.parsed?.results.find((r) => r.name === 'another-workspace');

    record(
      'workspace-peer-control',
      controlPeer?.reached === true ? 'pass' : 'fail',
      controlPeer?.reached === true
        ? `on a shared network the peer IS reachable (${controlPeer.detail}) — so the probe works and per-workspace networks are what stop it`
        : `control could not reach a peer on the same network (${controlPeer?.detail ?? 'no result'}); the isolated result below is not interpretable`,
      { ms: control.ms },
    );

    // ---- the real configuration: one network per workspace ----------------------------
    await quiet('rm', '-f', prober);
    const isolatedIp = await startPeer(netB);
    await createWorkspace(prober, { network: netA });
    await docker('start', prober);
    const isolated = await runEscapeSuite(prober, { PEER_WORKSPACE_ADDR: `${isolatedIp}:${PEER_PORT}` });
    const isolatedPeer = isolated.parsed?.results.find((r) => r.name === 'another-workspace');

    return record(
      'workspace-peer-isolation',
      isolatedPeer?.reached === false ? 'pass' : 'fail',
      isolatedPeer?.reached === false
        ? `a workspace on its own network cannot reach another workspace at ${isolatedIp}:${PEER_PORT} (${isolatedPeer.detail})`
        : `REACHED another workspace: ${isolatedPeer?.detail ?? 'no result'}`,
      { ms: isolated.ms },
    );
  } finally {
    if (!KEEP) {
      for (const n of [peer, prober]) await quiet('rm', '-f', n);
      for (const n of [shared, netA, netB]) await quiet('network', 'rm', n);
    }
  }
}

/**
 * Deny-by-default egress with an explicit allow-list, and a log of both decisions.
 */
async function egressAllowlist() {
  const network = 'sp2-net-egress';
  const proxy = 'sp2-proxy';
  const workspace = 'sp2-egress-workspace';
  const allowed = 'registry.npmjs.org';
  const denied = 'example.com';

  for (const n of [proxy, workspace]) await quiet('rm', '-f', n);
  await quiet('network', 'rm', network);

  try {
    // `--internal` is the deny-by-default: no route off the host for anything on it.
    const net1 = await docker('network', 'create', '--internal', network);
    if (net1.code !== 0) throw new Error(net1.stderr.trim());

    // The proxy needs real egress, so it sits on the internal network *and* a normal one.
    const created = await docker(
      'create', '--name', proxy, '--network', network, '--hostname', 'proxy',
      '-e', `ALLOW_HOSTS=${allowed}`, PROXY_IMAGE,
    );
    if (created.code !== 0) throw new Error(created.stderr.trim());
    await docker('network', 'connect', 'bridge', proxy);
    await docker('start', proxy);
    await new Promise((r) => setTimeout(r, 1500));

    await createWorkspace(workspace, {
      network,
      env: {
        HTTP_PROXY: 'http://proxy:3128',
        HTTPS_PROXY: 'http://proxy:3128',
        NO_PROXY: '',
      },
    });
    await docker('start', workspace);

    // Direct egress, bypassing the proxy, must still fail.
    const direct = await runEscapeSuite(workspace, {
      VAULT_ADDR: `host.docker.internal:${VAULT_PORT}`,
      LAN_ADDR: `host.docker.internal:${LAN_PORT}`,
    });
    const directReached = direct.parsed?.results.filter((r) => r.reached) ?? [];
    record(
      'egress-direct-still-denied',
      directReached.length === 0 ? 'pass' : 'fail',
      directReached.length === 0
        ? 'with a proxy configured, direct connections out of the workspace still reach nothing'
        : `REACHED without the proxy: ${directReached.map((r) => r.name).join(', ')}`,
      { ms: direct.ms },
    );

    const fetchThrough = async (host) => run('docker', [
      'exec', workspace, 'node', '-e',
      `const h=require('http');const r=h.request({host:'proxy',port:3128,method:'CONNECT',path:'${host}:443'});` +
      `r.on('connect',(res)=>{console.log('status',res.statusCode);process.exit(res.statusCode===200?0:1)});` +
      `r.on('response',(res)=>{console.log('status',res.statusCode);process.exit(res.statusCode===200?0:1)});` +
      `r.on('error',e=>{console.log('error',e.code);process.exit(2)});r.end();`,
    ], { timeoutMs: 60_000 });

    const allowedResult = await fetchThrough(allowed);
    record(
      'egress-allowlisted-host-permitted',
      allowedResult.code === 0 ? 'pass' : 'fail',
      `${allowed} through the proxy: ${allowedResult.stdout.trim() || allowedResult.stderr.trim()}`,
      { ms: allowedResult.ms },
    );

    const deniedResult = await fetchThrough(denied);
    record(
      'egress-non-allowlisted-host-refused',
      deniedResult.code === 1 ? 'pass' : 'fail',
      `${denied} through the proxy: ${deniedResult.stdout.trim() || deniedResult.stderr.trim()} (expected 403)`,
      { ms: deniedResult.ms },
    );

    const logs = await docker('logs', proxy);
    const lines = logs.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    const decisions = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const loggedAllow = decisions.some((d) => d.decision === 'allow' && d.host === allowed);
    const loggedDeny = decisions.some((d) => d.decision === 'deny' && d.host === denied);

    return record(
      'egress-logged-both-decisions',
      loggedAllow && loggedDeny ? 'pass' : 'fail',
      loggedAllow && loggedDeny
        ? `egress log records the permitted request as well as the refused one (${decisions.length} entries)`
        : `log incomplete: allow=${loggedAllow} deny=${loggedDeny} across ${decisions.length} entries`,
      { egressLog: decisions.slice(0, 20) },
    );
  } finally {
    if (!KEEP) {
      for (const n of [proxy, workspace]) await quiet('rm', '-f', n);
      await quiet('network', 'rm', network);
    }
  }
}

/**
 * The criterion that decides whether any of this is usable: a real repository's real test
 * suite, inside the sandbox, reaching the registry only through the allow-list.
 */
async function realTestSuite() {
  if (SKIP_TESTS) return record('real-test-suite', 'blocked', '--skip-tests was passed', { blockedBy: 'operator flag' });

  const network = 'sp2-net-build';
  const proxy = 'sp2-build-proxy';
  const workspace = 'sp2-build-workspace';

  for (const n of [proxy, workspace]) await quiet('rm', '-f', n);
  await quiet('network', 'rm', network);

  try {
    // Materialise the repository the way the design says a worker does — "clone/materialize
    // only the allowed repo/base SHA" (secure-box, task worker lifecycle) — rather than
    // unpacking a tarball. The first version used `git archive`, which produces a tree with
    // no `.git`, and the repository's own path-ownership test shells out to `git ls-files`.
    // It failed for a reason that had nothing to do with the sandbox, which is the most
    // misleading kind of red.
    const baseSha = await run('git', ['-C', REPO, 'rev-parse', 'origin/main'], { timeoutMs: 60_000 });
    if (baseSha.code !== 0) {
      return record('real-test-suite', 'fail', `cannot resolve origin/main: ${baseSha.stderr.trim()}`);
    }
    const sha = baseSha.stdout.trim();

    // The clone source is the primary checkout: this worktree's `.git` is a file pointing
    // outside any mount we could give the container.
    const gitCommonDir = await run('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 60_000 });
    const originRepo = dirname(gitCommonDir.stdout.trim());

    await docker('network', 'create', '--internal', network);
    await docker(
      'create', '--name', proxy, '--network', network, '--hostname', 'proxy',
      // The registry, and the two hosts npm redirects binaries to. Naming them is the point:
      // an allow-list you have to extend when a build needs something is doing its job.
      '-e', 'ALLOW_HOSTS=registry.npmjs.org,.npmjs.org,.npmjs.com',
      PROXY_IMAGE,
    );
    await docker('network', 'connect', 'bridge', proxy);
    await docker('start', proxy);
    await new Promise((r) => setTimeout(r, 1500));

    await createWorkspace(workspace, {
      network,
      extraArgs: [
        '--cpus', '4', '--memory', '4g', '--memory-swap', '4g',
        // Read-only bind mount rather than `docker cp`: cp refuses a container with a
        // read-only rootfs, and relaxing --read-only to get the source in would have meant
        // measuring a weaker sandbox than the one being evaluated. Read-only also means the
        // workspace cannot write back into the origin repository, which is the property a
        // real deployment needs from this mount.
        '-v', `${originRepo.replaceAll('\\', '/')}:/mnt/origin:ro`,
      ],
      env: {
        HTTP_PROXY: 'http://proxy:3128',
        HTTPS_PROXY: 'http://proxy:3128',
        npm_config_proxy: 'http://proxy:3128',
        npm_config_https_proxy: 'http://proxy:3128',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      },
    });
    await docker('start', workspace);

    // `-c safe.directory=...` on the clone itself is not enough: cloning a local path spawns
    // a child git for the local transport, and the child re-reads configuration without the
    // parent's `-c` overrides. The setting has to be in a config file the child will read.
    const clone = await run('docker', [
      'exec', workspace, 'sh', '-c',
      `{ git config --global --add safe.directory '*' && ` +
      `git clone --no-checkout /mnt/origin /work/repo && ` +
      `cd /work/repo && git -c advice.detachedHead=false checkout ${sha} ; } > /tmp/clone.log 2>&1; ` +
      'code=$?; tail -8 /tmp/clone.log; exit $code',
    ], { timeoutMs: 300_000 });
    if (clone.code !== 0) {
      return record('real-test-suite', 'fail', `clone at base SHA failed: ${(clone.stdout + clone.stderr).trim().slice(-600)}`);
    }
    record('real-test-suite-materialise', 'pass', `cloned and checked out ${sha.slice(0, 12)} inside the workspace`, { ms: clone.ms });

    // `cmd | tail` reports tail's exit status, not the command's. The first version of this
    // check did exactly that and reported PASS over a test suite that had failed — the
    // single most dangerous bug a spike harness can have. Status is captured before the
    // output is trimmed.
    const runInside = (script, timeoutMs) => run('docker', [
      'exec', '-w', '/work/repo', workspace, 'sh', '-c',
      `{ ${script} ; } > /tmp/out 2>&1; code=$?; tail -30 /tmp/out; exit $code`,
    ], { timeoutMs });

    const install = await runInside('corepack enable >/dev/null 2>&1; pnpm install --frozen-lockfile', 900_000);
    record(
      'real-test-suite-install',
      install.code === 0 ? 'pass' : 'fail',
      `pnpm install through the allow-list proxy: exit ${install.code}\n${install.stdout.trim().slice(-700)}`,
      { ms: install.ms },
    );
    if (install.code !== 0) {
      return record('real-test-suite', 'fail', 'dependencies could not be installed inside the sandbox');
    }

    const test = await runInside('pnpm test', 900_000);
    return record(
      'real-test-suite',
      test.code === 0 ? 'pass' : 'fail',
      `pnpm test inside the sandbox: exit ${test.code}\n${test.stdout.trim().slice(-900)}`,
      { ms: test.ms },
    );
  } finally {
    if (!KEEP) {
      for (const n of [proxy, workspace]) await quiet('rm', '-f', n);
      await quiet('network', 'rm', network);
    }
  }
}

/**
 * Quotas. The criterion is that they **terminate rather than degrade**, and the interesting
 * result is that this is true of some resources and false of others.
 */
async function quotas() {
  // ---- memory: must be an OOM kill, not a slow swap death -----------------------------
  const memory = await run('docker', [
    'run', '--rm', '--network', 'none', '--memory', '64m', '--memory-swap', '64m',
    WORKER_IMAGE, 'node', '-e',
    "const a=[];for(;;){a.push(Buffer.alloc(8*1024*1024).fill(1));}",
  ], { timeoutMs: 120_000 });
  record(
    'quota-memory-terminates',
    memory.code === 137 ? 'pass' : 'fail',
    memory.code === 137
      ? 'exceeding the memory limit killed the workspace (exit 137 = SIGKILL by the OOM killer)'
      : `expected exit 137, got ${memory.code}: ${(memory.stderr || memory.stdout).trim().slice(-300)}`,
    { ms: memory.ms, exitCode: memory.code },
  );

  // ---- pids: a fork bomb must be refused ----------------------------------------------
  //
  // Counting live processes rather than trusting an error. The first version of this check
  // used Node's async `spawn` in a loop and reported 200 successful spawns against a limit of
  // 32 — because none of them had actually forked yet when the loop finished. It looked like
  // the limit was not enforced. The count is what the limit constrains, so the count is what
  // gets asserted.
  // Counted from the host, not from inside.
  //
  // Two earlier versions of this check were wrong in instructive ways. Counting spawns in
  // Node reported 200 successes against a limit of 32, because async `spawn` had not forked
  // yet when the loop ended. Counting /proc from inside reported nothing at all, because
  // once the limit bites the shell cannot fork `ls` or `wc` either. The only vantage point
  // that can see the truth is outside the cgroup.
  // Two earlier versions of this check were wrong in instructive ways, and the third
  // discovered something better than what it was looking for.
  //
  // Counting spawns in Node reported 200 successes against a limit of 32, because async
  // `spawn` had not forked yet when the loop ended. Counting /proc from inside reported
  // nothing, because once the limit bites the shell cannot fork `ls` or `wc` either. What
  // actually happens is stronger than "some forks are refused": the shell cannot fork, and
  // dash treats a fork failure as fatal, so the **workload dies**. For the S10 criterion —
  // quotas terminate rather than degrade — that is the answer, and it needs a control to
  // show the limit is what killed it.
  const PID_LIMIT = 32;
  const FORK_BOMB = 'i=0; while [ $i -lt 300 ]; do sleep 120 & i=$((i+1)); done; sleep 300';
  const pidsStart = Date.now();

  const forkBomb = async (name, limited) => {
    await quiet('rm', '-f', name);
    const args = ['run', '-d', '--name', name, '--network', 'none'];
    if (limited) args.push('--pids-limit', String(PID_LIMIT));
    args.push(WORKER_IMAGE, 'sh', '-c', FORK_BOMB);
    await docker(...args);
    await new Promise((r) => setTimeout(r, 3000));
    const state = await docker('inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}', name);
    await quiet('rm', '-f', name);
    return state.stdout.trim();
  };

  const limitedState = await forkBomb('sp2-pids-limited', true);
  const controlState = await forkBomb('sp2-pids-control', false);

  const died = limitedState.startsWith('exited') && !limitedState.endsWith('|0');
  const survived = controlState.startsWith('running');
  record(
    'quota-pids-terminates',
    died && survived ? 'pass' : 'fail',
    died && survived
      ? `300 forks against a limit of ${PID_LIMIT} terminated the workload (${limitedState}), while the same ` +
        `fork bomb with no limit was still running (${controlState}) — the limit is what killed it, and it ` +
        'killed rather than throttled'
      : `limited=${limitedState} control=${controlState} (expected the limited run to die and the control to survive)`,
    { ms: Date.now() - pidsStart, limitedState, controlState, limit: PID_LIMIT },
  );

  // ---- cpu: this one DEGRADES by design -----------------------------------------------
  const cpu = await run('docker', [
    'run', '--rm', '--network', 'none', '--cpus', '0.5',
    WORKER_IMAGE, 'node', '-e',
    "const t=Date.now();const s=process.cpuUsage();while(Date.now()-t<4000);" +
    "const u=process.cpuUsage(s);console.log(JSON.stringify({wallMs:Date.now()-t,cpuMs:Math.round((u.user+u.system)/1000)}))",
  ], { timeoutMs: 120_000 });
  let cpuDetail = cpu.stdout.trim();
  try {
    const { wallMs, cpuMs } = JSON.parse(cpu.stdout.trim());
    cpuDetail = `a busy loop ran ${wallMs} ms wall and consumed ${cpuMs} ms CPU (~${(cpuMs / wallMs).toFixed(2)} cores against a 0.5 limit)`;
  } catch { /* keep raw */ }
  record(
    'quota-cpu-degrades-not-terminates',
    'info',
    `${cpuDetail}. CPU quota THROTTLES; it never terminates. A cpu-seconds budget therefore has to be ` +
    'enforced by the supervisor as a watchdog that kills, not by the container runtime. This is a real ' +
    'gap against the S10 criterion as written.',
    { ms: cpu.ms },
  );

  // ---- cpu-seconds: the watchdog that turns the gap above into an answer --------------
  //
  // Since the runtime will not kill on CPU, the supervisor has to. This is that mechanism,
  // measured rather than asserted: sample the container's own cgroup accounting and kill
  // when the budget is spent. The number that matters is the overshoot — how much CPU the
  // workload got beyond its budget before the watchdog caught it — because that is what a
  // `budget.cpu_seconds` promise is actually worth.
  const watchdogName = 'sp2-cpu-watchdog';
  const CPU_BUDGET_SECONDS = 2;
  await quiet('rm', '-f', watchdogName);
  const watchdogStart = Date.now();
  await docker(
    'run', '-d', '--name', watchdogName, '--network', 'none', '--cpus', '1',
    WORKER_IMAGE, 'node', '-e', 'for(;;){}',
  );

  let spentSeconds = 0;
  let samples = 0;
  let killedAt = null;
  while (Date.now() - watchdogStart < 30_000) {
    await new Promise((r) => setTimeout(r, 250));
    // cgroup v2, and cgroupns=private, so /sys/fs/cgroup inside the container is the
    // container's own cgroup. No host access and no docker stats rate maths needed.
    const stat = await run('docker', ['exec', watchdogName, 'cat', '/sys/fs/cgroup/cpu.stat'], { timeoutMs: 15_000 });
    const usage = /usage_usec\s+(\d+)/.exec(stat.stdout);
    if (usage === null) break;
    samples += 1;
    spentSeconds = Number(usage[1]) / 1_000_000;
    if (spentSeconds >= CPU_BUDGET_SECONDS) {
      await docker('kill', '--signal', 'SIGKILL', watchdogName);
      killedAt = spentSeconds;
      break;
    }
  }
  const watchdogState = await docker('inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}', watchdogName);
  await quiet('rm', '-f', watchdogName);
  record(
    'quota-cpu-seconds-watchdog-terminates',
    killedAt !== null && watchdogState.stdout.trim().startsWith('exited') ? 'pass' : 'fail',
    killedAt !== null
      ? `a supervisor watchdog sampling the workspace's own cgroup accounting killed it at ` +
        `${killedAt.toFixed(2)} CPU-seconds against a ${CPU_BUDGET_SECONDS}s budget ` +
        `(overshoot ${(killedAt - CPU_BUDGET_SECONDS).toFixed(2)}s over ${samples} samples at 250 ms). ` +
        `Final state ${watchdogState.stdout.trim()}. This is what makes budget.cpu_seconds enforceable; ` +
        'the runtime alone cannot do it.'
      : `watchdog did not terminate the workload: spent=${spentSeconds.toFixed(2)}s state=${watchdogState.stdout.trim()}`,
    { ms: Date.now() - watchdogStart, budgetSeconds: CPU_BUDGET_SECONDS, killedAtSeconds: killedAt, samples },
  );

  // ---- wall clock: the supervisor's job, and it does terminate ------------------------
  const name = 'sp2-walltime';
  await quiet('rm', '-f', name);
  const started = Date.now();
  await docker('run', '-d', '--name', name, '--network', 'none', WORKER_IMAGE, 'sleep', 'infinity');
  await new Promise((r) => setTimeout(r, 2000));
  const killed = await docker('kill', '--signal', 'SIGKILL', name);
  const state = await docker('inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}', name);
  await quiet('rm', '-f', name);
  record(
    'quota-walltime-terminates',
    killed.code === 0 && state.stdout.trim().startsWith('exited') ? 'pass' : 'fail',
    `supervisor-enforced wall clock: container killed after ${Date.now() - started} ms, final state ${state.stdout.trim()}`,
    { ms: Date.now() - started },
  );

  // ---- disk ---------------------------------------------------------------------------
  const disk = await run('docker', [
    'run', '--rm', '--network', 'none', '--storage-opt', 'size=512m',
    WORKER_IMAGE, 'node', '-e', 'console.log("started")',
  ], { timeoutMs: 120_000 });
  if (disk.code === 0) {
    record('quota-disk-enforced', 'pass', '--storage-opt size is supported on this storage driver', { ms: disk.ms });
  } else {
    // The tmpfs /work mount in createWorkspace is the fallback, and it does bound writes.
    const tmpfs = await run('docker', [
      'run', '--rm', '--network', 'none', '--tmpfs', '/work:rw,size=16m,uid=10001',
      '--user', '10001', WORKER_IMAGE, 'sh', '-lc',
      'dd if=/dev/zero of=/work/fill bs=1M count=64 2>&1 | tail -2; echo exit=$?',
    ], { timeoutMs: 120_000 });
    record(
      'quota-disk-enforced',
      tmpfs.stdout.includes('No space left') ? 'pass' : 'fail',
      `--storage-opt size is NOT supported here (${disk.stderr.trim().split('\n')[0]}). ` +
      `Falling back to a size-bounded tmpfs workspace: ${tmpfs.stdout.trim().replaceAll('\n', ' | ')}`,
      { ms: tmpfs.ms },
    );
  }
}

/**
 * Teardown after a crash. The failure this guards against is a workspace that dies in a way
 * that leaves its mounts, its network or its process tree behind — which is how a host runs
 * out of loop devices three days into a pilot.
 */
async function crashTeardown() {
  const name = 'sp2-crash';
  const network = 'sp2-net-crash';
  await quiet('rm', '-f', name);
  await quiet('network', 'rm', network);

  try {
    await docker('network', 'create', '--internal', network);
    await createWorkspace(name, { network });
    await docker('start', name);

    // FINDING: a workspace cannot kill itself by signalling pid 1. The kernel ignores a
    // SIGKILL sent to a PID namespace's init from *inside* that namespace unless init
    // installed a handler. The first version of this check did exactly that, saw the
    // container still running, and read it as a teardown failure — it was the kernel
    // behaving correctly.
    //
    // Two consequences for S10, both useful: a compromised workload cannot terminate its own
    // workspace to destroy evidence, and containment therefore always has to come from the
    // ancestor namespace, which is what the crash below actually exercises.
    const selfKill = await docker('exec', name, 'sh', '-lc', 'kill -9 1; echo returned=$?');
    const stillUp = await docker('inspect', '-f', '{{.State.Status}}', name);
    record(
      'workspace-cannot-kill-its-own-init',
      stillUp.stdout.trim() === 'running' ? 'pass' : 'fail',
      `in-namespace \`kill -9 1\` (${selfKill.stdout.trim()}) left the container ${stillUp.stdout.trim()}: ` +
      "a workload cannot terminate its own workspace, so containment is always the supervisor's to enforce",
    );

    // The deliberate crash, from the ancestor namespace: an abrupt SIGKILL with no chance
    // for the workspace to clean up after itself.
    await docker('kill', '--signal', 'SIGKILL', name);
    await new Promise((r) => setTimeout(r, 1000));

    const before = await docker('inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', name);
    const teardownStart = Date.now();
    const removed = await docker('rm', '-f', name);
    const teardownMs = Date.now() - teardownStart;

    const stillThere = await docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}');
    const netRemoved = await docker('network', 'rm', network);
    const danglingVolumes = await docker('volume', 'ls', '-q', '--filter', 'dangling=true');

    const clean = removed.code === 0
      && stillThere.stdout.trim() === ''
      && netRemoved.code === 0;

    return record(
      'crash-teardown-leaves-nothing',
      clean ? 'pass' : 'fail',
      `after an abrupt SIGKILL the container state was ${before.stdout.trim()}; teardown removed the container ` +
      `(${teardownMs} ms), its tmpfs mounts went with it, and the network was removed. ` +
      `Dangling volumes on the host: ${danglingVolumes.stdout.trim().split('\n').filter(Boolean).length}.`,
      { ms: teardownMs },
    );
  } finally {
    if (!KEEP) {
      await quiet('rm', '-f', name);
      await quiet('network', 'rm', network);
    }
  }
}

/** Cold create, warm create, teardown. */
async function timings() {
  const samples = { cold: 0, warm: [], teardown: [] };

  const time = async (name) => {
    const start = Date.now();
    await createWorkspace(name, { network: 'none' });
    await docker('start', name);
    // "Created" is not "usable". Timing to the first command the workspace can actually run
    // is the number a scheduler needs; timing to `docker start` returning flatters it.
    await run('docker', ['exec', name, 'node', '-e', 'process.exit(0)'], { timeoutMs: 60_000 });
    const createMs = Date.now() - start;

    const teardownStart = Date.now();
    await docker('rm', '-f', name);
    return { createMs, teardownMs: Date.now() - teardownStart };
  };

  for (const n of ['sp2-t0', 'sp2-t1', 'sp2-t2', 'sp2-t3']) await quiet('rm', '-f', n);

  const cold = await time('sp2-t0');
  samples.cold = cold.createMs;
  samples.teardown.push(cold.teardownMs);

  for (const name of ['sp2-t1', 'sp2-t2', 'sp2-t3']) {
    const result = await time(name);
    samples.warm.push(result.createMs);
    samples.teardown.push(result.teardownMs);
  }

  const mean = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return record(
    'workspace-timings',
    'info',
    `cold create ${samples.cold} ms · warm create ${mean(samples.warm)} ms (${samples.warm.join('/')}) · ` +
    `teardown ${mean(samples.teardown)} ms. Fresh-workspace-per-attempt costs about ${mean(samples.warm) + mean(samples.teardown)} ms, ` +
    'which is comfortably below the cost of any task worth sandboxing.',
    { samples },
  );
}

// ---------------------------------------------------------------- main

async function main() {
  mkdirSync(RESULTS, { recursive: true });
  console.log('SP2 — sandbox isolation spike\n');

  let vaultServer;
  let lanServer;
  try {
    vaultServer = await startHostListener(VAULT_PORT, 'vault-stand-in');
    lanServer = await startHostListener(LAN_PORT, 'lan-service-stand-in');
    record('host-standins', 'info', `vault stand-in on :${VAULT_PORT}, LAN service on :${LAN_PORT}`);
  } catch (error) {
    record('host-standins', 'fail', `could not bind host stand-ins: ${error.message}`);
  }

  try {
    if (!(await preflight())) throw new Error('preflight failed');

    await escapeSuiteControl();
    await escapeSuiteIsolated();
    await workspaceIsolation();
    await egressAllowlist();
    await quotas();
    await crashTeardown();
    await timings();
    await realTestSuite();
  } catch (error) {
    record('driver', 'fail', `${error.name}: ${error.message}`);
  } finally {
    vaultServer?.close();
    lanServer?.close();
  }

  const summary = {
    schema: 'otondev.spike.sp2.v1',
    ranAt: new Date().toISOString(),
    host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length },
    passed: checks.filter((c) => c.status === 'pass').length,
    failed: checks.filter((c) => c.status === 'fail').length,
    blocked: checks.filter((c) => c.status === 'blocked').length,
    info: checks.filter((c) => c.status === 'info').length,
    checks,
  };
  writeFileSync(join(RESULTS, 'sp2-run.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('\n' + '─'.repeat(76));
  console.log(`${summary.passed} passed · ${summary.failed} failed · ${summary.blocked} blocked · ${summary.info} informational`);
  console.log(`results/sp2-run.json written`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

await main();
