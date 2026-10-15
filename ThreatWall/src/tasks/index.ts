import type { TaskDef } from './types';
import { LEVEL0 } from './level0';
import { LEVEL1 } from './level1';
import { LEVEL2 } from './level2';
import { LEVEL3 } from './level3';
import { LEVEL4 } from './level4';

export const TASKS: TaskDef[] = [...LEVEL0, ...LEVEL1, ...LEVEL2, ...LEVEL3, ...LEVEL4];
