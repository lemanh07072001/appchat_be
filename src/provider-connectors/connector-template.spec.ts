import { validateConnectorTemplate } from './connector-template';
import { ProviderConnectorsService } from './provider-connectors.service';

describe('Portable provider templates', () => {
  const template = () => ({ format: 'fastproxy-provider', formatVersion: 1, name: ' Example ', definition: {
    baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
    operations: { check: { method: 'GET', path: '/account', effect: 'read', timeoutMs: 1000,
      response: { success: { path: '$.ok', equals: true } } } }, actions: { check: { operation: 'check' } },
  } });
  it('accepts a portable configuration without needing a provider-specific adapter', () => {
    expect(validateConnectorTemplate(template()).name).toBe('Example');
  });
  it('rejects account keys and imported publication/identity metadata', () => {
    for (const field of ['apiKey', 'credential', 'status', 'code']) {
      expect(() => validateConnectorTemplate({ ...template(), [field]: 'injected' })).toThrow();
    }
  });
  it('requires an explicit read-only connection assertion', () => {
    const value = template();
    value.definition.operations.check.effect = 'write';
    expect(() => validateConnectorTemplate(value)).toThrow();
    expect(() => validateConnectorTemplate({ ...template(), definition: { ...template().definition, actions: {} } })).toThrow();
  });
  it('creates a draft with a fresh generated identity each time', async () => {
    const model = { create: jest.fn(async value => value) };
    const service = new ProviderConnectorsService(model as any, {} as any);
    const first = await service.importTemplate(template());
    const second = await service.importTemplate(template());
    expect(first).toMatchObject({ status: 'draft', version: 1, name: 'Example' });
    expect(first.code).toMatch(/^provider_[a-f0-9]{32}$/);
    expect(first.code).not.toBe(second.code);
  });
});
