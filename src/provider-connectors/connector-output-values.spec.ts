import { ConnectorOutput, mapConnectorOutput, validateConnectorOutput } from './connector-output';

describe('Explicit scalar provider value translations', () => {
  const mapping = (): ConnectorOutput => ({ items: { path: '$.data', fields: {
    protocol: { path: '$.protocol', type: 'string', required: true,
      values: [{ from: 'SOCKS', to: 'socks5' }, { from: 'HTTP', to: 'http' }] },
  } } });
  it('normalizes provider protocol names only using the configured table', () => {
    expect(mapConnectorOutput(mapping(), { data: [{ protocol: 'SOCKS' }, { protocol: 'HTTP' }] })).toEqual({
      fields: {}, items: [{ protocol: 'socks5' }, { protocol: 'http' }],
    });
  });
  it.each(['socks', 'https', 1, true, null])('rejects unknown or missing required provider values %s', protocol => {
    expect(() => mapConnectorOutput(mapping(), { data: [{ protocol }] })).toThrow('does not match');
  });
  it('keeps typed input values distinct without implicit coercion', () => {
    const d: ConnectorOutput = { fields: { state: { path: '$.state', type: 'boolean', values: [
      { from: 1, to: true }, { from: '1', to: false },
    ] } } };
    expect(mapConnectorOutput(d, { state: 1 }).fields.state).toBe(true);
    expect(mapConnectorOutput(d, { state: '1' }).fields.state).toBe(false);
    expect(() => mapConnectorOutput(d, { state: true })).toThrow();
  });
  it.each([
    [], [{ from: 'a', to: 'http' }, { from: 'a', to: 'socks5' }],
    [{ from: {}, to: 'http' }], [{ from: 'a', to: 1 }],
    [{ from: Infinity, to: 'http' }], [{ from: 'a', to: 'http', script: 'x' }],
  ].map(values => ({ values })))('rejects malformed translation tables %#', ({ values }) => {
    const d = mapping(); (d.items!.fields.protocol as any).values = values;
    expect(() => validateConnectorOutput(d)).toThrow();
  });
  it('does not permit value translations to bypass date validation', () => {
    const d = mapping(); d.items!.fields.protocol.type = 'isoDate';
    expect(() => validateConnectorOutput(d)).toThrow();
  });
});
