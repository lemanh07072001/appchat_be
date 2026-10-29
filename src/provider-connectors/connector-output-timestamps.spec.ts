import { mapConnectorOutput, validateConnectorOutput } from './connector-output';

describe('Explicit provider timestamp units', () => {
  const mapping = (type: 'unixSeconds' | 'unixMilliseconds') => ({ fields: { expiresAt: { path: '$.expires', type, required: true } } });
  it('normalizes explicitly selected units to ISO without magnitude guessing', () => {
    expect(mapConnectorOutput(mapping('unixSeconds'), { expires: 1800000000 }).fields.expiresAt).toBe('2027-01-15T08:00:00.000Z');
    expect(mapConnectorOutput(mapping('unixMilliseconds'), { expires: 1800000000000 }).fields.expiresAt).toBe('2027-01-15T08:00:00.000Z');
    expect(mapConnectorOutput(mapping('unixMilliseconds'), { expires: 1800000000 }).fields.expiresAt).toBe('1970-01-21T20:00:00.000Z');
  });
  it.each(['1800000000', -1, 1.5, Infinity, NaN, null, undefined, Number.MAX_SAFE_INTEGER])('rejects invalid timestamp %#', expires => {
    expect(() => mapConnectorOutput(mapping('unixSeconds'), { expires })).toThrow();
  });
  it('does not allow scalar translations to bypass timestamp checks', () => {
    expect(() => validateConnectorOutput({ fields: { expiresAt: { path: '$.expires', type: 'unixSeconds', values: [{ from: 'x', to: 1 }] } } })).toThrow();
  });
});
