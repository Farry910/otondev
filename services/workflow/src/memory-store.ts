import { isTerminal } from '@otondev/contracts';
import type { WorkflowRecord, WorkflowTransition } from '@otondev/contracts';
import type { CommitOutcome, LeaseMutator, Mutator, WorkflowStore } from './store.js';

/**
 * In-memory store. The reference implementation for offline tests, and the subject the
 * shared conformance suite runs against.
 *
 * "In-memory" is not the same as "not serious". This is the adapter that has to make
 * `commit` genuinely indivisible, and it does so by never awaiting between the version check
 * and the write. JavaScript gives us that for free *only* if the whole critical section is
 * synchronous — which is why {@link Mutator} is synchronous and why the `async` keyword here
 * hides no `await`. Add one and the compare-and-set silently stops working, while every test
 * that does not race keeps passing.
 */
export class MemoryWorkflowStore implements WorkflowStore {
  readonly #records = new Map<string, WorkflowRecord>();
  readonly #transitions = new Map<string, WorkflowTransition[]>();
  /** Highest fencing token issued per workflow. Monotonic, and never reset by a release. */
  readonly #fencingTokens = new Map<string, number>();

  async insert(record: WorkflowRecord): Promise<void> {
    this.#records.set(record.id, record);
  }

  async get(workflowId: string): Promise<WorkflowRecord | null> {
    return this.#records.get(workflowId) ?? null;
  }

  async commit(
    workflowId: string,
    expectedStateVersion: number,
    mutate: Mutator,
  ): Promise<CommitOutcome> {
    // --- critical section: no await from here to the end of the method ---
    const current = this.#records.get(workflowId);
    if (current === undefined) return { status: 'not_found' };
    if (current.state_version !== expectedStateVersion) {
      return { status: 'version_conflict', actual_state_version: current.state_version };
    }

    const { record, transition } = mutate(current);
    this.#records.set(workflowId, record);
    this.#append(transition);
    return { status: 'committed', record };
    // --- end critical section ---
  }

  async mutate(workflowId: string, mutate: LeaseMutator): Promise<WorkflowRecord | null> {
    // --- critical section: no await ---
    const current = this.#records.get(workflowId);
    if (current === undefined) return null;

    const next = mutate(current, () => {
      const token = (this.#fencingTokens.get(workflowId) ?? 0) + 1;
      this.#fencingTokens.set(workflowId, token);
      return token;
    });
    this.#records.set(workflowId, next);
    return next;
    // --- end critical section ---
  }

  async appendRefusal(transition: WorkflowTransition): Promise<void> {
    this.#append(transition);
  }

  async transitions(workflowId: string): Promise<WorkflowTransition[]> {
    return [...(this.#transitions.get(workflowId) ?? [])];
  }

  async due(nowMs: number): Promise<string[]> {
    const due: string[] = [];
    for (const record of this.#records.values()) {
      if (isTerminal(record.state)) continue;
      const leaseExpired = record.lease !== null && Date.parse(record.lease.expires_at) <= nowMs;
      const wakeupDue =
        record.next_wakeup_at !== null && Date.parse(record.next_wakeup_at) <= nowMs;
      if (leaseExpired || wakeupDue) due.push(record.id);
    }
    return due.sort();
  }

  #append(transition: WorkflowTransition): void {
    const log = this.#transitions.get(transition.workflow_id);
    if (log === undefined) this.#transitions.set(transition.workflow_id, [transition]);
    else log.push(transition);
  }
}
