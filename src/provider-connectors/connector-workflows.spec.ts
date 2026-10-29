import { ConnectorWorkflowsService } from './connector-workflows.service';
import { ConnectorHttp } from './connector-http.service';
import { ConnectorWorkflowsController } from './connector-workflows.controller';
import { ConfigService } from '@nestjs/config';

describe('Read-only workflow execution boundary', () => {
  const accountId = '507f1f77bcf86cd799439011';
  const definition = {
    workflows: { inspect: { version: 1, entry: 'account', steps: [{ effect: 'read' }] } },
    actions: { check: { workflow: 'inspect' } },
  };
  function fixture() {
    const query = { lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue({ enabled: true, connectorCode: 'example', connectorVersion: 1 }) };
    const accounts = { findById: jest.fn().mockReturnValue(query) };
    const runs = { create: jest.fn().mockResolvedValue({ _id: accountId, status: 'ready' }) };
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue(structuredClone(definition)) };
    const service = new ConnectorWorkflowsService(accounts as any, runs as any, connectors as any, {} as any, {} as any, {} as any);
    return { service, runs, accounts, connectors };
  }
  it('creates a bounded durable run without accepting arbitrary persisted inputs', async () => {
    const f = fixture();
    await expect(f.service.startReadOnly(accountId, 'check', 'reference_123')).resolves.toMatchObject({ status: 'ready' });
    const body = f.runs.create.mock.calls[0][0];
    expect(body).toMatchObject({ workflow: 'inspect', variables: {}, status: 'ready', accountId });
    expect(body.deadlineAt).toBeGreaterThan(Date.now());
    expect(body).not.toHaveProperty('credential');
  });
  it('refuses paid action requests before loading accounts', async () => {
    const f = fixture();
    await expect(f.service.startReadOnly(accountId, 'buy', 'reference_123')).rejects.toThrow();
    expect(f.accounts.findById).not.toHaveBeenCalled();
  });
  it('refuses paid steps hidden in a read-only action', async () => {
    const f = fixture();
    const unsafe = structuredClone(definition); unsafe.workflows.inspect.steps[0].effect = 'write';
    f.connectors.publishedDefinition.mockResolvedValue(unsafe);
    await expect(f.service.startReadOnly(accountId, 'check', 'reference_123')).rejects.toThrow('Read-only');
    expect(f.runs.create).not.toHaveBeenCalled();
  });
  it('rejects write HTTP operations by default without touching the network', async () => {
    await expect(new ConnectorHttp().execute({ operations: { buy: { effect: 'write' } } } as any, 'buy', {}, 'key')).rejects.toThrow('disabled');
  });
  it('does not expose workflow variables or credentials in inspection queries', async () => {
    const query = { select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ _id: accountId, status: 'completed' }) };
    const service = new ConnectorWorkflowsService({} as any, { findById: () => query } as any,
      {} as any, {} as any, {} as any, {} as any);
    await service.inspect(accountId);
    const projection = query.select.mock.calls[0][0].split(' ');
    expect(projection).not.toContain('variables');
    expect(projection).not.toContain('output');
    expect(projection).not.toContain('credential');
  });
  it('does not start workflows unless explicitly enabled', () => {
    const startReadOnly = jest.fn();
    const controller = new ConnectorWorkflowsController({ startReadOnly } as any, new ConfigService());
    expect(() => controller.start({ accountId, action: 'check', requestReference: 'reference_123' })).toThrow('not enabled');
    expect(startReadOnly).not.toHaveBeenCalled();
  });
});
