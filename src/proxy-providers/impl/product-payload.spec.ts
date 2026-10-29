import { OmoproxyProvider } from './omoproxy.provider';
import { ProxysieutocProvider } from './proxysieutoc.provider';
import { Proxyv6Provider } from './proxyv6.provider';
import { countryProviderParams } from '../../countries/country-policy';
import { resolveProduct, productProviderParams } from '../../services/product-mapping';
import { GpnipProvider } from './gpnip.provider';

describe('authoritative mapped product payloads', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  it.each([true, false])('OmoProxy mapping=%s preserves pricing but controls product precedence', async configured => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { order_id: 'order', proxies: [] } }) });
    await new OmoproxyProvider().buy({ token_api: 'key', quantity: 1, duration_days: 30,
      id_service: 'mapped', product_id_configured: configured, body_api: '{"id":"template","gb":5}' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.omoproxy.com/v1/orders');
    expect(JSON.parse(init.body)).toEqual({ id: configured ? 'mapped' : 'template', gb: 5 });
  });
  it.each([true, false])('ProxySieuToc mapping=%s controls outgoing id_product', async configured => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'SUCCESS', order_code: 'order', proxies: [] }) });
    await new ProxysieutocProvider().buy({ token_api: 'key', quantity: 2, duration_days: 30,
      id_service: '123', product_id_configured: configured, body_api: '{"id_product":456}' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.get('id_product')).toBe(configured ? '123' : '456');
    expect(new URL(url).searchParams.get('quantity')).toBe('2');
    expect(init.method).toBe('POST');
  });
  it('ProxySieuToc mapping works without a legacy template', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ status: 'SUCCESS', order_code: 'order' }) });
    await new ProxysieutocProvider().buy({ token_api: 'key', quantity: 1, duration_days: 7, id_service: '123', product_id_configured: true });
    expect(new URL((global.fetch as jest.Mock).mock.calls[0][0]).searchParams.get('id_product')).toBe('123');
  });
  it('ProxyV6 rejects unsupported explicit mapping without network access', async () => {
    global.fetch = jest.fn();
    const provider = new Proxyv6Provider();
    const params = { token_api: 'key', quantity: 1, duration_days: 7, id_service: '123', product_id_configured: true };
    expect(() => provider.validateBuy(params)).toThrow('does not support explicit product mapping');
    await expect(provider.buy(params)).rejects.toThrow('does not support explicit product mapping');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('ProxyV6 validates and sends country-only legacy configuration', async () => {
    const provider = new Proxyv6Provider();
    const params = { token_api: 'key', quantity: 1, duration_days: 30, isp: 'fpt', id_service: 'legacy',
      ...countryProviderParams({ source: 'manual', package_id: 'legacy', code: 'US', provider_value: 'US' }, 'proxyv6') };
    expect(params).not.toHaveProperty('product_id_configured');
    expect(() => provider.validateBuy(params)).not.toThrow();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ order_id: 'order', proxies: [] }) });
    await provider.buy(params);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({ country: 'US', isp: 'fpt' });
  });
  it('GPNIP country-only package still overrides its legacy template', () => {
    const params = { token_api: 'key', quantity: 1, duration_days: 30, body_api: '{"packageId":42,"ips":1,"period":"7"}',
      ...countryProviderParams({ source: 'manual', package_id: '77', code: 'US', provider_value: 'US' }, 'gpnip') };
    expect(params.product_id_configured).toBe(true);
    expect(new GpnipProvider().buildBuyBody(params)).toMatchObject({ packageId: 77, serviceOptions: { country: 'US', period: '30' } });
  });
  it.each([
    { id_service: 'legacy', isp: [{ name: 'FPT FP1', code: 'fp1', provider_product_id: 'mapped' }] },
    { id_service: 'legacy', duration_ids: { '30': 'mapped-month' } },
  ])('ProxyV6 actual validation rejects genuine mapping even with country policy', service => {
    const params = { token_api: 'key', quantity: 1, duration_days: 30,
      ...countryProviderParams({ source: 'manual', package_id: 'legacy', code: 'US' }, 'proxyv6'),
      ...productProviderParams(resolveProduct(service, service.isp ? 'fp1' : undefined, 30, 'proxyv6')) };
    expect(() => new Proxyv6Provider().validateBuy(params)).toThrow('does not support explicit product mapping');
  });
});
