import { ProxysellerProvider } from './proxyseller.provider';

describe('ProxySeller configured country precedence', () => {
  it('uses mapped countryId instead of template countryId', async () => {
    const provider: any = new ProxysellerProvider();
    provider.request = jest.fn().mockResolvedValue({ status: 'success', data: { orderId: 1 } });
    provider.resolveType = jest.fn().mockReturnValue('ipv4');
    await provider.buy({ token_api: 'test-key', quantity: 1, duration_days: 30, country_policy_configured: true,
      country_code: 'US', country_provider_value: '1293', body_api: '{"countryId":"stale"}' });
    expect(provider.request).toHaveBeenCalledWith('POST', expect.any(String), expect.objectContaining({ countryId: '1293' }));
  });
  it('rejects missing mapped country before calling provider', async () => {
    const provider: any = new ProxysellerProvider();
    provider.request = jest.fn();
    provider.resolveType = jest.fn().mockReturnValue('ipv4');
    await expect(provider.buy({ token_api: 'test-key', quantity: 1, duration_days: 30, country_policy_configured: true, body_api: '{"countryId":"stale"}' })).rejects.toThrow('mapping');
    expect(provider.request).not.toHaveBeenCalled();
  });
});
