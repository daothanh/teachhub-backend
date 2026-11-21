import { describe, expect, it } from 'vitest';
import { reminderOffset } from './lifecycle.js';

describe('reminderOffset (US-0.8 AC5)', () => {
  it.each([
    [0, null],
    [-3, null],
    [1, 1],
    [2, 7],
    [7, 7],
    [8, null],
    [365, null],
  ])('còn %s ngày → mốc %s', (days, want) => {
    expect(reminderOffset(days)).toBe(want);
  });
});
