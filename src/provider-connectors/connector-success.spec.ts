import { connectorSucceeded } from './connector-success';
import { validateConnectorDefinition } from './connector-definition';
import { homeproxyReadOnlyTemplate } from './homeproxy-template';

describe('Explicit read envelope assertions', () => {
  it.each([{ data: [] }, { data: [{ id: 'one' }] }])('accepts a real data array %#', ({ data }) => {
    expect(connectorSucceeded({ data }, { path: '$.data', type: 'array' })).toBe(true);
  });
  it.each([{}, { data: null }, { data: {} }, { data: '[]' }, { error: 'Unauthorized' }])('rejects malformed/error envelopes %#', response => {
    expect(connectorSucceeded(response, { path: '$.data', type: 'array' })).toBe(false);
  });
  it('preserves strict equality semantics', () => {
    expect(connectorSucceeded({ ok: true }, { path: '$.ok', equals: true })).toBe(true);
    expect(connectorSucceeded({ ok: 'true' }, { path: '$.ok', equals: true })).toBe(false);
  });
  it('cannot use array shape to confirm a paid write', () => {
    const definition = homeproxyReadOnlyTemplate();
    definition.operations.catalog.effect = 'write';
    expect(() => validateConnectorDefinition(definition)).toThrow();
  });
  it('rejects ambiguous predicates and unknown types', () => {
    for (const condition of [{ path: '$.data', type: 'array', equals: true }, { path: '$.data', type: 'object' }]) {
      const definition = homeproxyReadOnlyTemplate();
      definition.operations.check.response!.success = condition as any;
      expect(() => validateConnectorDefinition(definition)).toThrow();
    }
  });
  it('ships only bounded read actions, never a speculative purchase', () => {
    const definition = homeproxyReadOnlyTemplate();
    expect(definition.actions.buy).toBeUndefined();
    expect(Object.values(definition.operations).every(op => op.method === 'GET' && op.effect === 'read')).toBe(true);
  });
});
