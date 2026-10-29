# Attack Reasoning architecture library

Every Attack Reasoning question is written on one of these 15 architectures (5 beginner `b1-`…`b5-`,
5 intermediate `i1-`…`i5-`, 5 advanced `a1-`…`a5-`). The model never draws a diagram: it writes an attack
overlay (entry node, compromised nodes, steps between the node ids of one file) and `compose.ts` builds the
diagram the client renders. Design: `docs/ATTACK_REASONING_COST_DESIGN.md` §2.

| File | What it is |
|---|---|
| `<id>.json` | One architecture (`ArchitectureDef` in `types.ts`); `$schema` gives editors completion and checks |
| `schema.ts` | The zod schema, the source of truth for the file shape |
| `checks.ts` | References, per-level sizes, required content, a drawable path per attack surface, and the coverage rule |
| `text.ts` | `architectureText()`: the cached prompt prefix the question writer reads (no surfaces, no review notes) |
| `compose.ts` | `composeDiagram()`, `validateOverlay()`, `normaliseOverlay()`, `pathKey()`, `sampleOverlay()` |
| `index.ts` | Imports every file, validates at load (a broken library fails the boot and the tests), lookups |

Editing a file:

1. Change the JSON and bump that file's `version`; bump `LIBRARY_VERSION` in `index.ts`. Existing questions keep
   the diagram they were written on (it is copied into the item), so an edit only affects new questions.
2. Organisations, products and people are fictional. `reviewNotes` is for reviewers and never reaches the model.
3. Coverage rule: at every level, each of the 15 domains has attack surfaces in at least 3 architectures, with at
   least 2 surfaces each. Surface techniques come from the domain's technique list (ATLAS for AI), objectives from
   its objective ids.
4. Keep node labels short and singular where you can (the gate looks for them in the question's narrative) and
   flow labels short (the client lays labels out without overlaps).
5. Run `npx vitest run test/unit/architectures.test.ts` in `InterviewPrep/apps/api` and
   `npx vitest run tests/architecture-library-layout.test.ts` in `attack-reasoning`. After a change to `schema.ts`,
   run `npx tsx scripts/architecture-schema.ts` to rewrite `architecture.schema.json`.
