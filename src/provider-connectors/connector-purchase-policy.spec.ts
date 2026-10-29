import { validateConnectorDefinition } from './connector-definition';
import { homeproxyPurchaseCandidate } from './homeproxy-template';
import { buildConnectorRequest } from './connector-request';
import { assertPurchasePackage, assertPurchaseProtocols, preparePurchaseCredentials, resolvePurchaseProtocol, validatePurchasePolicy } from './connector-purchase-policy';

describe('Declarative purchase eligibility', () => {
  it.each(['http', 'socks5'])('resolves fixed %s without customer selection', protocol => {
    const policy = { protocols: [protocol], protocolMode: 'fixed' as const, catalog: [{ field: 'id', equals: 'p' }] };
    validatePurchasePolicy(policy);
    expect(resolvePurchaseProtocol(policy, undefined, [protocol])).toBe(protocol);
    expect(() => resolvePurchaseProtocol(policy, protocol === 'http' ? 'socks5' : 'http', [protocol])).toThrow();
  });
  it('requires an explicit selection for selectable protocols', () => {
    const policy = { protocols: ['http', 'socks5'], protocolMode: 'select' as const, catalog: [{ field: 'id', equals: 'p' }] };
    validatePurchasePolicy(policy);
    expect(() => resolvePurchaseProtocol(policy, undefined, policy.protocols)).toThrow();
    expect(resolvePurchaseProtocol(policy, 'socks5', policy.protocols)).toBe('socks5');
  });
  it('dual mode omits protocol and never accepts an artificial single selection', () => {
    const definition = homeproxyPurchaseCandidate();
    definition.purchasePolicy!.protocolMode = 'dual';
    definition.purchasePolicy!.protocols = ['http', 'socks5'];
    expect(resolvePurchaseProtocol(definition.purchasePolicy, undefined, ['http', 'socks5'])).toBeUndefined();
    expect(() => resolvePurchaseProtocol(definition.purchasePolicy, 'http', ['http', 'socks5'])).toThrow();
    expect(() => resolvePurchaseProtocol(definition.purchasePolicy, undefined, ['http'])).toThrow();
    // Request shape is independent: this generic example provider does not want protocol.
    definition.operations.buy.request = { body: { quantity: { path: '$.input.quantity' } } };
    const request = buildConnectorRequest(definition, 'buy', { quantity: 1, username: 'user', password: 'pass' }, 'sample-token');
    expect(JSON.parse(request.body!)).toEqual({ quantity: 1 });
    expect(() => buildConnectorRequest(definition, 'buy', { protocol: 'http' }, 'sample-token')).toThrow();
  });
  it.each([
    { protocolMode: 'unknown', protocols: ['http'] }, { protocolMode: 'fixed', protocols: ['http', 'socks5'] },
    { protocolMode: 'select', protocols: ['http'] }, { protocolMode: 'dual', protocols: ['http', 'https'] },
  ])('rejects inconsistent protocol mode %#', selection => {
    expect(() => validatePurchasePolicy({ ...selection, catalog: [{ field: 'id', equals: 'p' }] })).toThrow();
  });
  const valid = { id: 'p', provider: 'VIETTEL', categoryType: 1, billingUnit: 'ngày', statusId: 1 };
  it('accepts only exact typed catalog metadata', () => {
    const policy = homeproxyPurchaseCandidate().purchasePolicy;
    expect(() => assertPurchasePackage(policy, valid)).not.toThrow();
    for (const item of [{ ...valid, provider: 'VNPT' }, { ...valid, categoryType: 2 },
      { ...valid, categoryType: '1' }, { ...valid, billingUnit: 'tháng' }, { ...valid, statusId: 2 }, { id: 'p' }]) {
      expect(() => assertPurchasePackage(policy, item)).toThrow('purchase policy');
    }
  });
  it.each([[], ['socks5'], ['http', 'https'], ['HTTP']].map(protocols => ({ protocols })))('rejects unsupported service protocols $protocols', ({ protocols }) => {
    expect(() => assertPurchaseProtocols(homeproxyPurchaseCandidate().purchasePolicy, protocols)).toThrow();
  });
  it.each(['socks5', 'https', undefined])('blocks mismatched protocol before assembling a write: %s', protocol => {
    expect(() => buildConnectorRequest(homeproxyPurchaseCandidate(), 'buy', { protocol }, 'sample-token')).toThrow('purchase policy');
  });
  it('generates fresh credentials only with explicit policy opt-in', () => {
    const policy = homeproxyPurchaseCandidate().purchasePolicy;
    const first = preparePurchaseCredentials(policy, {});
    const second = preparePurchaseCredentials(policy, {});
    expect(first.username).toMatch(/^u[0-9a-f]{12}$/);
    expect(first.password).toMatch(/^p[0-9a-f]{24}$/);
    expect(first).not.toEqual(second);
    expect(preparePurchaseCredentials(undefined, {})).toEqual({});
  });
  it('preserves a complete supplied credential pair byte for byte', () => {
    const provided = { username: 'sample-user', password: ' password with spaces ' };
    expect(preparePurchaseCredentials(homeproxyPurchaseCandidate().purchasePolicy, provided)).toEqual(provided);
  });
  it.each([{ username: 'sample-user' }, { password: 'sample-password' },
    { username: '', password: '' }, { username: 'sample-user', password: '  ' }])(
    'does not silently replace partial or invalid credentials %#', provided => {
      expect(() => preparePurchaseCredentials(homeproxyPurchaseCandidate().purchasePolicy, provided)).toThrow();
    });
  it.each(['unknown-key', 'missing-field', 'wrong-type', 'duplicate-rule', 'empty-protocols', 'workflow-catalog', 'invalid-input', 'duplicate-input', 'invalid-generation', 'generation-without-required-pair'])(
    'refuses invalid eligibility configuration: %s', reason => {
      const definition = homeproxyPurchaseCandidate();
      if (reason === 'unknown-key') (definition.purchasePolicy as any).script = 'return true';
      if (reason === 'missing-field') delete definition.operations.catalog.output!.items!.fields.provider;
      if (reason === 'wrong-type') definition.purchasePolicy!.catalog[0].equals = 1;
      if (reason === 'duplicate-rule') definition.purchasePolicy!.catalog.push(definition.purchasePolicy!.catalog[0]);
      if (reason === 'empty-protocols') definition.purchasePolicy!.protocols = [];
      if (reason === 'workflow-catalog') delete definition.actions.catalog;
      if (reason === 'invalid-input') definition.purchasePolicy!.requiredTextInputs = ['token'] as any;
      if (reason === 'duplicate-input') definition.purchasePolicy!.requiredTextInputs = ['username', 'username'];
      if (reason === 'invalid-generation') definition.purchasePolicy!.credentialGeneration = 'script' as any;
      if (reason === 'generation-without-required-pair') definition.purchasePolicy!.requiredTextInputs = ['username'];
      expect(() => validateConnectorDefinition(definition)).toThrow();
    });
});
