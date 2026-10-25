import { discount, fingerprint, missingRefund, validateVoucher } from './voucher.rules';

const config = { code: ' save ', name: 'Save', status: 'active', startsAt: '2020-01-01', endsAt: '2099-01-01', discountType: 'percentage', discountValue: 12.34, scope: 'all', serviceIds: [], totalLimit: 5, perUserLimit: 1 };
describe('Voucher monetary rules', () => {
  it('calculates safe integer percentage with caps, including large safe money', () => {
    const v = validateVoucher(config);
    expect(v.code).toBe('SAVE');
    expect(discount(v, 999, 'anything')).toBe(123);
    expect(discount({ ...v, maxDiscount: 50 }, 999, 'anything')).toBe(50);
    expect(discount({ ...v, discountValue: 100 }, Number.MAX_SAFE_INTEGER, '')).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([0, -1, 100.01, 2.123, NaN, Infinity])('rejects invalid percentage %s', discountValue => {
    expect(() => validateVoucher({ ...config, discountValue })).toThrow();
  });
  it('rejects expired, paused, wrong product, low subtotal and unsafe money', () => {
    const v = validateVoucher(config);
    for (const patch of [{ endsAt: new Date(0) }, { status: 'paused' }, { scope: 'selected', serviceIds: ['other'] }, { minSubtotal: 101 }]) {
      expect(() => discount({ ...v, ...patch }, 100, 'service')).toThrow();
    }
    expect(() => discount(v, Number.MAX_SAFE_INTEGER + 1, '')).toThrow();
  });
  it('allocates missing units from NET paid integer money', () => {
    expect(missingRefund(701, 3, 1)).toBe(467);
    expect(missingRefund(Number.MAX_SAFE_INTEGER, 3, 2)).toBe(3002399751580330);
  });
  it('fingerprints object order canonically but distinguishes purchase payloads', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ quantity: 1 })).not.toBe(fingerprint({ quantity: 2 }));
  });
});
