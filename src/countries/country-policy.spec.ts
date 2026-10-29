import { CountryPolicyService } from './country-policy.service';
import { countryProviderParams, publicOrderConfig, validateCountryConfig } from './country-policy';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateServiceDto } from '../dto/create-service.dto';

describe('Country policy', () => {
  let resolver: CountryPolicyService;
  let partner: any;
  let provider: any;
  let countries: any;
  beforeEach(() => {
    partner = { code: 'gpnip', token_api: 'secret', country_source: 'manual', country_options: [{ code: 'US', name: 'United States', provider_value: 'us-provider' }] };
    provider = { capabilities: { countrySelection: true }, listCountriesForPackage: jest.fn().mockResolvedValue({ iso_codes: ['US', 'VN'] }) };
    countries = { findById: jest.fn(() => ({ exec: async () => ({ code: 'US' }) })), findOne: jest.fn(() => ({ exec: async () => null })) };
    resolver = new CountryPolicyService({ findById: () => ({ exec: async () => partner }) } as any, countries,
      { getProvider: () => provider } as any);
  });
  const inherited = { partner: 'p', country_source: 'inherit', id_service: '42' };
  it('inherits manual options and snapshots auto-selected mapping/package', async () => {
    expect(await resolver.select(inherited, undefined, 30, partner)).toEqual({ source: 'manual', code: 'US', provider_value: 'us-provider', package_id: '42' });
    expect(await resolver.effective(inherited)).toMatchObject({ source: 'manual', status: 'ready', countries: [{ code: 'US', name: 'United States' }], requires_selection: false });
    expect(JSON.stringify(await resolver.effective(inherited))).not.toContain('us-provider');
  });
  it('service override wins over inherited source/options', async () => {
    expect(await resolver.select({ ...inherited, country_source: 'manual', country_options: [{ code: 'VN' }] }, 'vn', 30, partner)).toMatchObject({ code: 'VN', provider_value: 'VN' });
  });
  it('leaves undefined service policy legacy even when partner configured', async () => {
    expect(await resolver.select({ partner: 'p' }, 'anything', 30, partner)).toBeUndefined();
    expect(await resolver.effective({ partner: 'p' })).toMatchObject({ source: 'legacy', status: 'ready' });
  });
  it('none rejects selection and never requests API coverage', async () => {
    const service = { ...inherited, country_source: 'none' };
    await expect(resolver.select(service, 'US')).rejects.toThrow('does not accept');
    expect(await resolver.select(service)).toEqual({ source: 'none', package_id: '42' });
    expect(provider.listCountriesForPackage).not.toHaveBeenCalled();
  });
  it('filters allowlist and blocks empty coverage without treating it as none', async () => {
    const service = { ...inherited, country_source: 'api', country_sales_mode: 'allowlist', country_allowlist: [] };
    expect(await resolver.effective(service)).toMatchObject({ source: 'api', status: 'unavailable', countries: [] });
    await expect(resolver.select(service)).rejects.toThrow('unavailable');
    expect(await resolver.select({ ...service, country_allowlist: ['VN'] })).toMatchObject({ code: 'VN' });
    await expect(resolver.select({ ...service, country_allowlist: ['VN'] }, 'US')).rejects.toThrow('available country');
  });
  it('requires selection for multiple countries and accepts legacy ID/name', async () => {
    const service = { ...inherited, country_source: 'api' };
    expect((await resolver.effective(service)).requires_selection).toBe(true);
    await expect(resolver.select(service)).rejects.toThrow('Select');
    expect(await resolver.select(service, '000000000000000000000001')).toMatchObject({ code: 'US' });
    countries.findOne.mockReturnValue({ exec: async () => ({ code: 'VN' }) });
    expect(await resolver.select(service, 'Vietnam')).toMatchObject({ code: 'VN' });
  });
  it('uses duration mapping for exact package and caches successful empty results', async () => {
    provider.listCountriesForPackage.mockResolvedValue({ iso_codes: [] });
    const service = { ...inherited, country_source: 'api', duration_ids: { '7': 'seven' } };
    expect((await resolver.effective(service, 7)).status).toBe('unavailable');
    await resolver.effective(service, 7);
    expect(provider.listCountriesForPackage).toHaveBeenCalledTimes(1);
    expect(provider.listCountriesForPackage).toHaveBeenCalledWith('secret', 'seven');
    await resolver.effective(service, 30);
    expect(provider.listCountriesForPackage).toHaveBeenLastCalledWith('secret', '42');
  });
  it('requires ISP before coverage and caches by actual variant package', async () => {
    const service = { ...inherited, country_source: 'api', isp: [
      { name: 'FPT FP1', code: 'fpt_fp1', duration_ids: { '7': 'fp1-week' } },
      { name: 'FPT FP2', code: 'fpt_fp2', provider_product_id: 'fp2' },
    ] };
    await expect(resolver.effective(service, 7)).rejects.toThrow('ISP selection required');
    expect(provider.listCountriesForPackage).not.toHaveBeenCalled();
    await resolver.effective(service, 7, 'fpt_fp1');
    await resolver.effective(service, 7, 'fpt_fp1');
    await resolver.effective(service, 7, 'fpt_fp2');
    expect(provider.listCountriesForPackage.mock.calls).toEqual([['secret', 'fp1-week'], ['secret', 'fp2']]);
    expect(await resolver.select(service, 'US', 7, partner, 'fpt_fp1')).toMatchObject({ package_id: 'fp1-week' });
  });
  it.each(['packageId', 'id'])('uses GPNIP template %s consistently for coverage and selection snapshot', async (key) => {
    const service = { ...inherited, country_source: 'api', id_service: ' ', body_api: JSON.stringify({ [key]: 77 }) };
    expect((await resolver.effective(service, 30)).status).toBe('ready');
    expect(provider.listCountriesForPackage).toHaveBeenCalledWith('secret', '77');
    const snapshot = await resolver.select(service, 'US', 30);
    expect(snapshot?.package_id).toBe('77');
    expect(countryProviderParams(snapshot, 'gpnip').id_service).toBe('77');
    expect(resolver.packageId({ ...service, id_service: '42' }, 30, 'gpnip')).toBe('77');
    expect(resolver.packageId({ ...service, id_service: '42', duration_ids: { '30': '99' } }, 30, 'gpnip')).toBe('99');
    expect(resolver.packageId(service, 30, 'proxyvn')).toBe('');
    expect(resolver.packageId({ ...service, body_api: '{bad' }, 30, 'gpnip')).toBe('');
  });
  it.each(['homeproxy', 'proxyvn', 'twoproxy'])('preserves %s derived ID for empty AND populated snapshot packages', (code) => {
    for (const package_id of ['', 'stale-service-id']) {
      expect({ id_service: 'derived', ...countryProviderParams({ source: 'none', package_id }, code) }.id_service).toBe('derived');
    }
    expect(countryProviderParams({ source: 'none', package_id: '' }, 'gpnip')).not.toHaveProperty('id_service');
  });
  it.each(['homeproxy', 'proxyvn', 'twoproxy', 'omoproxy'])('blocks unsupported %s manual selection, but permits none', async (code) => {
    partner.code = code;
    provider.capabilities = {};
    const effective = await resolver.effective(inherited);
    expect(effective).toMatchObject({ status: 'error', countries: [], message: 'Country selection is not supported by this provider adapter' });
    await expect(resolver.select(inherited, 'US')).rejects.toThrow('Country selection is not supported');
    expect(await resolver.select({ ...inherited, country_source: 'none' })).toEqual({ source: 'none', package_id: ['proxyvn', 'twoproxy'].includes(code) ? '' : '42' });
  });
  it('expires cache and does not cache errors or expose provider error details', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const service = { ...inherited, country_source: 'api' };
    await resolver.effective(service);
    now.mockReturnValue(301001);
    provider.listCountriesForPackage.mockRejectedValue(new Error('secret credential'));
    expect(await resolver.effective(service)).toMatchObject({ status: 'error', countries: [] });
    expect(JSON.stringify(await resolver.effective(service))).not.toContain('secret credential');
    expect(provider.listCountriesForPackage).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });
  it.each([[['US']], [[]]])('shares concurrent successful coverage, including empty %j, and refreshes after expiry', async codes => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      let complete!: (value: any) => void;
      provider.listCountriesForPackage.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
      const service = { ...inherited, country_source: 'api' };
      const requests = [resolver.effective(service), resolver.effective(service), resolver.effective(service)];
      await new Promise(resolve => setImmediate(resolve));
      expect(provider.listCountriesForPackage).toHaveBeenCalledTimes(1);
      complete({ iso_codes: codes });
      const results = await Promise.all(requests);
      expect(results.every(r => r.status === (codes.length ? 'ready' : 'unavailable'))).toBe(true);
      await resolver.effective(service);
      expect(provider.listCountriesForPackage).toHaveBeenCalledTimes(1);
      now.mockReturnValue(301001);
      provider.listCountriesForPackage.mockResolvedValue({ iso_codes: ['VN'] });
      await Promise.all([resolver.effective(service), resolver.effective(service), resolver.effective(service)]);
      expect(provider.listCountriesForPackage).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });
  it('shares failures without caching errors or leaving rejected cleanup promises', async () => {
    const service = { ...inherited, country_source: 'api' };
    provider.listCountriesForPackage.mockRejectedValue(new Error('failed'));
    const results = await Promise.all([resolver.effective(service), resolver.effective(service), resolver.effective(service)]);
    expect(results.every(r => r.status === 'error')).toBe(true);
    expect(provider.listCountriesForPackage).toHaveBeenCalledTimes(1);
    expect((resolver as any).inflight.size).toBe(0);
    provider.listCountriesForPackage.mockResolvedValue({ iso_codes: ['VN'] });
    expect((await resolver.effective(service)).status).toBe('ready');
    expect(provider.listCountriesForPackage).toHaveBeenCalledTimes(2);
    await new Promise(resolve => setImmediate(resolve));
  });
  it('unsupported API fails closed, never falls back to manual', async () => {
    provider = {};
    expect(await resolver.effective({ ...inherited, country_source: 'api' })).toMatchObject({ status: 'error', countries: [] });
  });
  it('requires ProxySeller mapping rather than forwarding ISO as countryId', async () => {
    partner.code = 'proxyseller';
    await expect(resolver.select({ ...inherited, country_source: 'manual', country_options: [{ code: 'US' }] }, 'US', 30, partner)).rejects.toThrow('provider_value');
    const snapshot = await resolver.select(inherited, 'US', 30, partner);
    expect(countryProviderParams(snapshot)).toMatchObject({ country_policy_configured: true, country_code: 'US', country_provider_value: 'us-provider', id_service: '42' });
    expect(publicOrderConfig({ country_policy: snapshot })).toEqual({ country_policy: { source: 'manual', code: 'US' } });
  });
  it('normalizes DTOs and rejects invalid ISO and merged invalid updates', async () => {
    const dto = plainToInstance(CreateServiceDto, { name: 's', country_source: 'manual', country_options: [{ code: ' us ' }], country_allowlist: [' vn '] });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.country_options?.[0].code).toBe('US');
    expect(dto.country_allowlist).toEqual(['VN']);
    expect(() => validateCountryConfig({ country_source: 'manual', country_options: [] }, true)).toThrow('require');
    expect(() => validateCountryConfig({ country_options: [{ code: 'ZZ' }] })).toThrow('ISO');
    expect(() => validateCountryConfig({ country_options: [{ code: 'us' }, { code: 'US' }] })).toThrow('Duplicate');
    expect(() => validateCountryConfig({ country_source: 'manual', country_options: [{ code: 'US' }], country_sales_mode: 'allowlist', country_allowlist: ['VN'] }, true)).toThrow('missing');
  });
});
