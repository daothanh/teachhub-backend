import { classWarnings, TT29_PRIMARY_ACADEMIC } from './class-warnings.js';

const codes = (grade: number, subject: string) =>
  classWarnings({ grade, subject }).map((w) => w.code);

describe('classWarnings (US-9.3)', () => {
  it('lớp văn hóa khối 1 đến 5 → cảnh báo TT29', () => {
    for (const grade of [1, 3, 5]) {
      expect(codes(grade, 'Toán')).toEqual([TT29_PRIMARY_ACADEMIC]);
    }
    expect(codes(2, 'Tiếng Việt')).toEqual([TT29_PRIMARY_ACADEMIC]);
  });

  it('khối 6 trở lên không cảnh báo', () => {
    expect(codes(6, 'Toán')).toEqual([]);
    expect(codes(12, 'Văn')).toEqual([]);
  });

  it('môn nghệ thuật, thể thao, kỹ năng sống khối tiểu học không cảnh báo (kể cả không dấu, hoa thường)', () => {
    for (const s of [
      'Vẽ',
      'Mỹ thuật',
      'Âm nhạc',
      'Đàn piano',
      'Múa',
      'Bơi',
      'Cờ vua',
      'Võ',
      'Kỹ năng sống',
      'GUITAR',
      'the duc',
    ])
      expect(codes(3, s), s).toEqual([]);
  });

  it('không khớp nhầm từ khóa nằm trong từ khác', () => {
    expect(codes(4, 'Toán tư duy')).toEqual([TT29_PRIMARY_ACADEMIC]);
    expect(codes(4, 'Tiếng Anh giao tiếp')).toEqual([TT29_PRIMARY_ACADEMIC]);
  });
});
