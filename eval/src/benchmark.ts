/**
 * The task-quality benchmark: frozen tasks, hidden tests.
 *
 * Operations §5 is blunt about what this must not become: *"Do not optimize only for PR
 * creation rate. A draft PR that fails hidden checks or causes rework is not success."* So the
 * scoring here refuses to call an attempt successful on the strength of anything the attempt
 * itself reports. Only the hidden tests decide.
 *
 * **Frozen** means the task's inputs are fixed and content-addressed: a benchmark whose tasks
 * drift measures the drift. **Hidden** means the attempt cannot read the tests it will be
 * judged by — enforced structurally here, not by convention: `runAttempt` hands the attempt a
 * {@link VisibleTask}, which has no field the hidden tests occupy, and scores it afterwards.
 * An attempt cannot fetch them because it is never given anything to fetch them with.
 */

import { createHash } from 'node:crypto';

export interface HiddenTest {
  name: string;
  /** Run against whatever the attempt produced. Pure: two runs must agree. */
  check(submission: Submission): boolean;
}

export interface VisibleTask {
  id: string;
  /** What the agent under test is told. Everything it may legitimately see. */
  goal: string;
  repository: string;
  base_sha: string;
  /** Tests the agent may read and run. Passing these is necessary and not sufficient. */
  visible_tests: readonly string[];
  risk: 'low' | 'medium' | 'high';
}

export interface FrozenTask extends VisibleTask {
  /** Never handed to the attempt. */
  hidden_tests: readonly HiddenTest[];
  /** Content digest of the visible half. A changed task is a different task. */
  digest: string;
}

export interface Submission {
  task_id: string;
  /** What the attempt changed. */
  diff: string;
  /** What the attempt says about itself. Recorded, never trusted, never scored. */
  claim: 'done' | 'partial' | 'failed';
  visible_tests_passed: boolean;
  cost_usd: number;
  wall_seconds: number;
  human_interventions: number;
}

export interface TaskScore {
  task_id: string;
  /** True only when every hidden test passed. The attempt's own claim cannot produce this. */
  completed: boolean;
  hidden_passed: number;
  hidden_total: number;
  /**
   * The attempt said done and the hidden tests disagree.
   *
   * Tracked as its own metric because it is the one that matters most: an agent that
   * over-reports is worse than one that under-delivers, since the first consumes reviewer
   * trust and the second only consumes time.
   */
  false_done_claim: boolean;
  cost_usd: number;
  wall_seconds: number;
  human_interventions: number;
}

export interface BenchmarkSummary {
  scores: readonly TaskScore[];
  /** Completion by hidden tests, not by claim. */
  completion_rate: number;
  false_done_rate: number;
  mean_cost_usd: number;
  mean_wall_seconds: number;
  intervention_rate: number;
}

/** Freeze a task: compute the digest over the visible half, which is what an attempt sees. */
export function freezeTask(task: Omit<FrozenTask, 'digest'>): FrozenTask {
  const visible: VisibleTask = {
    id: task.id,
    goal: task.goal,
    repository: task.repository,
    base_sha: task.base_sha,
    visible_tests: task.visible_tests,
    risk: task.risk,
  };
  return { ...task, digest: `sha256:${createHash('sha256').update(stableJson(visible)).digest('hex')}` };
}

/** What the attempt receives. Nothing else — this is the hiding, expressed as a type. */
export function visibleOnly(task: FrozenTask): VisibleTask {
  return {
    id: task.id,
    goal: task.goal,
    repository: task.repository,
    base_sha: task.base_sha,
    visible_tests: task.visible_tests,
    risk: task.risk,
  };
}

export type Attempt = (task: VisibleTask) => Promise<Submission> | Submission;

export async function runAttempt(task: FrozenTask, attempt: Attempt): Promise<TaskScore> {
  const submission = await attempt(visibleOnly(task));

  const passed = task.hidden_tests.filter((test) => test.check(submission));
  const completed = task.hidden_tests.length > 0 && passed.length === task.hidden_tests.length;

  return {
    task_id: task.id,
    completed,
    hidden_passed: passed.length,
    hidden_total: task.hidden_tests.length,
    false_done_claim: submission.claim === 'done' && !completed,
    cost_usd: submission.cost_usd,
    wall_seconds: submission.wall_seconds,
    human_interventions: submission.human_interventions,
  };
}

export function summariseBenchmark(scores: readonly TaskScore[]): BenchmarkSummary {
  const n = scores.length;
  const mean = (pick: (score: TaskScore) => number): number =>
    n === 0 ? 0 : scores.reduce((total, score) => total + pick(score), 0) / n;

  return {
    scores,
    completion_rate: n === 0 ? 0 : scores.filter((s) => s.completed).length / n,
    false_done_rate: n === 0 ? 0 : scores.filter((s) => s.false_done_claim).length / n,
    mean_cost_usd: mean((s) => s.cost_usd),
    mean_wall_seconds: mean((s) => s.wall_seconds),
    intervention_rate: n === 0 ? 0 : scores.filter((s) => s.human_interventions > 0).length / n,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}
