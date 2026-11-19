// Sinh payload VietQR (EMVCo MPM, chuẩn NAPAS) cho hóa đơn. Hàm thuần, không gọi API ngoài (Technical Spec A7).

const MAX_AMOUNT = 100_000_000_000n; // 100 tỷ đồng
const NOTE_RE = /^[A-Z0-9 ]{1,25}$/;

export interface VietQrInput {
  /** Mã BIN ngân hàng, đúng 6 chữ số. */
  bankBin: string;
  /** Số tài khoản, 6-19 chữ số. */
  accountNo: string;
  /** Số tiền nguyên đồng, > 0. */
  amount: bigint | number;
  /** Nội dung chuyển khoản, dạng `TH xxxxxx`: chữ in hoa, số, dấu cách, 1-25 ký tự. */
  transferNote: string;
}

/** Một trường TLV: tag 2 ký tự + độ dài 2 chữ số + giá trị. Giá trị là ASCII nên độ dài chuỗi = độ dài byte. */
const tlv = (tag: string, value: string): string => {
  if (value.length > 99) {
    throw new RangeError(`trường TLV ${tag} dài quá 99 ký tự: ${value.length}`);
  }
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
};

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF), trả 4 ký tự HEX hoa. */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function buildVietQrPayload(input: VietQrInput): string {
  const { bankBin, accountNo, amount, transferNote } = input;
  if (!/^\d{6}$/.test(bankBin)) {
    throw new RangeError(`bankBin phải đúng 6 chữ số: ${bankBin}`);
  }
  if (!/^\d{6,19}$/.test(accountNo)) {
    throw new RangeError('accountNo phải gồm 6-19 chữ số');
  }
  if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
    throw new RangeError(`amount phải là số nguyên đồng: ${amount}`);
  }
  const amt = BigInt(amount);
  if (amt <= 0n || amt > MAX_AMOUNT) {
    throw new RangeError(`amount phải trong khoảng 1..${MAX_AMOUNT}: ${amt}`);
  }
  if (!NOTE_RE.test(transferNote)) {
    throw new RangeError(
      `transferNote phải khớp ${NOTE_RE.source}: ${transferNote}`,
    );
  }

  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv(
      '38',
      tlv('00', 'A000000727') +
        tlv('01', tlv('00', bankBin) + tlv('01', accountNo)) +
        tlv('02', 'QRIBFTTA'),
    ) +
    tlv('53', '704') +
    tlv('54', amt.toString()) +
    tlv('58', 'VN') +
    tlv('62', tlv('08', transferNote)) +
    '6304';
  return body + crc16(body);
}
