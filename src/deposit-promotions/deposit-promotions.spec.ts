import { calculateQuote, intentEligible, vnd } from './deposit-promotions.service';

describe('Deposit promotion calculations', () => {
  const program = { _id: 'p1', name: 'Bonus', maxBonus: 25_000, tiers: [
    { minAmount: 100_000, rate: 10 }, { minAmount: 200_000, rate: 15.25 },
  ] };
  it('selects the highest floor, floors fractional VND, and caps per receipt', () => {
    expect(calculateQuote(99_999, program).bonusAmount).toBe(0);
    expect(calculateQuote(100_009, program).bonusAmount).toBe(10_000);
    expect(calculateQuote(200_000, program)).toMatchObject({ rate: 15.25, bonusAmount: 25_000, totalAmount: 225_000 });
    expect(calculateQuote(100_000)).toMatchObject({ promotionId: null, rate: 0, bonusAmount: 0 });
  });
  it('rejects fractions, unsafe values, strings, below-minimum deposits and overflow', () => {
    for (const value of [NaN, Infinity, -1, 1.5, '10000', Number.MAX_SAFE_INTEGER + 1]) expect(() => vnd(value)).toThrow();
    expect(() => calculateQuote(9999)).toThrow();
    expect(() => calculateQuote(Number.MAX_SAFE_INTEGER, program)).toThrow();
  });
  it('uses actual transfer time, including the expiry boundary, and verifies owner/amount', () => {
    const intent = { userId: 'u1', quote: { amount: 100_000 }, issuedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-01T00:15:00Z') };
    expect(intentEligible(intent, 'u1', 100_000, intent.expiresAt)).toBe(true);
    expect(intentEligible(intent, 'u1', 100_000, new Date('2026-01-01T00:15:00.001Z'))).toBe(false);
    expect(intentEligible(intent, 'u1', 100_000, new Date('2025-12-31T23:59:59Z'))).toBe(false);
    expect(intentEligible(intent, 'u2', 100_000, intent.issuedAt)).toBe(false);
    expect(intentEligible(intent, 'u1', 100_001, intent.issuedAt)).toBe(false);
  });
  it('accepts a second-precision bank timestamp in the issuance second but keeps expiry exact', () => {
    const intent = { userId: 'u1', quote: { amount: 100_000 }, issuedAt: new Date('2026-01-01T00:00:00.789Z'), expiresAt: new Date('2026-01-01T00:15:00.789Z') };
    expect(intentEligible(intent, 'u1', 100_000, new Date('2026-01-01T00:00:00Z'))).toBe(true);
    expect(intentEligible(intent, 'u1', 100_000, new Date('2025-12-31T23:59:59.999Z'))).toBe(false);
    expect(intentEligible(intent, 'u1', 100_000, intent.expiresAt)).toBe(true);
    expect(intentEligible(intent, 'u1', 100_000, new Date('2026-01-01T00:15:00.790Z'))).toBe(false);
  });
});
