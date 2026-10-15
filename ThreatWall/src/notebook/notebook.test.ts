import { describe, expect, test } from 'vitest';
import { TASKS } from '../tasks';
import { LESSONS } from './lessons';
import { DIAGRAM_IDS } from './Diagram';

describe('learning notebook', () => {
  test('every task has a lesson with concept, mechanism, terms and self-check', () => {
    for (const t of TASKS) {
      const l = LESSONS[t.id];
      expect(l, `lesson ${t.id}`).toBeTruthy();
      expect(l.concept.length).toBeGreaterThan(0);
      expect(l.how.length).toBeGreaterThan(0);
      expect(l.terms.length).toBeGreaterThan(0);
      expect(l.check.length).toBeGreaterThan(0);
    }
    expect(Object.keys(LESSONS).sort()).toEqual(TASKS.map((t) => t.id).sort());
  });
  test('every lesson diagram exists', () => {
    for (const [id, l] of Object.entries(LESSONS)) expect(DIAGRAM_IDS, `diagram for ${id}`).toContain(l.diagram);
  });
  test('no real vendor or real-world domains in the teaching text', () => {
    const text = JSON.stringify(LESSONS).toLowerCase();
    for (const bad of ['sonicwall', 'sonicos', 'fortinet', 'google.com', 'mysonicwall']) expect(text).not.toContain(bad);
  });
});
