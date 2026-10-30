import { ProxyvnProvider } from './proxyvn.provider';

describe('ProxyVN purchase contract (mocked; no upstream purchases)', () => {
  it('rejects unsupported countries before sending a purchase', async () => {
    const provider = new ProxyvnProvider();
    const request = jest.spyOn(provider as any, 'request');
    await expect(provider.buy({ token_api: 'mock-key', id_service: 'Viettel', quantity: 1,
      duration_days: 1, country_code: 'US' })).rejects.toThrow('VN');
    expect(request).not.toHaveBeenCalled();
  });
  const response = (id: number) => ({ status: 100, loaiproxy: 'Viettel', idproxy: id,
    ip: '192.0.2.10', port: 35270, user: 'mdtrong', password: 'test-password', type: 'HTTPS', time: 1726675021 });

  it('uses the exact configured product and maps proxy rows separately from the summary', async () => {
    const provider = new ProxyvnProvider();
    const request = jest.spyOn(provider as any, 'request').mockResolvedValue([
      response(2772), response(2773), { status: 200, comen: 'You have successfully purchased 2' },
    ]);
    const result = await provider.buy({ token_api: 'mock-key', id_service: '4Gvinaphone', quantity: 2,
      duration_days: 1, protocol: 'http' });
    const url = new URL(request.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('https://proxy.vn/apiv2/muaproxy.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: 'mock-key', loaiproxy: '4Gvinaphone',
      soluong: '2', ngay: '1', type: 'HTTP', user: 'random', password: 'random' });
    expect(result.proxies).toHaveLength(2);
    expect(result.proxies[0]).toMatchObject({ host: '192.0.2.10', port: 35270, username: 'mdtrong',
      password: 'test-password', protocol: 'http', provider_proxy_id: 2772 });
  });

  it('does not call upstream without an explicit product code', async () => {
    const provider = new ProxyvnProvider();
    const request = jest.spyOn(provider as any, 'request');
    await expect(provider.buy({ token_api: 'mock-key', quantity: 1, duration_days: 1 })).rejects.toThrow('loaiproxy');
    expect(request).not.toHaveBeenCalled();
  });
});
