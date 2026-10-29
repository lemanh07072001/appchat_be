import { legacyConnectorTemplates } from './legacy-connector-templates';
import { validateConnectorDefinition } from './connector-definition';
import { ProviderConnectorsService } from './provider-connectors.service';

describe('Legacy connector draft inventory', () => {
  it('provides eight unique valid drafts without activating any action', () => {
    const templates = legacyConnectorTemplates();
    expect(templates).toHaveLength(8);
    expect(new Set(templates.map(row => row.code)).size).toBe(8);
    for (const row of templates) {
      expect(validateConnectorDefinition(row.definition)).toEqual(row.definition);
      expect(row.definition.actions).toEqual({});
      expect(row.warnings.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('does not label GET purchase or renewal APIs as read-only', () => {
    for (const code of ['twoproxy', 'proxyvn']) {
      const definition = legacyConnectorTemplates().find(row => row.code === code)!.definition;
      expect(definition.operations.buy.effect).toBe('write');
      expect(definition.operations.renew.effect).toBe('write');
    }
  });
  it('omits undocumented HomeProxy rotate/cancel APIs and flags the ProxyV6 placeholder', () => {
    const rows = legacyConnectorTemplates();
    expect(rows.find(row => row.code === 'homeproxy')!.definition.operations.rotate).toBeUndefined();
    expect(rows.find(row => row.code === 'proxyv6')!.warnings.join(' ')).toContain('placeholder');
  });
  it('creates drafts and leaves all duplicate versions unchanged', async () => {
    const create = jest.fn().mockResolvedValue({}).mockRejectedValueOnce({ code: 11000 });
    const service = new ProviderConnectorsService({ create } as any, {} as any);
    const results = await service.importLegacyDrafts();
    expect(results[0].status).toBe('exists-unchanged');
    expect(results.slice(1).every(row => row.status === 'created')).toBe(true);
    expect(create).toHaveBeenCalledTimes(8);
    for (const [body] of create.mock.calls) {
      expect(body.status).toBe('draft');
      expect(body.definition.actions).toEqual({});
      expect(body).not.toHaveProperty('credential');
    }
  });
});
