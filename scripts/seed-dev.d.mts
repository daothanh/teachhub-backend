import type pg from 'pg';

export function assertDevEnvironment(
  env?: Record<string, string | undefined>,
): void;
export function linkParents(
  pool: pg.Pool,
  opts: { studentId: string; parentX: string; parentY: string },
): Promise<{ x: string; y: string }>;
