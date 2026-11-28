import {
  canCancelAbsence,
  checkReportable,
  STUDENT_ABSENCE_REPORTED,
} from './absence-request.js';

const now = new Date('2026-12-15T10:00:00Z');
const at = (iso: string) => new Date(iso);

describe('luật thời gian báo vắng trước', () => {
  it('buổi chưa bắt đầu và không hủy → báo được', () => {
    expect(
      checkReportable(
        { status: 'planned', startsAt: at('2026-12-15T10:00:01Z') },
        now,
      ),
    ).toBe('ok');
  });

  it('đúng giờ bắt đầu hoặc đã qua → started (không chọn được buổi đó)', () => {
    expect(checkReportable({ status: 'planned', startsAt: now }, now)).toBe(
      'started',
    );
    expect(
      checkReportable(
        { status: 'taught', startsAt: at('2026-12-14T10:00:00Z') },
        now,
      ),
    ).toBe('started');
  });

  it('buổi hủy → cancelled, xét trước giờ', () => {
    expect(
      checkReportable(
        { status: 'cancelled', startsAt: at('2026-12-16T10:00:00Z') },
        now,
      ),
    ).toBe('cancelled');
    expect(
      checkReportable(
        { status: 'cancelled', startsAt: at('2026-12-14T10:00:00Z') },
        now,
      ),
    ).toBe('cancelled');
  });

  it('chỉ hủy được trước giờ bắt đầu', () => {
    expect(canCancelAbsence(at('2026-12-15T10:00:01Z'), now)).toBe(true);
    expect(canCancelAbsence(now, now)).toBe(false);
    expect(canCancelAbsence(at('2026-12-15T09:59:59Z'), now)).toBe(false);
  });

  it('tên sự kiện outbox khớp hàm CSDL và consumer', () => {
    expect(STUDENT_ABSENCE_REPORTED).toBe('student_absence_reported');
  });
});
