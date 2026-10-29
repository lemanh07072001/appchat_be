import { assertPurchaseIspInput, ConnectorPurchasePolicy, resolvePurchaseIsp, validatePurchasePolicy } from './connector-purchase-policy';
import { homeproxyPurchaseCandidate } from './homeproxy-template';
import { buildConnectorRequest } from './connector-request';

describe('Versioned ISP purchase selection', () => {
  const policy = (): ConnectorPurchasePolicy => ({ protocols: ['http'], catalog: [{ field: 'id', equals: 'p' }],
    isp: { mode: 'select', choices: [
      { code: 'network-a', name: 'Nhà mạng A', value: 'API_A', packageIds: ['p'] },
      { code: 'random', name: 'Ngẫu nhiên', value: 'ALL', packageIds: ['p', 'q'] },
    ] } });
  const available = [{ code: 'network-a', name: 'Tên dịch vụ' }, { code: 'random', name: 'Ngẫu nhiên' }];
  it('maps exact public code to API value and pins the versioned label', () => {
    validatePurchasePolicy(policy());
    expect(resolvePurchaseIsp(policy(), 'network-a', available, 'p'))
      .toEqual({ code: 'network-a', name: 'Nhà mạng A', value: 'API_A' });
    expect(resolvePurchaseIsp(policy(), 'random', available, 'p')?.value).toBe('ALL');
  });
  it.each([undefined, '', 'Nhà mạng A', 'API_A', 'other', null, 1])('rejects missing/unknown selection %s', selected => {
    expect(() => resolvePurchaseIsp(policy(), selected, available, 'p')).toThrow();
  });
  it('does not allow choices from another service or package', () => {
    expect(() => resolvePurchaseIsp(policy(), 'network-a', [available[1]], 'p')).toThrow();
    expect(() => resolvePurchaseIsp(policy(), 'network-a', available, 'q')).toThrow();
    expect(() => resolvePurchaseIsp(policy(), 'network-a', [...available, available[0]], 'p')).toThrow();
  });
  it('resolves fixed choice without customer selection, never defaults among several', () => {
    const p = policy(); p.isp = { mode: 'fixed', choices: [p.isp!.choices[0]] };
    validatePurchasePolicy(p);
    expect(resolvePurchaseIsp(p, undefined, [available[0]], 'p')?.value).toBe('API_A');
    expect(() => assertPurchaseIspInput(p, { packageId: 'p' })).toThrow();
  });
  it('none and old policies reject selected ISP and stale service options', () => {
    for (const p of [undefined, { ...policy(), isp: { mode: 'none' as const, choices: [] } }]) {
      expect(resolvePurchaseIsp(p, undefined, [], 'p')).toBeUndefined();
      expect(() => resolvePurchaseIsp(p, 'network-a', available, 'p')).toThrow();
      expect(() => resolvePurchaseIsp(p, undefined, available, 'p')).toThrow();
      expect(() => assertPurchaseIspInput(p, { isp: 'API_A' })).toThrow();
    }
  });
  it('workers validate pinned API value and package without resolving names/defaults', () => {
    expect(() => assertPurchaseIspInput(policy(), { isp: 'API_A', packageId: 'p' })).not.toThrow();
    for (const input of [{ isp: 'network-a', packageId: 'p' }, { isp: 'API_A', packageId: 'q' }, { packageId: 'p' }]) {
      expect(() => assertPurchaseIspInput(policy(), input)).toThrow();
    }
    const definition = homeproxyPurchaseCandidate(); definition.purchasePolicy!.isp = policy().isp;
    definition.operations.buy.request = { body: { network: { path: '$.input.isp' } } };
    const request = buildConnectorRequest(definition, 'buy', { protocol: 'http', packageId: 'p', isp: 'API_A',
      username: 'user', password: 'pass' }, 'sample-token');
    expect(JSON.parse(request.body!)).toEqual({ network: 'API_A' });
  });
  it.each(['mode', 'empty-select', 'duplicate', 'blank', 'control', 'script', 'package', 'fixed-many', 'none-choices'])('rejects invalid ISP definition: %s', reason => {
    const p = policy(); const config = p.isp!;
    if (reason === 'mode') (config as any).mode = 'random';
    if (reason === 'empty-select') config.choices = [];
    if (reason === 'duplicate') config.choices.push(config.choices[0]);
    if (reason === 'blank') config.choices[0].value = ' ';
    if (reason === 'control') config.choices[0].code = 'a\n';
    if (reason === 'script') (config.choices[0] as any).script = 'run';
    if (reason === 'package') config.choices[0].packageIds = [];
    if (reason === 'fixed-many') config.mode = 'fixed';
    if (reason === 'none-choices') config.mode = 'none';
    expect(() => validatePurchasePolicy(p)).toThrow();
  });
});
