// Kiểm thứ tự migration của drizzle-kit (ADR-TH-BE-001 §5): migrator chỉ chạy migration có `when`
// lớn hơn migration mới nhất đã chạy, nên migration sinh trên nhánh cũ sẽ bị bỏ qua im lặng.
// Dùng: node scripts/check-migrations.mjs [journal của nhánh đích]
import { existsSync, readFileSync } from 'node:fs';

const DIR = 'libs/db/migrations';
const read = (file) => JSON.parse(readFileSync(file, 'utf8')).entries;
const entries = read(`${DIR}/meta/_journal.json`);
const errors = [];

entries.forEach((e, i) => {
  if (e.idx !== i) errors.push(`${e.tag}: idx ${e.idx}, cần ${i}`);
  if (!existsSync(`${DIR}/${e.tag}.sql`)) errors.push(`${e.tag}: thiếu file .sql`);
  if (!e.tag.startsWith(String(i).padStart(4, '0') + '_'))
    errors.push(`${e.tag}: tên phải bắt đầu bằng ${String(i).padStart(4, '0')}_`);
  if (i > 0 && e.when <= entries[i - 1].when)
    errors.push(`${e.tag}: when không tăng so với ${entries[i - 1].tag}`);
});

const baseFile = process.argv[2];
if (baseFile && existsSync(baseFile)) {
  const base = read(baseFile);
  const baseTags = new Set(base.map((e) => e.tag));
  const lastBaseWhen = Math.max(0, ...base.map((e) => e.when));
  base.forEach((e, i) => {
    if (entries[i]?.tag !== e.tag)
      errors.push(`migration của nhánh đích bị đổi/xóa: ${e.tag}`);
  });
  for (const e of entries.filter((x) => !baseTags.has(x.tag)))
    if (e.when <= lastBaseWhen)
      errors.push(
        `${e.tag}: sinh trước migration mới nhất của nhánh đích → sẽ bị bỏ qua. Rebase rồi xóa và sinh lại.`,
      );
}

if (errors.length) {
  console.error(`Migration không hợp lệ:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK: ${entries.length} migration theo đúng thứ tự.`);
