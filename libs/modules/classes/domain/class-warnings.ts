export const TT29_PRIMARY_ACADEMIC = 'TT29_PRIMARY_ACADEMIC';

export interface ClassWarning {
  code: string;
  message: string;
}

/** Từ khóa (đã bỏ dấu, chữ thường) của môn nghệ thuật, thể thao, kỹ năng sống: không cảnh báo (US-9.3 AC2). */
const NON_ACADEMIC = [
  've',
  'my thuat',
  'am nhac',
  'nhac',
  'hat',
  'dan',
  'piano',
  'guitar',
  'organ',
  'violin',
  'trong',
  'mua',
  'khieu vu',
  'dance',
  'kich',
  'san khau',
  'hoi hoa',
  'thu cong',
  'nghe thuat',
  'the duc',
  'the thao',
  'boi',
  'bong da',
  'bong ro',
  'bong chuyen',
  'bong ban',
  'cau long',
  'tennis',
  'co vua',
  'co tuong',
  'vo',
  'karate',
  'taekwondo',
  'judo',
  'yoga',
  'aerobic',
  'chay',
  'ky nang',
  'thien',
];

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Cảnh báo không chặn của lớp (US-9.3): lớp khối 1 đến 5 với môn văn hóa.
 * shortcut: hợp đồng không có `subjectKind` (Spec §4.4 `classes.subject_kind`) nên suy từ tên môn: khớp từ khóa nghệ thuật/thể thao/
 * kỹ năng sống thì không cảnh báo, còn lại coi là văn hóa (thà cảnh báo thừa, người dùng bấm "Tôi đã hiểu"). Nâng lên cột
 * `subject_kind` khi hợp đồng thêm trường chọn nhóm môn.
 */
export function classWarnings(c: {
  grade: number;
  subject: string;
}): ClassWarning[] {
  if (c.grade < 1 || c.grade > 5) return [];
  const words = ` ${fold(c.subject)} `;
  if (NON_ACADEMIC.some((k) => words.includes(` ${k} `))) return [];
  return [
    {
      code: TT29_PRIMARY_ACADEMIC,
      message:
        'Lớp văn hóa khối 1 đến 5 thuộc nhóm có hạn chế theo Thông tư 29/2024/TT-BGDĐT. Xem thư viện quy định trước khi tuyển sinh.',
    },
  ];
}
