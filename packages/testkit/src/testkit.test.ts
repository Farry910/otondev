import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isContractError } from '@otondev/contracts';
import { FakeClock, systemClock } from './clock.js';
import { deterministicIdFactory } from './ids.js';
import { FaultInjector, withFaults } from './faults.js';
import { canonicalise, compareGolden } from './golden.js';
import { defineConformanceSuite, formatConformanceReport, runConformanceSuite } from './conformance.js';
import { formatParityReport, runFakeParity } from './fake-parity.js';

describe('FakeClock', () => {
  it('reports UTC RFC3339 the contracts accept', () => {
    const clock = new FakeClock('2026-07-30T08:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-07-30T08:00:00Z');
    expect(clock.nowMs()).toBe(Date.parse('2026-07-30T08:00:00Z'));
  });

  it('fires timers at the moment they come due, not at the end of the jump', () => {
    // A retry-with-backoff test is meaningless if every timer sees the final time.
    const clock = new FakeClock(0);
    const seen: number[] = [];
    clock.setTimeout(() => seen.push(clock.nowMs()), 100);
    clock.setTimeout(() => seen.push(clock.nowMs()), 250);
    clock.advance(1000);
    expect(seen).toEqual([100, 250]);
    expect(clock.nowMs()).toBe(1000);
  });

  it('lets a timer schedule another timer', () => {
    const clock = new FakeClock(0);
    const seen: number[] = [];
    const schedule = (depth: number): void => {
      clock.setTimeout(() => {
        seen.push(clock.nowMs());
        if (depth < 3) schedule(depth + 1);
      }, 10);
    };
    schedule(1);
    clock.advance(100);
    expect(seen).toEqual([10, 20, 30]);
  });

  it('runs intervals repeatedly and stops when cleared', () => {
    const clock = new FakeClock(0);
    let ticks = 0;
    const id = clock.setInterval(() => {
      ticks += 1;
    }, 25);
    clock.advance(100);
    expect(ticks).toBe(4);
    clock.clearTimer(id);
    clock.advance(100);
    expect(ticks).toBe(4);
  });

  it('refuses to run backwards', () => {
    expect(() => new FakeClock(0).advance(-1)).toThrow(/backwards/);
  });

  it('fails the test rather than hanging CI on a self-rescheduling timer', () => {
    const clock = new FakeClock(0);
    const reschedule = (): void => {
      clock.setTimeout(reschedule, 1);
    };
    reschedule();
    expect(() => clock.advance(1_000_000)).toThrow(/10000 timers/);
  });

  it('has a real counterpart with the same shape', () => {
    expect(systemClock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('deterministic ids', () => {
  it('replays exactly', () => {
    const build = (): string[] => {
      const clock = new FakeClock('2026-07-30T08:00:00.000Z');
      const ids = deterministicIdFactory({ clock });
      return [ids.next('workflow'), ids.next('workflow'), ids.next('capability')];
    };
    expect(build()).toEqual(build());
  });

  it('produces ids the contracts accept, and never a collision', () => {
    const clock = new FakeClock('2026-07-30T08:00:00.000Z');
    const ids = deterministicIdFactory({ clock });
    const minted = Array.from({ length: 500 }, () => ids.next('event'));
    expect(new Set(minted).size).toBe(500);
    for (const id of minted) expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('stays time-ordered as the clock advances', () => {
    const clock = new FakeClock('2026-07-30T08:00:00.000Z');
    const ids = deterministicIdFactory({ clock });
    const first = ids.next('event');
    clock.advance(1000);
    expect(ids.next('event') > first).toBe(true);
  });

  it('does not collide between two seeded factories', () => {
    const clock = new FakeClock(0);
    const a = deterministicIdFactory({ clock, seed: 1 });
    const b = deterministicIdFactory({ clock, seed: 2 });
    expect(a.next('agent')).not.toBe(b.next('agent'));
  });

  it('counts what it minted', () => {
    const ids = deterministicIdFactory({ clock: new FakeClock(0) });
    ids.next('plan');
    ids.next('plan');
    ids.next('action');
    expect(ids.counts()).toEqual({ plan: 2, action: 1 });
  });
});

describe('fault injection', () => {
  const build = () => {
    const clock = new FakeClock('2026-07-30T08:00:00.000Z');
    const faults = new FaultInjector({ clock, advance: (ms) => clock.advance(ms) });
    const peer = { evaluate: async (x: number) => x * 2 };
    return { clock, faults, peer: withFaults('policy', peer, faults) };
  };

  it('fails the declared number of calls and then stops', async () => {
    const { faults, peer } = build();
    faults.failNext('policy.evaluate', 'POLICY_DENIED', 2);
    await expect(peer.evaluate(1)).rejects.toThrow(/POLICY_DENIED/);
    await expect(peer.evaluate(1)).rejects.toThrow(/POLICY_DENIED/);
    await expect(peer.evaluate(21)).resolves.toBe(42);
  });

  it('throws a ContractError, not a bare Error', async () => {
    const { faults, peer } = build();
    faults.failNext('policy.evaluate', 'BUDGET_EXHAUSTED');
    await peer.evaluate(1).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(isContractError(error)).toBe(true);
        if (isContractError(error)) expect(error.code).toBe('BUDGET_EXHAUSTED');
      },
    );
  });

  it('distinguishes an ambiguous timeout from a definite failure', async () => {
    // contracts §7 turns on being able to tell "it failed" from "I do not know".
    const { faults, peer } = build();
    faults.timeoutNext('policy.evaluate');
    await peer.evaluate(1).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        if (isContractError(error)) expect(error.code).toBe('TIMEOUT');
      },
    );
  });

  it('advances the clock on a delay, so leases really do expire', async () => {
    const { clock, faults, peer } = build();
    faults.delayNext('policy.evaluate', 60_000);
    await peer.evaluate(1);
    expect(clock.nowIso()).toBe('2026-07-30T08:01:00Z');
  });

  it('counts calls and reports faults the test declared but never used', async () => {
    const { faults, peer } = build();
    faults.failNext('policy.evaluate', 'INTERNAL');
    faults.failNext('policy.other', 'INTERNAL');
    await expect(peer.evaluate(1)).rejects.toThrow();
    expect(faults.callCount('policy.evaluate')).toBe(1);
    expect(faults.unconsumed()).toEqual(['policy.other (1)']);
  });

  it('passes non-function properties through untouched', () => {
    const clock = new FakeClock(0);
    const faults = new FaultInjector({ clock });
    const wrapped = withFaults('svc', { version: '3', go: async () => 1 }, faults);
    expect(wrapped.version).toBe('3');
  });
});

describe('golden files', () => {
  it('serialises canonically regardless of key order', () => {
    expect(canonicalise({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalise({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('never writes a secret into a committed file', () => {
    // A golden file is committed. A committed file with a captured token in it is a
    // credential leak with a very long tail.
    expect(canonicalise({ api_key: 'sk-live-abc', keep: 1 })).toContain('[redacted]');
    expect(canonicalise({ api_key: 'sk-live-abc' })).not.toContain('sk-live-abc');
  });

  it('creates a missing golden and then compares against it', () => {
    // Into a temp directory: a test that writes into the source tree leaves an untracked
    // file that the path-ownership audit then has to have an opinion about.
    const dir = mkdtempSync(join(tmpdir(), 'otondev-golden-'));
    const name = 'roundtrip';
    const first = compareGolden(import.meta.url, name, { value: 1 }, { dir });
    expect(first.created).toBe(true);
    const second = compareGolden(import.meta.url, name, { value: 1 }, { dir });
    expect(second).toMatchObject({ created: false, match: true });
    const third = compareGolden(import.meta.url, name, { value: 2 }, { dir });
    expect(third.match).toBe(false);
    const updated = compareGolden(import.meta.url, name, { value: 2 }, { dir, update: true });
    expect(updated.match).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// A tiny contract, used to exercise the runner and the parity driver against each other.
interface Counter {
  increment(): void;
  value(): number;
  reset?(): void;
}

const counterSuite = defineConformanceSuite<Counter>('Counter', [
  {
    name: 'starts at zero',
    run: (subject) => {
      if (subject.value() !== 0) throw new Error(`expected 0, got ${subject.value()}`);
    },
  },
  {
    name: 'increments',
    run: (subject) => {
      subject.increment();
      if (subject.value() !== 1) throw new Error(`expected 1, got ${subject.value()}`);
    },
  },
  {
    name: 'resets',
    requires: ['reset'],
    run: (subject) => {
      subject.increment();
      subject.reset?.();
      if (subject.value() !== 0) throw new Error('reset did not');
    },
  },
]);

function makeCounter(broken = false): Counter {
  let n = 0;
  return {
    increment: () => {
      n += broken ? 2 : 1;
    },
    value: () => n,
    reset: () => {
      n = 0;
    },
  };
}

describe('conformance runner', () => {
  it('runs every case against a compliant subject', async () => {
    const report = await runConformanceSuite(counterSuite, {
      name: 'counter',
      capabilities: ['reset'],
      create: () => makeCounter(),
    });
    expect(report).toMatchObject({ passed: 3, failed: 0, skipped: 0, complete: true });
  });

  it('builds a fresh subject and a fresh context for every case', async () => {
    // Shared state between cases makes a suite order-dependent, and an order-dependent
    // conformance suite gives two subjects different verdicts for reasons neither of them
    // caused. The runner's promise is one construction per executed case.
    let built = 0;
    const seenClocks = new Set<unknown>();
    const report = await runConformanceSuite(counterSuite, {
      name: 'counting',
      capabilities: ['reset'],
      create: (context) => {
        built += 1;
        seenClocks.add(context.clock);
        return makeCounter();
      },
    });
    expect(built).toBe(counterSuite.cases.length);
    expect(seenClocks.size).toBe(counterSuite.cases.length);
    expect(report.complete).toBe(true);
  });

  it('does not construct a subject for a case it is going to skip', async () => {
    let built = 0;
    await runConformanceSuite(counterSuite, {
      name: 'no-reset',
      capabilities: [],
      create: () => {
        built += 1;
        return { increment: () => {}, value: () => 0 } as Counter;
      },
    });
    expect(built).toBe(counterSuite.cases.length - 1);
  });

  it('reports a skip as a skip and refuses to call the run complete', async () => {
    const report = await runConformanceSuite(counterSuite, {
      name: 'no-reset',
      capabilities: [],
      create: () => ({ increment: () => {}, value: () => 0 }) as Counter,
    });
    const skipped = report.results.find((r) => r.name === 'resets');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.reason).toContain('reset');
    expect(report.complete).toBe(false);
  });

  it('fails a hanging case instead of timing out the CI job', async () => {
    const hanging = defineConformanceSuite<Counter>('Hangs', [
      { name: 'never settles', run: () => new Promise<void>(() => {}) },
    ]);
    const report = await runConformanceSuite(
      hanging,
      { name: 'counter', create: () => makeCounter() },
      { caseTimeoutMs: 20 },
    );
    expect(report.failed).toBe(1);
    expect(report.results[0]?.reason).toMatch(/did not settle/);
  });

  it('refuses a suite with two cases of the same name', () => {
    expect(() =>
      defineConformanceSuite<Counter>('Dup', [
        { name: 'a', run: () => {} },
        { name: 'a', run: () => {} },
      ]),
    ).toThrow(/two cases named/);
  });

  it('formats a readable report', async () => {
    const report = await runConformanceSuite(counterSuite, {
      name: 'counter',
      capabilities: ['reset'],
      create: () => makeCounter(),
    });
    expect(formatConformanceReport(report)).toContain('3 passed, 0 failed, 0 skipped');
  });
});

describe('fake-parity driver', () => {
  const compliant = { name: 'fake', capabilities: ['reset'], create: () => makeCounter() };

  it('confirms parity when both sides agree', async () => {
    const report = await runFakeParity({
      suite: counterSuite,
      fake: compliant,
      real: { name: 'real', capabilities: ['reset'], create: () => makeCounter() },
    });
    expect(report.ok).toBe(true);
    expect(report.divergences).toEqual([]);
  });

  it('catches the dangerous direction: the fake promises what the real one does not deliver', async () => {
    const report = await runFakeParity({
      suite: counterSuite,
      fake: compliant,
      real: { name: 'real', capabilities: ['reset'], create: () => makeCounter(true) },
    });
    expect(report.ok).toBe(false);
    expect(report.divergences.map((d) => d.verdict)).toContain('fake_ahead');
    expect(formatParityReport(report)).toContain(
      'the fake promises behaviour the implementation does not deliver',
    );
  });

  it('catches a fake that quietly declines half the contract', async () => {
    const report = await runFakeParity({
      suite: counterSuite,
      fake: { name: 'fake', capabilities: [], create: () => makeCounter() },
      real: { name: 'real', capabilities: ['reset'], create: () => makeCounter() },
    });
    expect(report.divergences.map((d) => d.verdict)).toContain('coverage_mismatch');
  });

  it('says PARITY NOT ESTABLISHED rather than OK when there is no implementation yet', async () => {
    const report = await runFakeParity({ suite: counterSuite, fake: compliant });
    expect(report.real).toBeNull();
    expect(formatParityReport(report)).toContain('Parity is UNPROVEN');
  });

  it('is not ok when the fake fails its own suite', async () => {
    const report = await runFakeParity({
      suite: counterSuite,
      fake: { name: 'fake', capabilities: ['reset'], create: () => makeCounter(true) },
    });
    expect(report.ok).toBe(false);
  });
});
