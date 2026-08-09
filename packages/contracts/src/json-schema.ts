import { z } from 'zod';
import { REGISTERED_SCHEMA_IDS, SCHEMA_REGISTRY } from './registry.js';
import type { RegisteredSchemaId } from './registry.js';

/**
 * JSON Schema emission.
 *
 * Implementation-plan §2 puts the schema source of truth in Zod and says JSON Schema is
 * emitted "for other languages". That is not a nicety: the `.NET` companion (S16), the
 * Windows supervisor (S17) and any Python executor consume these artifacts, and a hand-kept
 * second copy of a contract diverges the first week someone is in a hurry.
 *
 * The emitted files are committed and checked in CI, so a schema change that forgets to
 * re-emit fails the build in the pull request rather than at the point a .NET service starts
 * rejecting valid records.
 */

export interface EmitOptions {
  /**
   * `input` describes what a producer must send; `output` describes what a consumer receives
   * after defaults are applied. Cross-language consumers are validating records on the wire,
   * so `input` is the correct one and the only one emitted.
   */
  io?: 'input' | 'output';
}

const BASE_URI = 'https://schemas.otondev.dev';

export function jsonSchemaFor(id: RegisteredSchemaId, options: EmitOptions = {}): Record<string, unknown> {
  const emitted = z.toJSONSchema(SCHEMA_REGISTRY[id], {
    target: 'draft-2020-12',
    io: options.io ?? 'input',
    // A record that cannot be represented in JSON Schema cannot be consumed by the other
    // languages, which makes it a contract defect. Fail rather than emit something lossy.
    unrepresentable: 'throw',
    cycles: 'throw',
  }) as Record<string, unknown>;

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${BASE_URI}/${id}.json`,
    title: id,
    ...emitted,
  };
}

/** Every registered schema, keyed by schema id. */
export function emitJsonSchemas(options: EmitOptions = {}): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of REGISTERED_SCHEMA_IDS) out[id] = jsonSchemaFor(id, options);
  return out;
}

/** Stable file name for a schema id: `agentdev.event.v2` -> `agentdev.event.v2.json`. */
export function schemaFileName(id: RegisteredSchemaId): string {
  return `${id}.json`;
}

/**
 * Serialise deterministically. Byte-identical output for identical schemas is what lets the
 * committed artifacts be compared with `--check` instead of re-parsed and diffed structurally.
 */
export function serialiseSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
