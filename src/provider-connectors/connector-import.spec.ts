import { ConnectorImport } from './connector-import.service';

describe('OpenAPI import preview', () => {
  const importer = new ConnectorImport();
  const document = {
    openapi: '3.0.3', servers: [{ url: 'https://api.example.com' }],
    paths: { '/orders': { get: { operationId: 'listOrders' }, post: { operationId: 'createOrder' } },
      '/orders/{id}': { get: { operationId: 'getOrder' } } },
  };
  it('imports paths without enabling actions or treating GET as safe automatically', () => {
    const preview = importer.preview(document);
    expect(preview.operationCount).toBe(3);
    expect(preview.definition.actions).toEqual({});
    expect(preview.definition.operations.listOrders.effect).toBe('write');
    expect(preview.definition.operations.getOrder.path).toBe('/orders/{id}');
  });
  it('does not copy credentials, examples or request defaults', () => {
    const result = importer.preview({ ...document, secret: 'private-secret',
      components: { securitySchemes: { key: { example: 'private-secret' } } } });
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  it('rejects unsafe servers, missing documents and unsupported versions', () => {
    expect(() => importer.preview(undefined)).toThrow();
    expect(() => importer.preview({ ...document, openapi: '2.0' })).toThrow();
    expect(() => importer.preview(document, 'https://127.0.0.1')).toThrow();
  });
  it('skips server overrides and does not resolve external references', () => {
    const result = importer.preview({ ...document, paths: { ...document.paths,
      '/external': { $ref: 'https://internal.example.com/api.json' },
      '/override': { get: { servers: [{ url: 'https://other.example.com' }] } } } });
    expect(result.operationCount).toBe(3);
    expect(result.warnings.some(w => w.includes('reference'))).toBe(true);
  });
  it('deduplicates operation IDs', () => {
    const result = importer.preview({ ...document, paths: { '/one': { get: { operationId: 'same' } }, '/two': { get: { operationId: 'same' } } } });
    expect(Object.keys(result.definition.operations)).toHaveLength(2);
  });

  const postman = (item: unknown[]) => ({
    info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item,
  });
  it('imports nested Postman requests without scripts, tokens or examples', () => {
    const result = importer.preview(postman([{ name: 'Folder', item: [{ name: 'key-secret',
      event: [{ script: { exec: ['dangerous()'] } }],
      request: { method: 'GET', url: 'https://api.example.com/account?key=private-secret',
        auth: { bearer: [{ value: 'private-secret' }] }, body: { raw: 'private-secret' } },
    }] }]));
    expect(result.operationCount).toBe(1);
    expect(result.definition.operations.request_1).toMatchObject({ path: '/account', effect: 'write' });
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(JSON.stringify(result)).not.toContain('dangerous');
    expect(JSON.stringify(result)).not.toContain('key-secret');
  });
  it('resolves only a leading Postman origin placeholder with an explicit base URL', () => {
    const result = importer.preview(postman([{ request: { method: 'GET', url: { raw: '{{baseUrl}}/orders/:id' } } }]), 'https://api.example.com/v1');
    expect(result.definition.baseUrl).toBe('https://api.example.com/v1');
    expect(result.definition.operations.request_1.path).toBe('/orders/{id}');
    expect(() => importer.preview(postman([{ request: { method: 'GET', url: '{{baseUrl}}/account' } }]))).toThrow();
  });
  it('does not import requests for other origins or credential-bearing URLs', () => {
    const result = importer.preview(postman([
      { request: { method: 'GET', url: 'https://api.example.com/account' } },
      { request: { method: 'POST', url: 'https://other.example.com/buy' } },
      { request: { method: 'GET', url: 'https://user:secret@api.example.com/private' } },
    ]));
    expect(result.operationCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret@');
  });
  it('rejects excessively nested Postman folders', () => {
    let item: unknown[] = [{ request: { method: 'GET', url: 'https://api.example.com/account' } }];
    for (let i = 0; i < 12; i++) item = [{ item }];
    expect(() => importer.preview(postman(item))).toThrow('depth');
  });
});
