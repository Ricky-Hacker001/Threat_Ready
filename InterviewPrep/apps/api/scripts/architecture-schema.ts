// Writes src/modules/reasoning/architectures/architecture.schema.json (the "$schema" every library file
// names, for editors) from the zod schema, the source of truth. Run after changing schema.ts:
//   npx tsx scripts/architecture-schema.ts            (from InterviewPrep/apps/api)
// test/unit/architectures.test.ts fails while the file is out of date.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { architectureJsonSchemaText } from '../src/modules/reasoning/architectures/schema.js';

const out = fileURLToPath(new URL('../src/modules/reasoning/architectures/architecture.schema.json', import.meta.url));
writeFileSync(out, architectureJsonSchemaText());
console.log(`wrote ${out}`);
