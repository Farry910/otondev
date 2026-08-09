#!/usr/bin/env node
/**
 * Emit (or verify) the JSON Schema artifacts other languages consume.
 *
 *   pnpm --filter @otondev/contracts run emit         write packages/contracts/schemas/
 *   pnpm --filter @otondev/contracts run emit:check   fail if the committed files are stale
 *
 * `emit:check` is what CI runs. Without it the committed artifacts drift from the Zod source
 * silently, and the first symptom is a .NET service rejecting a record that TypeScript
 * considers valid — a bug that costs a day and looks like a networking problem.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitJsonSchemas, schemaFileName, serialiseSchema } from '../json-schema.js';
import type { RegisteredSchemaId } from '../registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, '..', '..', 'schemas');

const check = process.argv.includes('--check');
const schemas = emitJsonSchemas();

mkdirSync(schemasDir, { recursive: true });

const expected = new Map<string, string>();
for (const [id, schema] of Object.entries(schemas)) {
  expected.set(schemaFileName(id as RegisteredSchemaId), serialiseSchema(schema));
}

const onDisk = new Set(readdirSync(schemasDir).filter((f) => f.endsWith('.json')));

if (check) {
  const problems: string[] = [];
  for (const [file, content] of expected) {
    if (!onDisk.has(file)) {
      problems.push(`missing   ${file}`);
      continue;
    }
    const actual = readFileSync(join(schemasDir, file), 'utf8');
    if (actual !== content) problems.push(`stale     ${file}`);
  }
  for (const file of onDisk) {
    if (!expected.has(file)) problems.push(`orphaned  ${file}`);
  }

  if (problems.length > 0) {
    console.error('Emitted JSON Schema does not match the committed artifacts:\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nRun: pnpm --filter @otondev/contracts run emit');
    process.exit(1);
  }
  console.log(`contracts: OK — ${expected.size} JSON Schema artifacts are current.`);
  process.exit(0);
}

for (const file of onDisk) {
  if (!expected.has(file)) rmSync(join(schemasDir, file));
}
for (const [file, content] of expected) {
  writeFileSync(join(schemasDir, file), content, 'utf8');
}
console.log(`contracts: wrote ${expected.size} JSON Schema artifacts to packages/contracts/schemas/`);
