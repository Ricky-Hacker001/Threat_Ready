// Scenario registry: the 36 level scenarios plus the guided demo. The
// engine, API and UI are scenario-agnostic; adding a scenario is one module
// here.

import demo from './demo-portal.js';
import { F3, E1, I1 } from './legacy.js';
import { FOUNDATIONS } from './foundations/index.js';
import { INTERMEDIATE } from './intermediate/index.js';
import { EXPERT } from './expert/index.js';

const order = (code) => ({ F: 1, I: 2, E: 3 }[code[0]] * 100 + Number(code.slice(1)));
const LEVEL_SCENARIOS = [F3, I1, E1, ...FOUNDATIONS, ...INTERMEDIATE, ...EXPERT]
  .filter((s) => s.ready !== false)
  .sort((a, b) => order(a.code) - order(b.code));

// Hidden scenarios are reachable by id for the guided demo and the
// walkthrough preview only. They are never listed and cannot be started
// through the attempt API.
const HIDDEN = [demo];
const byId = new Map([...LEVEL_SCENARIOS, ...HIDDEN].map((s) => [s.id, s]));

export const getScenario = (id) => byId.get(id);
export const allLevelScenarios = () => LEVEL_SCENARIOS;
export const levelScenarios = (level) => LEVEL_SCENARIOS.filter((s) => s.level === level);

// Catalogue entries are deliberately neutral: they describe the alert an
// analyst would see, not what is behind it.
export const listScenarios = () => LEVEL_SCENARIOS.map((s) => ({
  id: s.id,
  code: s.code,
  level: s.level,
  ...s.catalog,
  stages: s.stages.filter((x) => x.kind !== 'monitor').map((x) => x.label),
}));
