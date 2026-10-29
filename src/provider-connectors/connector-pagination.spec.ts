import { ConnectorHttp } from './connector-http.service';
import { validateConnectorDefinition } from './connector-definition';

describe('Bounded declarative provider pagination', () => {
  function definition() {
    return validateConnectorDefinition({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      actions: { catalog: { operation: 'catalog' } }, operations: { catalog: {
        method: 'GET', path: '/products', effect: 'read', timeoutMs: 30000,
        response: { success: { path: '$.ok', equals: true } },
        output: { items: { path: '$.data', fields: { id: { path: '$.id', type: 'string', required: true } } } },
        pagination: { pageParameter: 'page', pageSizeParameter: 'limit', pageSize: 100, maxPages: 3, hasNextPath: '$.hasNextPage' },
      } } });
  }
  function fixture(responses: unknown[]) {
    const http = new ConnectorHttp();
    const execute = jest.spyOn(http, 'execute');
    for (const response of responses) execute.mockResolvedValueOnce(response);
    return { http, execute };
  }
  it('reads all pages without modifying the published definition', async () => {
    const d = definition(), before = JSON.stringify(d);
    const f = fixture([{ ok: true, data: [{ id: 'a' }], hasNextPage: true }, { ok: true, data: [{ id: 'b' }], hasNextPage: false }]);
    expect(await f.http.readMapped(d, 'catalog', {}, 'secret-token')).toEqual({ fields: {}, items: [{ id: 'a' }, { id: 'b' }] });
    expect(f.execute.mock.calls.map(call => call[0].operations.catalog.request?.query?.page)).toEqual([{ literal: 1 }, { literal: 2 }]);
    expect(JSON.stringify(d)).toBe(before);
  });
  it('fails closed rather than returning truncated results when the page bound is exhausted', async () => {
    const f = fixture(Array.from({ length: 3 }, () => ({ ok: true, data: [{ id: 'a' }], hasNextPage: true })));
    await expect(f.http.readMapped(definition(), 'catalog', {}, 'token')).rejects.toThrow('pagination incomplete');
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it.each([
    { ok: true, data: [], hasNextPage: true },
    { ok: true, data: [], hasNextPage: 'false' },
    { ok: false, data: [], hasNextPage: false },
    { ok: true, data: [{ id: 'secret-token' }], hasNextPage: false },
  ])('refuses invalid pages or credential exposure %#', async response => {
    const f = fixture([response]);
    await expect(f.http.readMapped(definition(), 'catalog', {}, 'secret-token')).rejects.toThrow();
  });
  it.each(['write', 'post', 'conflict', 'auth', 'limit', 'marker'])('rejects unsafe pagination configuration %s', reason => {
    const d = definition(), op = d.operations.catalog;
    if (reason === 'write') op.effect = 'write';
    if (reason === 'post') op.method = 'POST';
    if (reason === 'conflict') op.request = { query: { page: { literal: 1 } } };
    if (reason === 'auth') d.auth = { type: 'query', name: 'page' };
    if (reason === 'limit') op.pagination!.maxPages = 51;
    if (reason === 'marker') op.pagination!.hasNextPath = '$.__proto__.x';
    expect(() => validateConnectorDefinition(d)).toThrow();
  });
  it.each(['constructor', 'prototype', '__proto__'])('rejects reserved pagination parameter %s', key => {
    const d = definition(); d.operations.catalog.pagination!.pageParameter = key;
    expect(() => validateConnectorDefinition(d)).toThrow();
  });
  it('discards already collected items if a later page fails', async () => {
    const f = fixture([{ ok: true, data: [{ id: 'a' }], hasNextPage: true }]);
    f.execute.mockRejectedValueOnce(new Error('page two failed'));
    await expect(f.http.readMapped(definition(), 'catalog', {}, 'token')).rejects.toThrow('page two failed');
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it('rejects inconsistent summary fields across pages', async () => {
    const d = definition();
    d.operations.catalog.output!.fields = { count: { path: '$.count', type: 'number', required: true } };
    const f = fixture([{ ok: true, count: 2, data: [{ id: 'a' }], hasNextPage: true },
      { ok: true, count: 3, data: [{ id: 'b' }], hasNextPage: false }]);
    await expect(f.http.readMapped(d, 'catalog', {}, 'token')).rejects.toThrow('fields changed');
  });
});
