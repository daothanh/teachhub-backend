// Quy tắc tài khoản nhận tiền; thuần, không phụ thuộc NestJS/Drizzle.

export const MAX_PAYOUT_ACCOUNTS = 5;

/** Che số tài khoản, chỉ giữ 4 số cuối (`******6789`); số đầy đủ không rời khỏi server qua API này. */
export const maskAccountNo = (accountNo: string): string =>
  `${'*'.repeat(Math.max(accountNo.length - 4, 0))}${accountNo.slice(-4)}`;
