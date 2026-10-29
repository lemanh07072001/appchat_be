import { ProviderConnectorsService } from './provider-connectors.service';

describe('Versioned connector persistence', () => {
  const definition = {
    baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
    operations: { account: { method: 'GET', path: '/account', effect: 'read', timeoutMs: 1000 } },
    actions: { check: { operation: 'account' } },
  };
  function fixture() {
    const query = { lean: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), exec: jest.fn() };
    const model = { create: jest.fn(), findOneAndUpdate: jest.fn().mockReturnValue(query), findOne: jest.fn().mockReturnValue(query) };
    const cache = { published: jest.fn(async (_code, _version, loader) => loader()) };
    return { model, cache, query, service: new ProviderConnectorsService(model as any, cache as any) };
  }
  it('ignores injected publication state when creating a draft', async () => {
    const f = fixture();
    await f.service.create({ code: 'example', name: ' Example ', version: 1, definition, status: 'published' } as any);
    expect(f.model.create).toHaveBeenCalledWith({ code: 'example', name: 'Example', version: 1, definition, status: 'draft', revision: 0 });
  });
  it('does not modify immutable versions or bypass expected revision', async () => {
    const f = fixture();
    f.query.exec.mockResolvedValue(null);
    await expect(f.service.update('example', 1, { revision: 2, definition })).rejects.toThrow('immutable');
    expect(f.model.findOneAndUpdate.mock.calls[0][0]).toEqual({ code: 'example', version: 1, status: 'draft', revision: 2 });
  });
  it('publishes with compare-and-swap after validating the saved definition', async () => {
    const f = fixture();
    f.query.exec.mockResolvedValueOnce({ definition }).mockResolvedValueOnce({ status: 'published', revision: 3 });
    expect(await f.service.publish('example', 1, 2)).toMatchObject({ status: 'published' });
    expect(f.model.findOneAndUpdate.mock.calls[0][0]).toEqual({ code: 'example', version: 1, status: 'draft', revision: 2 });
  });
  it('loads only published definitions through the version-keyed cache', async () => {
    const f = fixture();
    f.query.exec.mockResolvedValue({ definition });
    expect(await f.service.publishedDefinition('example', 1)).toEqual(definition);
    expect(f.cache.published).toHaveBeenCalledWith('example', 1, expect.any(Function));
    expect(f.model.findOne).toHaveBeenCalledWith({ code: 'example', version: 1, status: 'published' });
  });
  it('rejects malformed identities before querying Redis or MongoDB', async () => {
    const f = fixture();
    for (const code of ['../admin', 'bad:key', undefined]) {
      await expect(f.service.publishedDefinition(code as any, 1)).rejects.toThrow('Invalid');
    }
    expect(f.model.findOne).not.toHaveBeenCalled();
    expect(f.cache.published).not.toHaveBeenCalled();
  });
  it('rejects workflow versions that do not match the connector before saving', async () => {
    const f = fixture();
    const workflow = { version: 1, entry: 'inspect', steps: [{ id: 'inspect', operation: 'account',
      effect: 'read', input: {}, save: {}, success: { path: '$.ok', equals: true } }], output: {} };
    await expect(f.service.create({ code: 'example', name: 'Example', version: 2,
      definition: { ...definition, workflows: { inspect: workflow }, actions: { check: { workflow: 'inspect' } } } })).rejects.toThrow('must match');
    expect(f.model.create).not.toHaveBeenCalled();
  });
  it('copies an immutable source into a new persisted draft without changing the source', async () => {
    const f = fixture();
    const source = { code: 'example', name: 'Example', version: 1, revision: 3, status: 'published', definition };
    f.query.exec.mockResolvedValue(source);
    await f.service.fork('example', 1, { revision: 3, targetVersion: 2 });
    expect(f.model.create).toHaveBeenCalledWith({ code: 'example', name: 'Example', version: 2, revision: 0, status: 'draft', definition });
    expect(f.model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(source).toEqual({ code: 'example', name: 'Example', version: 1, revision: 3, status: 'published', definition });
  });
  it('updates copied workflow version numbers without mutating the published workflows', async () => {
    const f = fixture();
    const workflow = { version: 1, entry: 'inspect', steps: [{ id: 'inspect', operation: 'account',
      effect: 'read', input: {}, save: {}, success: { path: '$.ok', equals: true } }], output: {} };
    const sourceDefinition = { ...definition, workflows: { inspect: workflow }, actions: { check: { workflow: 'inspect' } } };
    f.query.exec.mockResolvedValue({ name: 'Example', revision: 3, status: 'published', definition: sourceDefinition });
    await f.service.fork('example', 1, { revision: 3, targetVersion: 5 });
    expect(f.model.create.mock.calls[0][0].definition.workflows.inspect.version).toBe(5);
    expect(workflow.version).toBe(1);
  });
  it.each([{ status: 'draft', revision: 3 }, { status: 'published', revision: 4 }])('refuses stale or unpublished source %#', source => {
    const f = fixture(); f.query.exec.mockResolvedValue({ ...source, definition });
    return expect(f.service.fork('example', 1, { revision: 3, targetVersion: 2 })).rejects.toThrow('source changed');
  });
  it('does not overwrite a target version created by another administrator', async () => {
    const f = fixture(); f.query.exec.mockResolvedValue({ status: 'published', revision: 3, name: 'Example', definition });
    f.model.create.mockRejectedValue({ code: 11000 });
    await expect(f.service.fork('example', 1, { revision: 3, targetVersion: 2 })).rejects.toThrow('already exists');
  });
  it.each([0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid target version %s', targetVersion => {
    const f = fixture();
    return expect(f.service.fork('example', 1, { revision: 3, targetVersion })).rejects.toThrow('Invalid');
  });
});
