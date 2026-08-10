import { AUTONOMY_LEVELS, minAutonomy } from '@otondev/contracts';
import type { ActionClass, AutonomyLevel, DataClass, Environment } from '@otondev/contracts';
import type { AutonomyCeilings } from './bundle.js';

/**
 * Effective autonomy.
 *
 * Implementation-plan §5 S4: "Effective autonomy is the **minimum** across agent, repository,
 * environment, data class, incident mode, and action type."
 *
 * Two things make this harder than `Math.min` and both are places it goes wrong:
 *
 * 1. **A missing dimension is not a permissive dimension.** If the bundle has no ceiling for
 *    an agent, the honest answer is "this bundle does not describe that agent", not A4. Every
 *    lookup here therefore returns either a level *or* an unknown marker, and the caller has
 *    to deal with unknowns before it can have a number. That is what makes "unknown or
 *    unclassified input denies" structural rather than a forgotten branch.
 *
 * 2. **Every contributing dimension has to be reported.** A decision that says "A1" is
 *    unarguable; a decision that says "A1, because the staging environment caps at A1 while
 *    everything else allowed A3" can be checked, and is what makes the decision reproducible
 *    from its logged inputs.
 */

export const AUTONOMY_DIMENSIONS = [
  'agent',
  'resource',
  'environment',
  'data_class',
  'action_class',
  'incident_mode',
] as const;
export type AutonomyDimension = (typeof AUTONOMY_DIMENSIONS)[number];

export interface AutonomyContribution {
  dimension: AutonomyDimension;
  level: AutonomyLevel;
  /** The bundle key that supplied it — an exact key, or `*` when the default applied. */
  source: string;
}

export interface UnknownDimension {
  dimension: AutonomyDimension;
  key: string;
}

export type AutonomyResolution =
  | { ok: true; effective: AutonomyLevel; contributions: AutonomyContribution[] }
  | { ok: false; unknown: UnknownDimension[]; contributions: AutonomyContribution[] };

export interface AutonomyInputs {
  agentId: string;
  resource: string;
  environment: Environment;
  dataClasses: readonly DataClass[];
  actionClass: ActionClass;
  incidentMode: boolean;
}

/** Exact key first, then the bundle's `*` default. Absent from both is unknown. */
function lookup(
  table: Readonly<Record<string, AutonomyLevel | undefined>>,
  key: string,
): { level: AutonomyLevel; source: string } | undefined {
  const exact = table[key];
  if (exact !== undefined) return { level: exact, source: key };
  const fallback = table['*'];
  if (fallback !== undefined) return { level: fallback, source: '*' };
  return undefined;
}

export function resolveEffectiveAutonomy(
  ceilings: AutonomyCeilings,
  inputs: AutonomyInputs,
): AutonomyResolution {
  const contributions: AutonomyContribution[] = [];
  const unknown: UnknownDimension[] = [];

  const add = (
    dimension: AutonomyDimension,
    table: Readonly<Record<string, AutonomyLevel | undefined>>,
    key: string,
  ): void => {
    const hit = lookup(table, key);
    if (hit === undefined) unknown.push({ dimension, key });
    else contributions.push({ dimension, level: hit.level, source: hit.source });
  };

  add('agent', ceilings.agents, inputs.agentId);
  add('resource', ceilings.resources, inputs.resource);
  add('environment', ceilings.environments, inputs.environment);
  add('action_class', ceilings.action_classes, inputs.actionClass);

  // Every data class present contributes; the most restrictive of them wins by virtue of
  // being in the same minimum as everything else. An empty set is not "no constraint" — it
  // is a record whose classification nobody established.
  if (inputs.dataClasses.length === 0) {
    unknown.push({ dimension: 'data_class', key: '<none declared>' });
  }
  for (const dataClass of inputs.dataClasses) {
    add('data_class', ceilings.data_classes, dataClass);
  }

  // Only contributes while an incident is declared. Outside one it must not silently raise
  // the ceiling, so it simply does not participate.
  if (inputs.incidentMode) {
    contributions.push({
      dimension: 'incident_mode',
      level: ceilings.incident_mode,
      source: 'incident_mode',
    });
  }

  if (unknown.length > 0) return { ok: false, unknown, contributions };

  const effective = minAutonomy(contributions.map((c) => c.level));
  return { ok: true, effective, contributions };
}

/** Is `level` at least `required`? Compares position on the ladder, not string order. */
export function meetsAutonomy(level: AutonomyLevel, required: AutonomyLevel): boolean {
  return AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(required);
}

/** The dimensions that pinned the result — what an operator asks first. */
export function bindingDimensions(resolution: AutonomyResolution): AutonomyContribution[] {
  if (!resolution.ok) return [];
  return resolution.contributions.filter((c) => c.level === resolution.effective);
}
