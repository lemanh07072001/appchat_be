import { ProviderConnectorsService } from './provider-connectors.service';

describe('Offline provider response preview', () => {
  const service = new ProviderConnectorsService({} as any, {} as any);
  const definition = {
    baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
    operations: { buy: { method: 'POST', path: '/orders', effect: 'write', timeoutMs: 1000,
      response: { success: { path: '$.ok', equals: true } },
      output: { fields: { provider_order_id: { path: '$.id', type: 'string', required: true } } },
    } }, actions: { buy: { operation: 'buy' } },
  };
  it('validates a paid-action sample without dispatching or persisting anything', () => {
    expect(service.previewOutput({ definition, action: 'buy', sample: { ok: true, id: 'private-order', token: 'private-token' } }))
      .toEqual({ ok: true, fieldCount: 1, itemCount: 0 });
  });
  it('does not return sample fields, order IDs or arbitrary upstream data', () => {
    const result = service.previewOutput({ definition, action: 'buy', sample: { ok: true, id: 'private-order' } });
    expect(JSON.stringify(result)).not.toContain('private-order');
  });
  it('requires exact upstream success, not truthy conversion', () => {
    expect(service.previewOutput({ definition, action: 'buy', sample: { ok: 'true', id: 'x' } }))
      .toEqual({ ok: false, reason: 'success-condition', fieldCount: 0, itemCount: 0 });
  });
  it('enforces business contracts even when the HTTP response would be successful', () => {
    expect(() => service.previewOutput({ definition, action: 'buy', sample: { ok: true, id: '' } })).toThrow('contract');
  });
  it('rejects unsupported actions, missing mappings and oversized payloads', () => {
    expect(() => service.previewOutput({ definition, action: 'check', sample: {} })).toThrow();
    expect(() => service.previewOutput({ definition, action: 'fetch', sample: {} })).toThrow('mappings');
    expect(() => service.previewOutput({ definition, action: 'buy', sample: 'x'.repeat(100001) })).toThrow('limit');
  });
});
