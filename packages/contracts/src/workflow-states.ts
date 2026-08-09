import { z } from 'zod';

/**
 * The workflow state machine, contracts §3.
 *
 * Kept in its own module with no dependencies because the error contract needs to name a
 * recommended transition and the workflow record needs the error contract. A cycle between
 * those two would be a boundary violation in the package that defines boundaries.
 */

export const WORKFLOW_STATES = [
  'RECEIVED',
  'TRIAGED',
  'PLANNED',
  'WAITING_AUTH',
  'LEASED',
  'EXECUTING',
  'VERIFYING',
  'DELIVERING',
  'RECOVERING',
  'WAITING_INPUT',
  'PAUSED',
  'BLOCKED',
  'DONE',
  'REJECTED',
  'DENIED',
  'CANCELLED',
  'FAILED',
] as const;

export const WorkflowState = z.enum(WORKFLOW_STATES);
export type WorkflowState = z.infer<typeof WorkflowState>;

/** "terminal | none; create a new workflow to retry terminal work" */
export const TERMINAL_STATES = ['DONE', 'REJECTED', 'DENIED', 'CANCELLED', 'FAILED'] as const;
const TERMINAL = new Set<WorkflowState>(TERMINAL_STATES);

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL.has(state);
}

/**
 * States a RECOVERING workflow may resume into — the table's "prior safe active state".
 * Enumerated rather than left as prose so the recovery scan cannot land somewhere novel.
 */
export const SAFE_ACTIVE_STATES = [
  'PLANNED',
  'LEASED',
  'EXECUTING',
  'VERIFYING',
  'DELIVERING',
] as const;

/**
 * The transition table, verbatim from contracts §3. Anything not listed here is not an
 * ordinary transition, and the two exceptions below are named rather than folded in.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  RECEIVED: ['TRIAGED', 'REJECTED', 'CANCELLED'],
  TRIAGED: ['PLANNED', 'WAITING_INPUT', 'REJECTED'],
  PLANNED: ['WAITING_AUTH', 'LEASED', 'WAITING_INPUT'],
  WAITING_AUTH: ['LEASED', 'DENIED', 'CANCELLED'],
  LEASED: ['EXECUTING', 'PAUSED', 'FAILED'],
  EXECUTING: ['VERIFYING', 'WAITING_INPUT', 'PAUSED', 'FAILED'],
  VERIFYING: ['DELIVERING', 'EXECUTING', 'FAILED'],
  DELIVERING: ['DONE', 'WAITING_INPUT', 'FAILED'],
  RECOVERING: [...SAFE_ACTIVE_STATES, 'WAITING_INPUT', 'FAILED'],
  WAITING_INPUT: ['PLANNED', 'EXECUTING', 'CANCELLED'],
  PAUSED: ['RECOVERING', 'CANCELLED'],
  BLOCKED: ['PLANNED', 'CANCELLED'],
  DONE: [],
  REJECTED: [],
  DENIED: [],
  CANCELLED: [],
  FAILED: [],
};

/**
 * How a transition is being attempted. The distinction is not bureaucracy: an operator may
 * pause from anywhere, a recovery scan may not, and the ordinary engine may do neither.
 *
 * - `normal`   — the table above, and nothing else.
 * - `operator` — contracts §3: "From any non-terminal state, a policy revocation or operator
 *                command may request PAUSED or CANCELLED". Also permits BLOCKED; see the
 *                note on {@link OPERATOR_REACHABLE}.
 * - `recovery` — the recovery scan moving an interrupted attempt into RECOVERING.
 */
export type TransitionChannel = 'normal' | 'operator' | 'recovery';

/**
 * ASSUMPTION (raised as a contract request, W0).
 *
 * The §3 table gives BLOCKED outgoing edges but no incoming ones, so as written the state is
 * unreachable. The prose only names PAUSED and CANCELLED as operator-requestable. Reading
 * "BLOCKED is used when progress has no known automatic or awaited-input path" as intent
 * rather than decoration, BLOCKED is treated as operator/system-reachable from any
 * non-terminal state. If the contract owner rules otherwise, delete BLOCKED from this array
 * and the state becomes unreachable again — no other code changes.
 */
export const OPERATOR_REACHABLE = ['PAUSED', 'CANCELLED', 'BLOCKED'] as const;

/**
 * Note what this function does *not* do. Contracts §3: a pause or cancel "completes only
 * after active capabilities are denied, the current lease is fenced or safely checkpointed,
 * and the state-specific containment rule succeeds". Those are preconditions the workflow
 * engine (S2) and operator control (S18) enforce. This answers the narrower question of
 * whether the edge exists at all — and answering it in one place is why every service can
 * agree on the shape of the machine without importing the engine.
 */
export function canTransition(
  from: WorkflowState,
  to: WorkflowState,
  channel: TransitionChannel = 'normal',
): boolean {
  if (isTerminal(from)) return false;
  if (channel === 'operator' && (OPERATOR_REACHABLE as readonly string[]).includes(to)) return true;
  if (channel === 'recovery' && to === 'RECOVERING') return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Every legal edge, for exhaustiveness tests and for rendering the machine. */
export function transitionEdges(
  channel: TransitionChannel = 'normal',
): { from: WorkflowState; to: WorkflowState }[] {
  const edges: { from: WorkflowState; to: WorkflowState }[] = [];
  for (const from of WORKFLOW_STATES) {
    for (const to of WORKFLOW_STATES) {
      if (canTransition(from, to, channel)) edges.push({ from, to });
    }
  }
  return edges;
}
