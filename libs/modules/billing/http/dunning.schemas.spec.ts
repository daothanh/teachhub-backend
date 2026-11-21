import { dunningOffsetsSchema } from './dunning.schemas.js';

describe('hợp đồng nhắc nợ Sprint 6', () => {
  it('mốc nhắc: tăng dần, không trùng, 1 đến 6 mốc, trong -7..30', () => {
    expect(dunningOffsetsSchema.safeParse([-1, 0, 3, 7]).success).toBe(true);
    for (const bad of [
      [],
      [0, 0],
      [3, 1],
      [-8],
      [31],
      [-3, -2, -1, 0, 1, 2, 3],
    ]) {
      expect(dunningOffsetsSchema.safeParse(bad).success).toBe(false);
    }
  });
});
