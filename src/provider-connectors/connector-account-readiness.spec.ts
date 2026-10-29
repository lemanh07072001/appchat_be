import { ConnectorAccountReadiness } from './connector-account-readiness.service';

describe('Local account activation diagnostics', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture(flag: unknown = 'false') {
    const query = (value: unknown) => {
      const q: any = { exec: jest.fn().mockResolvedValue(value) };
      for (const key of ['select', 'lean', 'limit']) q[key] = jest.fn().mockReturnValue(q);
      return q;
    };
    const account = { enabled: true, connectorCode: 'example', connectorVersion: 1 };
    const rows: any[] = [];
    const definition: any = { operations: {}, actions: {} };
    const field = (type: string) => ({ path: '$.value', type, required: true });
    for (const action of ['check', 'catalog', 'buy', 'fetch']) {
      definition.actions[action] = { operation: action };
      const fields = action === 'buy' ? { provider_order_id: field('string') }
        : action === 'catalog' ? { id: field('string'), name: field('string') }
        : { host: field('string'), port: field('number'), protocol: field('string'), username: field('string'), password: field('string') };
      definition.operations[action] = { method: action === 'buy' ? 'POST' : 'GET',
        effect: action === 'buy' ? 'write' : 'read', response: { success: { path: '$.ok', equals: true } },
        output: action === 'buy' ? { fields } : { items: { path: '$.items', fields } } };
    }
    const accounts = { findById: jest.fn().mockReturnValue(query(account)) };
    const services = { find: jest.fn().mockReturnValue(query(rows)) };
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue(definition) };
    const config = { get: jest.fn().mockReturnValue(flag) };
    return { account, rows, definition, accounts, connectors,
      service: new ConnectorAccountReadiness(accounts as any, services as any, connectors as any, config as any) };
  }
  it('keeps checkout gated and reports absent bindings without declaring live readiness', async () => {
    const f = fixture(); const result = await f.service.inspect(id);
    expect(result.blockers).toEqual(['service-binding-required', 'checkout-disabled']);
    expect(result.readyForLivePurchase).toBe(false);
    expect(result.connectionVerified).toBe(false);
    expect(result.configurationReady).toBe(false);
  });
  it.each([true, 1, 'TRUE', undefined])('does not treat %s as explicit checkout enablement', async flag => {
    expect((await fixture(flag).service.inspect(id)).checkoutEnabled).toBe(false);
  });
  it('distinguishes complete configuration from verified live activation', async () => {
    const f = fixture('true');
    f.rows.push({ pricing_mode: 'duration', pricing: { '30': {} }, status: true, api_enabled: false,
      connector_binding: { connectorCode: 'example', connectorVersion: 1, packages: { '30': 'pkg' } } });
    const result = await f.service.inspect(id);
    expect(result.configurationReady).toBe(true);
    expect(result.readyForLivePurchase).toBe(false);
    expect(result.services).toEqual({ bound: 1, valid: 1, enabledForSale: 0 });
  });
  it('requires authenticated delivery mappings and rejects stale service versions', async () => {
    const f = fixture(); delete f.definition.operations.fetch.output.items.fields.password;
    f.rows.push({ connector_binding: { connectorCode: 'example', connectorVersion: 2 } });
    const result = await f.service.inspect(id);
    expect(result.blockers).toContain('fetch-mapping-required');
    expect(result.blockers).toContain('service-binding-review-required');
  });
  it('handles unavailable templates and disabled accounts without exposing account contents', async () => {
    const f = fixture(); f.account.enabled = false; f.connectors.publishedDefinition.mockResolvedValue(null);
    const result = await f.service.inspect(id);
    expect(result.blockers).toEqual(expect.arrayContaining(['account-disabled', 'published-template-required']));
    expect(JSON.stringify(result)).not.toContain('connectorCode');
  });
  it('rejects invalid or nonexistent accounts', async () => {
    const f = fixture();
    await expect(f.service.inspect('bad')).rejects.toThrow('Invalid account ID');
    expect(f.accounts.findById).not.toHaveBeenCalled();
    f.accounts.findById.mockReturnValue({ select: () => ({ lean: () => ({ exec: async () => null }) }) } as any);
    await expect(f.service.inspect(id)).rejects.toThrow('Connector account not found');
  });
  it.each(['extra-duration', 'whitespace-package', 'oversized-package', 'array-packages', 'missing-template'])(
    'does not count invalid package bindings as configured: %s', async reason => {
      const f = fixture();
      const packages: any = { '30': 'pkg' };
      if (reason === 'extra-duration') packages['7'] = 'other';
      if (reason === 'whitespace-package') packages['30'] = ' pkg ';
      if (reason === 'oversized-package') packages['30'] = 'p'.repeat(257);
      const row = { pricing_mode: 'duration', pricing: { '30': {} }, status: true, api_enabled: true,
        connector_binding: { connectorCode: 'example', connectorVersion: 1, packages: reason === 'array-packages' ? ['pkg'] : packages } };
      f.rows.push(row);
      if (reason === 'missing-template') f.connectors.publishedDefinition.mockResolvedValue(null);
      const result = await f.service.inspect(id);
      expect(result.services.valid).toBe(0);
      expect(result.services.enabledForSale).toBe(0);
      expect(result.blockers).toContain('service-binding-review-required');
      expect(result.configurationReady).toBe(false);
    });
  it.each([[], ['socks5'], ['http', 'https']].map(protocol => ({ protocol })))(
    'flags service protocols outside the configured policy: $protocol', async ({ protocol }) => {
    const f = fixture();
    f.definition.purchasePolicy = { protocols: ['http'], catalog: [{ field: 'provider', equals: 'sample' }] };
    f.rows.push({ protocol, pricing_mode: 'duration', pricing: { '30': {} }, status: true, api_enabled: true,
      connector_binding: { connectorCode: 'example', connectorVersion: 1, packages: { '30': 'pkg' } } });
    const result = await f.service.inspect(id);
    expect(result.blockers).toContain('service-protocol-review-required');
    expect(result.services.valid).toBe(0);
    expect(result.services.enabledForSale).toBe(0);
  });
  it('accepts matching local protocols but explicitly leaves catalog and duration limits unverified', async () => {
    const f = fixture();
    f.definition.purchasePolicy = { protocols: ['http'], catalog: [{ field: 'provider', equals: 'sample' }] };
    f.rows.push({ protocol: ['http'], pricing_mode: 'duration', pricing: { '30': {} },
      connector_binding: { connectorCode: 'example', connectorVersion: 1, packages: { '30': 'pkg' } } });
    const result = await f.service.inspect(id);
    expect(result.configurationReady).toBe(true);
    expect(result.services.valid).toBe(1);
    expect(result.catalogVerified).toBe(false);
    expect(result.durationLimitsVerified).toBe(false);
    expect(result.readyForLivePurchase).toBe(false);
  });
  it.each(['different', 'missing', 'matching'])('checks source provider identity in existing bindings: %s', async reason => {
    const f = fixture();
    (f.account as any).legacyPartnerId = id;
    f.rows.push({ partner: reason === 'matching' ? id : reason === 'different' ? '507f1f77bcf86cd799439012' : null,
      pricing_mode: 'duration', pricing: { '30': {} }, status: true, api_enabled: true,
      connector_binding: { connectorCode: 'example', connectorVersion: 1, packages: { '30': 'pkg' } } });
    const result = await f.service.inspect(id);
    expect(result.services.valid).toBe(reason === 'matching' ? 1 : 0);
    expect(result.services.enabledForSale).toBe(reason === 'matching' ? 1 : 0);
    if (reason === 'matching') expect(result.blockers).not.toContain('service-provider-review-required');
    else expect(result.blockers).toContain('service-provider-review-required');
  });
});
