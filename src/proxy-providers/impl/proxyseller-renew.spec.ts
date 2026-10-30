import { ProxysellerProvider } from './proxyseller.provider';

describe('ProxySeller renewal order contract', () => {
  let provider: ProxysellerProvider;
  let request: jest.SpyInstance;
  const params = { token_api: 'test', provider_order_id: 'original-Ab12',
    provider_proxy_ids: ['00Ab-C', '90071992547409930'], duration_days: 30, id_service: 'ipv4' };
  beforeEach(() => {
    provider = new ProxysellerProvider();
    request = jest.spyOn(provider as any, 'request').mockImplementation(async (method) => method === 'GET'
      ? { status: 'success', data: { items: { period: [{ id: 'period-Ab30', name: '30 days', days: 30 }] } } }
      : { status: 'success', data: { orderId: 'renew-X' } });
  });
  it.each(['ipv4', 'mobile', 'isp'])('preserves string ids for %s and returns success with raw renewal order', async type => {
    const result = await provider.renew({ ...params, id_service: type });
    expect(request).toHaveBeenCalledWith('POST', `/test/prolong/make/${type}`, {
      ids: params.provider_proxy_ids, periodId: 'period-Ab30', paymentId: 'balance', coupon: '',
    }, undefined, 'v2');
    expect(request).toHaveBeenNthCalledWith(1, 'GET', `/test/reference/list/${type}`, undefined, undefined, 'v2');
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true, raw: { status: 'success', data: { orderId: 'renew-X' } } });
    expect(result.new_end_date).toBeUndefined();
  });
  it.each(['ipv6', 'mix', 'mix_isp'])('uses original order reference for %s', async type => {
    await provider.renew({ ...params, provider_order_id: `${type}:original-Ab12` });
    expect(request).toHaveBeenCalledWith('POST', `/test/prolong/make/${type}`, expect.objectContaining({ orderIds: ['original-Ab12'] }), undefined, 'v2');
    expect(request.mock.calls[1][2]).not.toHaveProperty('ids');
  });
  it('resolves metadata type for modern references', async () => {
    await provider.renew({ ...params, provider_metadata: { proxyseller_type: 'mix_isp' } });
    expect(request.mock.calls[1][1]).toBe('/test/prolong/make/mix_isp');
  });
  it.each([0, -1, 1.5, NaN, Infinity, '30', null, undefined])('rejects invalid duration %s without spending', async days => {
    await expect(provider.renew({ ...params, duration_days: days as number })).rejects.toThrow('positive integer');
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps validation synchronous and accepts arbitrary positive integer days', () => {
    expect(provider.validateRenew({ ...params, duration_days: 31 })).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    [{ id: 817, name: 'Un mois', days: '30' }],
    [{ id: '817', period: 30 }],
    [{ id: '817', period: '30' }],
    [{ id: 'opaque-id', code: '1m' }],
    [{ id: 'opaque-id', value: '30d' }],
    [{ id: '1m', name: '1 month' }],
    [{ id: 'opaque-id', period: '1m' }],
  ])('sends the catalog id as a string for %j', async entry => {
    request.mockResolvedValueOnce({ status: 'success', data: { items: { period: [entry] } } });
    await provider.renew(params);
    expect(request.mock.calls[1][2].periodId).toBe(String(entry.id));
  });
  it('supports a non-hardcoded duration from explicit catalog days', async () => {
    request.mockResolvedValueOnce({ status: 'success', data: { items: { period: [{ id: 'custom-31', days: 31 }] } } });
    await provider.renew({ ...params, duration_days: 31 });
    expect(request.mock.calls[1][2].periodId).toBe('custom-31');
  });
  it.each([
    [],
    [{ id: 'other', days: 7 }],
    [{ id: 30, name: '30 days' }],
    [{ id: '30', name: '1 month' }],
    [{ id: 'opaque', name: '30 days' }],
    [{ id: 'opaque', days: 7, code: '1m' }],
  ].map(periods => ({ periods })))('rejects missing matches without make for $periods', async ({ periods }) => {
    request.mockResolvedValueOnce({ status: 'success', data: { items: { period: periods } } });
    await expect(provider.renew(params)).rejects.toThrow('no matching period');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ id: 'a', days: 30 }, { id: 'b', period: '30' }],
    [{ id: 'a', days: 30 }, { id: 'a', days: 30 }],
    [{ id: 'a', days: 30, period: 7 }],
    [{ id: 'a', code: '1m', value: '7d' }],
    [{ days: 30 }],
  ].map(periods => ({ periods })))('rejects ambiguous matches without make for $periods', async ({ periods }) => {
    request.mockResolvedValueOnce({ status: 'success', data: { items: { period: periods } } });
    await expect(provider.renew(params)).rejects.toThrow('ambiguous period');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 'error', errors: [{ message: 'reference unavailable' }] },
    { status: 'success', data: null },
    { status: 'success', data: { items: { period: {} } } },
  ])('rejects a failed/malformed reference without make: %j', async response => {
    request.mockResolvedValueOnce(response);
    await expect(provider.renew(params)).rejects.toThrow('reference');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects resident before sending', async () => {
    await expect(provider.renew({ ...params, id_service: 'resident' })).rejects.toThrow('resident');
    expect(request).not.toHaveBeenCalled();
  });
  it('propagates timeout failures to the existing refund flow', async () => {
    request.mockRejectedValue(new Error('timeout'));
    await expect(provider.renew(params)).rejects.toThrow('timeout');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['rejected', 'timeout'])('does not retry paid make after %s', async failure => {
    request.mockResolvedValueOnce({ status: 'success', data: { items: { period: [{ id: 'actual-id', days: 30 }] } } });
    if (failure === 'timeout') request.mockRejectedValueOnce(new Error('paid timeout'));
    else request.mockResolvedValueOnce({ status: 'error', errors: [{ message: 'Set existed [periodId] from reference' }] });
    await expect(provider.renew(params)).rejects.toThrow(failure === 'timeout' ? 'paid timeout' : 'periodId');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps purchase polling on its original request defaults', async () => {
    request.mockResolvedValue({ status: 'success', data: { items: [] } });
    await provider.fetchOrderProxies('test', 'original');
    expect(request).toHaveBeenLastCalledWith('GET', '/test/proxy/list/ipv4', undefined, { orderId: 'original' });
  });
});
