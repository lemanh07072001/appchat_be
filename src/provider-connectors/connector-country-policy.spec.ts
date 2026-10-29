import { assertPurchaseCountryInput, ConnectorPurchasePolicy, resolvePurchaseCountry, validatePurchasePolicy } from './connector-purchase-policy';
import { buildConnectorRequest } from './connector-request';
import { homeproxyPurchaseCandidate } from './homeproxy-template';

describe('Country purchase selection independent from ISP', () => {
  const policy: ConnectorPurchasePolicy = { protocols: ['http'], catalog: [{ field: 'id', equals: 'p' }],
    country: { mode: 'select', choices: [
      { code: 'us', name: 'Mỹ', value: 'USA', packageIds: ['p'] },
      { code: 'jp', name: 'Nhật', value: 'JPN', packageIds: ['p'] },
    ] } };
  const countries = [{ code: 'us', name: 'Mỹ' }, { code: 'jp', name: 'Nhật' }];
  it('maps public country codes independently of ISP', () => {
    validatePurchasePolicy(policy);
    expect(resolvePurchaseCountry(policy, 'jp', countries, 'p')).toEqual({ code: 'jp', name: 'Nhật', value: 'JPN' });
    expect(() => assertPurchaseCountryInput(policy, { country: 'JPN', packageId: 'p' })).not.toThrow();
  });
  it.each([undefined, '', 'JPN', 'Nhật', 'other', null])('rejects unknown or missing country %s', selected => {
    expect(() => resolvePurchaseCountry(policy, selected, countries, 'p')).toThrow();
  });
  it('requires a country-enabled policy and package and never defaults among countries', () => {
    expect(() => resolvePurchaseCountry(undefined, 'us', countries, 'p')).toThrow();
    expect(() => resolvePurchaseCountry(policy, 'us', countries, 'other')).toThrow();
    expect(() => assertPurchaseCountryInput(policy, { country: 'us', packageId: 'p' })).toThrow();
    expect(() => assertPurchaseCountryInput(policy, { country: 'USA', packageId: 'other' })).toThrow();
  });
  it('resolves one fixed country and rejects invalid country definitions', () => {
    const fixed = { ...policy, country: { mode: 'fixed' as const, choices: [policy.country!.choices[0]] } };
    expect(resolvePurchaseCountry(fixed, undefined, [countries[0]], 'p')?.value).toBe('USA');
    expect(() => validatePurchasePolicy({ ...policy, country: { mode: 'fixed', choices: [] } })).toThrow();
  });
  it('builds requests using only a valid pinned country API value', () => {
    const definition = homeproxyPurchaseCandidate();
    definition.purchasePolicy!.country = policy.country;
    definition.operations.buy.request = { body: { region: { path: '$.input.country' } } };
    const input = { packageId: 'p', protocol: 'http', username: 'user', password: 'pass', country: 'USA' };
    expect(JSON.parse(buildConnectorRequest(definition, 'buy', input, 'sample-token').body!)).toEqual({ region: 'USA' });
    expect(() => buildConnectorRequest(definition, 'buy', { ...input, country: 'us' }, 'sample-token')).toThrow();
  });
});
