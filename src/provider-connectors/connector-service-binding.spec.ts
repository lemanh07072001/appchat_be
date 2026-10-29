import { ConnectorServiceBinding } from './connector-service-binding.service';
import { validateConnectorDefinition } from './connector-definition';

describe('Service package binding', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture() {
    const definition = validateConnectorDefinition({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      operations: {
        buy: { method: 'POST', path: '/orders', effect: 'write', timeoutMs: 1000,
          request: { body: { product: { path: '$.input.packageId' } } }, response: { success: { path: '$.ok', equals: true } },
          output: { fields: { provider_order_id: { path: '$.id', type: 'string', required: true } } } },
        fetch: { method: 'GET', path: '/orders/{order}', effect: 'read', timeoutMs: 1000,
          request: { path: { order: { path: '$.input.orderId' } } }, response: { success: { path: '$.ok', equals: true } },
          output: { items: { path: '$.items', fields: {
            host: { path: '$.host', type: 'string', required: true }, port: { path: '$.port', type: 'number', required: true },
            protocol: { path: '$.protocol', type: 'string', required: true }, username: { path: '$.user', type: 'string', required: true },
            password: { path: '$.pass', type: 'string', required: true },
          } } } },
      }, actions: { buy: { operation: 'buy' }, fetch: { operation: 'fetch' } } });
    const query = (value: unknown) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(value) });
    const service = { _id: id, pricing_mode: 'duration', pricing: { '30': { price: 100 } }, connector_binding: null };
    const services = { findById: jest.fn(() => query(service)), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    const account = { enabled: true, connectorCode: 'example', connectorVersion: 1, credential: 'encrypted' };
    const accounts = { findById: jest.fn(() => query(account)) };
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue(definition) };
    const runtime = { read: jest.fn().mockResolvedValue({ fields: {}, items: [{ id: 'package-30', name: '30 days' }] }) };
    const secrets = { decrypt: jest.fn().mockReturnValue('account-secret') };
    const sut = new ConnectorServiceBinding(services as any, accounts as any, connectors as any, runtime as any, secrets as any);
    const binding = { accountId: id, connectorCode: 'example', connectorVersion: 1, packages: { '30': 'package-30' } };
    return { sut, service, services, account, connectors, runtime, secrets, binding, definition };
  }
  it('verifies catalog and saves package selection while disabling purchases and renewals', async () => {
    const f = fixture();
    expect(await f.sut.bind(id, id, { packages: { '30': 'package-30' } })).toEqual({ binding: f.binding, purchaseEnabled: false });
    expect(f.runtime.read).toHaveBeenCalledWith(id, 'catalog', {}, f.account);
    expect(f.services.updateOne).toHaveBeenCalledWith(expect.objectContaining({ pricing: f.service.pricing }),
      { $set: { connector_binding: f.binding, api_enabled: false, allow_renew: false } });
  });
  it.each(['unknown-package', 'missing-duration', 'extra-duration', 'changed-service', 'bandwidth', 'missing-mapping'])(
    'refuses %s without silently substituting products', async reason => {
      const f = fixture(); let packages: Record<string, string> = { '30': 'package-30' };
      if (reason === 'unknown-package') packages['30'] = 'other';
      if (reason === 'missing-duration') packages = {};
      if (reason === 'extra-duration') packages['7'] = 'package-30';
      if (reason === 'changed-service') f.services.updateOne.mockResolvedValue({ modifiedCount: 0 });
      if (reason === 'bandwidth') f.service.pricing_mode = 'bandwidth';
      if (reason === 'missing-mapping') delete f.definition.operations.fetch.output!.items!.fields.password;
      await expect(f.sut.bind(id, id, { packages })).rejects.toThrow();
      if (reason !== 'changed-service') expect(f.services.updateOne).not.toHaveBeenCalled();
    });
  it('prepares only trusted inputs and performs no network operation or persistence', async () => {
    const f = fixture();
    expect(await f.sut.prepare(f.binding, { quantity: 2, durationDays: 30, protocol: 'http',
      username: 'proxy-user', password: 'proxy-password', packageId: 'malicious' } as any)).toEqual({
      accountId: id, connectorCode: 'example', connectorVersion: 1,
      input: { packageId: 'package-30', quantity: 2, durationDays: 30, protocol: 'http', username: 'proxy-user', password: 'proxy-password' },
    });
    expect(f.runtime.read).not.toHaveBeenCalled();
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  it.each(['different-provider', 'missing-provider'])('refuses cross-provider binding: %s', async reason => {
    const f = fixture();
    (f.account as any).legacyPartnerId = id;
    if (reason === 'different-provider') (f.service as any).partner = '507f1f77bcf86cd799439012';
    await expect(f.sut.bind(id, id, { packages: f.binding.packages })).rejects.toThrow('source provider');
    expect(f.runtime.read).not.toHaveBeenCalled();
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  it('accepts matching source provider and includes it in the conditional save', async () => {
    const f = fixture();
    (f.account as any).legacyPartnerId = id;
    (f.service as any).partner = id;
    await expect(f.sut.bind(id, id, { packages: f.binding.packages })).resolves.toMatchObject({ purchaseEnabled: false });
    expect(f.services.updateOne).toHaveBeenCalledWith(expect.objectContaining({ partner: id }), expect.anything());
  });
  it.each(['missing-origin', 'different-origin'])('blocks unsafe successor binding: %s', async reason => {
    const f = fixture();
    (f.account as any).predecessorAccountId = id;
    if (reason === 'different-origin') (f.account as any).sourcePartnerId = id;
    (f.service as any).partner = '507f1f77bcf86cd799439012';
    await expect(f.sut.bind(id, id, { packages: f.binding.packages })).rejects.toThrow();
    expect(f.runtime.read).not.toHaveBeenCalled();
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  function restrictedFixture() {
    const f = fixture();
    f.definition.purchasePolicy = { protocols: ['http'], catalog: [{ field: 'provider', equals: 'VIETTEL' }] };
    f.definition.operations.catalog = { method: 'GET', path: '/products', effect: 'read', timeoutMs: 1000,
      output: { items: { path: '$.items', fields: {
        id: { path: '$.id', type: 'string', required: true },
        provider: { path: '$.provider', type: 'string', required: true },
      } } } };
    f.definition.actions.catalog = { operation: 'catalog' };
    f.runtime.read.mockResolvedValue({ fields: {}, items: [{ id: 'package-30', name: '30 days', provider: 'VIETTEL' }] } as any);
    (f.service as any).protocol = ['http'];
    return f;
  }
  it('pins dual delivery policy without inventing a purchase protocol', async () => {
    const f = restrictedFixture();
    f.definition.purchasePolicy!.protocolMode = 'dual';
    f.definition.purchasePolicy!.protocols = ['http', 'socks5'];
    const fields = f.definition.operations.fetch.output!.items!.fields;
    delete fields.port; delete fields.protocol;
    fields.httpPort = { path: '$.http', type: 'number', required: true };
    fields.socks5Port = { path: '$.socks', type: 'number', required: true };
    const result = await f.sut.prepare(f.binding, { quantity: 1, durationDays: 30, serviceProtocols: ['http', 'socks5'] });
    expect(result.protocolSelection).toEqual({ mode: 'dual', protocols: ['http', 'socks5'] });
    expect(result.input).not.toHaveProperty('protocol');
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  it('maps ISP through trusted service and versioned provider choices before pinning', async () => {
    const f = restrictedFixture();
    f.definition.purchasePolicy!.isp = { mode: 'select', choices: [
      { code: 'a', name: 'Network A', value: 'API_A', packageIds: ['package-30'] },
      { code: 'b', name: 'Network B', value: 'API_B' },
    ] };
    const serviceIsps = [{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }];
    const selection = { quantity: 1, durationDays: 30, protocol: 'http', isp: 'a', serviceIsps };
    const result = await f.sut.prepare(f.binding, selection);
    expect(result.input.isp).toBe('API_A');
    expect(result.ispSelection).toEqual({ code: 'a', name: 'Network A', value: 'API_A' });
    await expect(f.sut.prepare(f.binding, { ...selection, isp: 'API_A' })).rejects.toThrow();
    await expect(f.sut.prepare(f.binding, { ...selection, serviceIsps: [serviceIsps[1]] })).rejects.toThrow();
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  it('pins country API value separately from the public country label', async () => {
    const f = restrictedFixture();
    f.definition.purchasePolicy!.country = { mode: 'select', choices: [
      { code: 'us', name: 'Mỹ', value: 'USA', packageIds: ['package-30'] },
      { code: 'jp', name: 'Nhật', value: 'JPN' },
    ] };
    const options = { quantity: 1, durationDays: 30, protocol: 'http', country: 'us',
      serviceCountries: [{ code: 'us', name: 'Mỹ' }, { code: 'jp', name: 'Nhật' }] };
    const result = await f.sut.prepare(f.binding, options);
    expect(result.input.country).toBe('USA');
    expect(result.countrySelection).toEqual({ code: 'us', name: 'Mỹ', value: 'USA' });
    await expect(f.sut.prepare(f.binding, { ...options, country: 'USA' })).rejects.toThrow();
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  it.each(['wrong-provider', 'missing-provider', 'duplicate-package', 'unsupported-protocol'])(
    'blocks ineligible binding before persistence: %s', async reason => {
      const f = restrictedFixture();
      if (reason === 'wrong-provider') f.runtime.read.mockResolvedValue({ items: [{ id: 'package-30', provider: 'VNPT' }] } as any);
      if (reason === 'missing-provider') f.runtime.read.mockResolvedValue({ items: [{ id: 'package-30' }] } as any);
      if (reason === 'duplicate-package') f.runtime.read.mockResolvedValue({ items: [{ id: 'package-30' }, { id: 'package-30' }] } as any);
      if (reason === 'unsupported-protocol') (f.service as any).protocol = ['http', 'socks5'];
      await expect(f.sut.bind(id, id, { packages: f.binding.packages })).rejects.toThrow();
      expect(f.services.updateOne).not.toHaveBeenCalled();
    });
  it('rechecks live package eligibility at checkout and fails before credential decryption', async () => {
    const f = restrictedFixture();
    f.runtime.read.mockResolvedValue({ items: [{ id: 'package-30', provider: 'VNPT' }] } as any);
    await expect(f.sut.prepare(f.binding, { quantity: 1, durationDays: 30, protocol: 'http' })).rejects.toThrow('purchase policy');
    expect(f.secrets.decrypt).not.toHaveBeenCalled();
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  it('allows eligible binding and checkout with a read-only catalog recheck', async () => {
    const f = restrictedFixture();
    await expect(f.sut.bind(id, id, { packages: f.binding.packages })).resolves.toEqual({ binding: f.binding, purchaseEnabled: false });
    expect(f.services.updateOne).toHaveBeenCalledWith(expect.objectContaining({ protocol: ['http'] }), expect.anything());
    await expect(f.sut.prepare(f.binding, { quantity: 1, durationDays: 30, protocol: 'http' })).resolves.toMatchObject({
      input: { packageId: 'package-30', protocol: 'http', durationDays: 30 },
    });
    expect(f.runtime.read).toHaveBeenCalledTimes(2);
    expect(f.runtime.read).toHaveBeenLastCalledWith(id, 'catalog', {}, f.account);
  });
  it('rejects missing required credentials before catalog reads or decryption', async () => {
    const f = restrictedFixture();
    f.definition.purchasePolicy!.requiredTextInputs = ['username', 'password'];
    await expect(f.sut.prepare(f.binding, { quantity: 1, durationDays: 30, protocol: 'http',
      username: 'sample-user', password: '  ' })).rejects.toThrow('invalid text: password');
    expect(f.runtime.read).not.toHaveBeenCalled();
    expect(f.secrets.decrypt).not.toHaveBeenCalled();
  });
  it('pins generated credentials into the prepared purchase and builds requests without generating again', async () => {
    const f = restrictedFixture();
    f.definition.purchasePolicy!.requiredTextInputs = ['username', 'password'];
    f.definition.purchasePolicy!.credentialGeneration = 'hex-pair-v1';
    f.definition.operations.buy.request!.body = { user: { path: '$.input.username' }, password: { path: '$.input.password' } };
    const result = await f.sut.prepare(f.binding, { quantity: 1, durationDays: 30, protocol: 'http' });
    expect(result.input.username).toMatch(/^u[0-9a-f]{12}$/);
    expect(result.input.password).toMatch(/^p[0-9a-f]{24}$/);
    expect(f.services.updateOne).not.toHaveBeenCalled();
  });
  it.each(['version', 'package', 'protocol', 'quantity', 'missing-input'])('blocks invalid checkout preparation: %s', async reason => {
    const f = fixture(); const options = { quantity: 1, durationDays: 30, protocol: 'http' };
    if (reason === 'version') f.account.connectorVersion = 2;
    if (reason === 'package') options.durationDays = 7;
    if (reason === 'protocol') options.protocol = 'socks4';
    if (reason === 'quantity') options.quantity = 0;
    if (reason === 'missing-input') f.definition.operations.buy.request!.body!.required = { path: '$.input.countryCode' };
    await expect(f.sut.prepare(f.binding, options)).rejects.toThrow();
    expect(f.runtime.read).not.toHaveBeenCalled();
  });
});
