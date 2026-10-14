import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import type { InterviewType, Track } from '@threatready/contracts';
import { rubrics as rubricsTable, skills as skillsTable } from '@threatready/db';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Database } from '../db/database.js';

export interface SkillDef {
  id: string;
  label: string;
  category: string;
  aliases: string[];
  concepts: string[];
}
export interface RoleDef {
  id: string;
  label: string;
  track: Track;
  defaultType: InterviewType;
  skills: Record<string, number>;
}
export interface ScenarioDef {
  id: string;
  skillId: string;
  seed: string;
}
export type CriterionId = 'technical_correctness' | 'completeness' | 'reasoning' | 'communication' | 'skill_evidence';
export const CRITERIA: readonly CriterionId[] = ['technical_correctness', 'completeness', 'reasoning', 'communication', 'skill_evidence'];
export interface RubricDef {
  id: string;
  questionTypes: string[];
  weights: Record<CriterionId, number>;
  guidance?: string;
  scored?: boolean;
}

export interface InterviewContent {
  version: string;
  skills: Map<string, SkillDef>;
  roles: Map<string, RoleDef>;
  tracks: Record<Track, { label: string; scenarios: ScenarioDef[] }>;
  rubrics: RubricDef[];
  rubricVersion: string;
  levels: Record<string, string>;
  criteria: Record<CriterionId, string>;
  templates: Record<string, string>;
}

function contentDir(cfg: AppConfig): string {
  if (cfg.CONTENT_DIR) return path.resolve(cfg.CONTENT_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/platform/content -> repo/content/interview ; dist/platform/content -> same depth
  return path.resolve(here, '../../../../../content/interview');
}

export function loadInterviewContent(dir: string): InterviewContent {
  const read = <T>(f: string): T => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as T;
  const skills = read<{ version: string; skills: SkillDef[] }>('skills.json');
  const roles = read<{ version: string; roles: RoleDef[] }>('roles.json');
  const tracks = read<{ tracks: InterviewContent['tracks'] }>('tracks.json');
  const rubrics = read<{ version: string; rubrics: RubricDef[]; levels: Record<string, string>; criteria: Record<CriterionId, string> }>('rubrics.json');
  const templates = read<{ templates: Record<string, string> }>('question-templates.json');

  const skillMap = new Map(skills.skills.map((s) => [s.id, s]));
  for (const role of roles.roles) {
    for (const id of Object.keys(role.skills)) {
      if (!skillMap.has(id)) throw new Error(`content: role ${role.id} references unknown skill ${id}`);
    }
  }
  for (const t of Object.values(tracks.tracks)) {
    for (const s of t.scenarios) if (!skillMap.has(s.skillId)) throw new Error(`content: scenario ${s.id} references unknown skill ${s.skillId}`);
  }
  return {
    version: `${skills.version}|${roles.version}|${rubrics.version}`,
    skills: skillMap,
    roles: new Map(roles.roles.map((r) => [r.id, r])),
    tracks: tracks.tracks,
    rubrics: rubrics.rubrics,
    rubricVersion: rubrics.version,
    levels: rubrics.levels,
    criteria: rubrics.criteria,
    templates: templates.templates,
  };
}

/**
 * Loads versioned interview content (role frameworks, skills, rubrics, templates) from content/,
 * kept apart from code so content ships by reviewed pull request (ADD §6). Rows are mirrored into
 * PostgreSQL so evidence and evaluations reference them by id and version.
 */
@Injectable()
export class ContentService {
  readonly interview: InterviewContent;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.interview = loadInterviewContent(contentDir(cfg));
  }

  skill(id: string): SkillDef | undefined {
    return this.interview.skills.get(id);
  }

  skillLabel(id: string): string {
    return this.interview.skills.get(id)?.label ?? id;
  }

  rubricFor(questionType: string): RubricDef {
    const r = this.interview.rubrics.find((x) => x.questionTypes.includes(questionType));
    if (!r) throw new Error(`no rubric for question type ${questionType}`);
    return r;
  }

  async seed(db: Database): Promise<void> {
    const c = this.interview;
    await db.system(async ({ db: tx }) => {
      for (const s of c.skills.values()) {
        await tx
          .insert(skillsTable)
          .values({ id: s.id, label: s.label, category: s.category, definition: s, contentVersion: c.version })
          .onConflictDoUpdate({
            target: skillsTable.id,
            set: { label: s.label, category: s.category, definition: s, contentVersion: c.version, updatedAt: sql`now()` },
          });
      }
      for (const r of c.rubrics) {
        await tx
          .insert(rubricsTable)
          .values({ id: r.id, version: c.rubricVersion, definition: { ...r, levels: c.levels, criteria: c.criteria } })
          .onConflictDoNothing();
      }
    });
  }
}

