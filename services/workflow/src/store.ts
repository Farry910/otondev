import type { WorkflowRecord, WorkflowTransition } from '@otondev/contracts';

/**
 * The storage port.
 *
 * S2's brief says the engine is "built behind a `WorkflowEngine` interface so the
 * Temporal-vs-Postgres decision stays open". That decision is only genuinely open if the
 * engine never assumes *how* durability works, so every persistence concern is expressed
 * here and the engine holds no state of its own.
 *
 * The shape below is unusual in one deliberate way: there is no `update`. A caller cannot
 * read a record, decide something, and write it back, because between the read and the write
 * another claimant can win — and contracts §3 requires that exactly one of them does. The
 * only mutation is {@link WorkflowStore.commit}, which performs the compare-and-set, the
 * mutation, and the transition-event append as **one indivisible unit**.
 *
 * That single method is also what makes "a crash mid-transition resumes at a safe state"
 * achievable rather than aspirational: there is no window in which the state moved but its
 * transition event did not, so a recovering engine never has to guess which of the two it is
 * looking at.
 */

export type CommitOutcome =
  | { status: 'committed'; record: WorkflowRecord }
  /** The record moved under us. Contracts §3 calls this a conflict, not a reason to retry. */
  | { status: 'version_conflict'; actual_state_version: number }
  | { status: 'not_found' };

/**
 * Decides the next record from the current one.
 *
 * Synchronous on purpose. An async mutator would reintroduce the interleaving window the
 * whole port exists to close — the store could not hold its lock across an arbitrary await
 * without letting a caller deadlock it. Everything asynchronous a transition needs (denying
 * capabilities, calling a peer) happens *before* commit is entered; see
 * `containment.ts`.
 */
export type Mutator = (current: WorkflowRecord) => {
  record: WorkflowRecord;
  transition: WorkflowTransition;
};

/**
 * A read-modify-write that changes something other than the state — a lease, a wakeup — and
 * therefore records no transition event and does not touch `state_version`.
 *
 * `nextFencingToken` is a function rather than a value so a mutator that decides not to
 * reissue a lease does not consume a token. Tokens must be monotonic; they need not be
 * gapless, but a counter that advances on every *attempted* acquisition would make the
 * numbers in an incident timeline much harder to reason about than they need to be.
 */
export type LeaseMutator = (
  current: WorkflowRecord,
  nextFencingToken: () => number,
) => WorkflowRecord;

export interface WorkflowStore {
  insert(record: WorkflowRecord): Promise<void>;
  get(workflowId: string): Promise<WorkflowRecord | null>;

  /**
   * Compare-and-set on `state_version`, then persist the new record and its transition event
   * atomically. Implementations must not yield between reading the version and writing.
   */
  commit(workflowId: string, expectedStateVersion: number, mutate: Mutator): Promise<CommitOutcome>;

  /** Atomic, but not a state change. Returns null when the workflow does not exist. */
  mutate(workflowId: string, mutate: LeaseMutator): Promise<WorkflowRecord | null>;

  /**
   * Record a transition that was **refused**.
   *
   * Contracts §3 wants an event per change, and the `WorkflowTransition` contract says it is
   * "recorded whether the transition succeeded or was refused: a rejected transition is
   * evidence too, and 'why did nothing happen' is the question incident review actually
   * asks". A refusal changes no state, so it cannot ride along inside `commit`.
   */
  appendRefusal(transition: WorkflowTransition): Promise<void>;

  transitions(workflowId: string): Promise<WorkflowTransition[]>;

  /**
   * Non-terminal workflows whose lease has expired or whose wakeup is due at `nowMs`.
   * Ordered by id so a scan is reproducible.
   */
  due(nowMs: number): Promise<string[]>;

  /**
   * Every non-terminal workflow, due or not.
   *
   * Distinct from {@link WorkflowStore.due} on purpose, and the distinction is load-bearing:
   * a workflow that has never taken a lease and has no wakeup scheduled is invisible to
   * `due`, but it is still live and an emergency quarantine still has to contain it. Reusing
   * `due` here — which this store did, briefly — makes a global quarantine report
   * `contained: []` for exactly the workflows nobody has touched yet.
   */
  active(): Promise<string[]>;
}
