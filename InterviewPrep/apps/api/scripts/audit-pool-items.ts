/**
 * Runs the generated-item validator, including the content-quality rules in
 * `modules/reasoning/quality.ts`, over questions that already exist: the stored pool, or a JSON
 * export. No model call is made. Use it to see what the tightened check would have rejected among
 * the questions a cheaper tier wrote, before switching that tier on.
 *
 * Usage:
 *   DATABASE_URL=postgres://owner@host/db npx tsx scripts/audit-pool-items.ts [--limit 200] [--domain key] [--difficulty level] [--model claude-haiku-4-5]
 *   npx tsx scripts/audit-pool-items.ts --file items.json
 *   add --json for machine-readable output, --ids to list only the ids of items with errors
 *
 * The DATABASE_URL must be the owner/worker connection string: since migration 0016 the API role
 * cannot read `reasoning_items.private`, which the distractor and regulation rules need.
 *
 * `--file` accepts an array of either shape: rows as stored (`{ id, domain, difficulty, seed,
 * public, private }`) or raw generator outputs (`{ scenario, options, correct_option, ... }` with
 * `domain` and `difficulty` set; the seed is reconstructed from `seed` when present).
 *
 * Questions written on the architecture library (gen.v3: `seed.architecture` set) are read as the library
 * gate reads them (`libraryQualityView`: the situation without the organisation summary, the attack-step
 * labels, the objective's own wording): only the content-quality rules are run on them, since the
 * library gate's structural rules already ran when they were written and the legacy validator does not
 * apply to them.
 */
import { readFileSync } from 'node:fs';
import { getArchitecture, type ArchitectureDef } from '../src/modules/reasoning/architectures/index.js';
import { getDomain } from '../src/modules/reasoning/domains/index.js';
import type { VariationSeed } from '../src/modules/reasoning/domain.types.js';
import type { GeneratedItem, GeneratorOutput, LibraryGeneratorOutput } from '../src/modules/reasoning/item.types.js';
import { qualityChecks, type QualityFinding } from '../src/modules/reasoning/quality.js';
import { libraryQualityView, validateGeneratedItem } from '../src/modules/reasoning/validation.js';

interface StoredRow {
  id: string;
  domain: string;
  difficulty: string;
  seed: VariationSeed;
  public: GeneratedItem['public'];
  private: GeneratedItem['private'];
  model?: string;
  created_at?: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

/** The stored halves put back into the generator's shape, which is what the validator reads. */
export function toGeneratorOutput(row: StoredRow): GeneratorOutput {
  const p = row.public;
  const q = row.private;
  return {
    title: p.title,
    scenario: p.scenario,
    attack_narrative: p.attackNarrative,
    objective: p.objective,
    question: p.question,
    options: p.options,
    correct_option: q.correctOption,
    option_analysis: q.optionAnalysis,
    diagram: {
      boundaries: p.diagram.boundaries,
      nodes: p.diagram.nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, boundary: n.boundary, detail: n.detail ?? null, compromised: Boolean(n.compromised), entry_point: Boolean(n.entryPoint), controls: n.controls ?? [] })),
      edges: p.diagram.edges,
      attack_path: p.diagram.attackPath,
    },
    rubric: q.rubric.map((r) => ({ id: r.id, dimension: r.dimension, text: r.text, weight: String(Math.min(5, Math.max(1, Math.round(r.weight)))) as '1' | '2' | '3' | '4' | '5', hint: r.hint, explanation: r.explanation })),
    must_not_credit: q.mustNotCredit,
    reference_answer: q.referenceAnswer,
    techniques: p.techniques,
    concepts: p.concepts,
    difficulty: p.difficulty,
  };
}

/** A stored library question put back into the writer's shape: the situation without the organisation summary, the steps from the diagram's attack path. */
export function toLibraryOutput(row: StoredRow, arch: ArchitectureDef): LibraryGeneratorOutput {
  const p = row.public;
  const q = row.private;
  const out = toGeneratorOutput(row);
  const prefix = `${arch.organisation.summary}\n\n`;
  const edges = p.diagram.attackPath.map((id) => p.diagram.edges.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
  return {
    title: out.title,
    situation: p.scenario.startsWith(prefix) ? p.scenario.slice(prefix.length) : p.scenario,
    attack_narrative: out.attack_narrative,
    objective: out.objective,
    question: out.question,
    options: out.options,
    correct_option: out.correct_option,
    option_analysis: out.option_analysis,
    attack: { entry_node: p.diagram.nodes.find((n) => n.entryPoint)?.id ?? '', compromised_nodes: p.diagram.nodes.filter((n) => n.compromised).map((n) => n.id), steps: edges.map((e) => ({ from: e.from, to: e.to, label: e.label ?? '' })) },
    rubric: out.rubric,
    must_not_credit: out.must_not_credit,
    reference_answer: out.reference_answer,
    architecture_analysis: q.architectureAnalysis ?? '',
    techniques: out.techniques,
    concepts: out.concepts,
    difficulty: out.difficulty,
  };
}

const isStoredRow = (x: unknown): x is StoredRow => typeof x === 'object' && x !== null && 'public' in x && 'private' in x;

async function loadRows(): Promise<{ row: StoredRow; out: GeneratorOutput }[]> {
  const file = flag('file');
  if (file) {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
    return data.map((x, i) => {
      if (isStoredRow(x)) return { row: x, out: toGeneratorOutput(x) };
      const out = x as GeneratorOutput & { id?: string; domain?: string; seed?: VariationSeed };
      const domain = out.domain ?? out.seed?.domain ?? 'cloud_security';
      const seed: VariationSeed = out.seed ?? { domain: domain as VariationSeed['domain'], difficulty: out.difficulty, topology: '', entryPoint: '', objective: '', technique: out.techniques[0]?.id ?? '', constraint: '' };
      return { row: { id: out.id ?? `item-${i + 1}`, domain, difficulty: out.difficulty, seed, public: undefined as never, private: undefined as never }, out };
    });
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (owner/worker role) or pass --file items.json');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const where: string[] = ['pool'];
    const params: unknown[] = [];
    for (const [col, name] of [['domain', 'domain'], ['difficulty', 'difficulty'], ['model', 'model']] as const) {
      const v = flag(name);
      if (v) {
        params.push(v);
        where.push(`${col} = $${params.length}`);
      }
    }
    params.push(Number(flag('limit') ?? 500));
    const res = await client.query<StoredRow>(`SELECT id, domain, difficulty, seed, public, private, model, created_at FROM reasoning_items WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows.map((row) => ({ row, out: toGeneratorOutput(row) }));
  } finally {
    await client.end();
  }
}

interface Report {
  id: string;
  domain: string;
  difficulty: string;
  model?: string;
  title: string;
  errors: string[];
  warnings: string[];
  quality: QualityFinding[];
}

const main = async () => {
  const rows = await loadRows();
  const reports: Report[] = [];
  for (const { row, out } of rows) {
    const domain = getDomain(row.domain);
    if (!domain) {
      reports.push({ id: row.id, domain: row.domain, difficulty: row.difficulty, model: row.model, title: out.title, errors: [`domain ${row.domain} is not registered`], warnings: [], quality: qualityChecks(out) });
      continue;
    }
    const seed: VariationSeed = { ...row.seed, difficulty: (row.seed?.difficulty ?? row.difficulty) as VariationSeed['difficulty'] };
    const arch = row.public && row.seed?.architecture ? getArchitecture(row.seed.architecture.id) : undefined;
    if (arch) {
      const quality = qualityChecks(libraryQualityView(toLibraryOutput(row, arch), arch, domain, seed));
      const messages = (severity: QualityFinding['severity']) => quality.filter((f) => f.severity === severity).map((f) => f.message);
      reports.push({ id: row.id, domain: row.domain, difficulty: row.difficulty, model: row.model, title: out.title, errors: messages('error'), warnings: messages('warning'), quality });
      continue;
    }
    const quality = qualityChecks(out);
    const v = validateGeneratedItem(out, domain, seed);
    reports.push({ id: row.id, domain: row.domain, difficulty: row.difficulty, model: row.model, title: out.title, errors: v.errors, warnings: v.warnings, quality });
  }

  const failing = reports.filter((r) => r.errors.length);
  const byRule = new Map<string, number>();
  for (const r of reports) for (const f of r.quality) if (f.severity === 'error') byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  const structural = reports.filter((r) => r.errors.length && !r.quality.some((f) => f.severity === 'error')).length;

  if (has('json')) {
    process.stdout.write(`${JSON.stringify({ total: reports.length, failing: failing.length, byRule: Object.fromEntries(byRule), structuralOnly: structural, reports }, null, 2)}\n`);
    return;
  }
  if (has('ids')) {
    process.stdout.write(failing.map((r) => r.id).join('\n') + (failing.length ? '\n' : ''));
    return;
  }
  for (const r of reports) {
    const mark = r.errors.length ? 'FAIL' : r.warnings.length ? 'warn' : 'ok  ';
    process.stdout.write(`${mark}  ${r.id}  ${r.domain}/${r.difficulty}${r.model ? `  ${r.model}` : ''}  ${r.title}\n`);
    for (const e of r.errors) process.stdout.write(`        error    ${e}\n`);
    for (const w of r.warnings) process.stdout.write(`        warning  ${w}\n`);
  }
  process.stdout.write(`\n${reports.length} items: ${failing.length} would be rejected (${structural} on structure alone), ${reports.length - failing.length} pass\n`);
  for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) process.stdout.write(`  ${rule.padEnd(12)} ${n} item(s)\n`);
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
