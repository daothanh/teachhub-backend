import { guardianInviteStatus, mergeInviteStatus } from './invite-status.js';

const now = new Date('2026-12-15T00:00:00Z');
const inv = (status: 'pending' | 'used' | 'revoked', days: number) => ({
  id: 'i',
  status,
  expiresAt: new Date(now.getTime() + days * 86_400_000),
});

describe('trạng thái mời', () => {
  it.each([
    [{ userId: null }, undefined, 'not_invited'],
    [{ userId: null }, inv('pending', 1), 'invited'],
    [{ userId: null }, inv('pending', -1), 'expired'],
    [{ userId: null }, inv('revoked', 1), 'not_invited'],
    [{ userId: null }, inv('used', 1), 'activated'],
    [{ userId: 'u' }, inv('revoked', 1), 'activated'],
  ] as const)('%j + %j → %s', (g, latest, want) => {
    expect(guardianInviteStatus(g, latest, now)).toBe(want);
  });

  it('gộp theo học viên: activated > invited > expired > not_invited', () => {
    expect(mergeInviteStatus([])).toBe('not_invited');
    expect(mergeInviteStatus(['expired', 'not_invited'])).toBe('expired');
    expect(mergeInviteStatus(['expired', 'invited'])).toBe('invited');
    expect(mergeInviteStatus(['not_invited', 'activated', 'invited'])).toBe(
      'activated',
    );
  });
});
