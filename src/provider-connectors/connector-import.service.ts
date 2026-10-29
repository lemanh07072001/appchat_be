import { BadRequestException, Injectable } from '@nestjs/common';
import { validateConnectorDefinition } from './connector-definition';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

@Injectable()
export class ConnectorImport {
  /** Local preview only: never follows document URLs, $refs or invokes any operation. */
  preview(document: unknown, baseUrl?: string) {
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(document)); }
    catch { throw new BadRequestException('Invalid API document'); }
    if (size > 2_000_000) throw new BadRequestException('API document exceeds 2 MB');
    const root = object(document);
    if (Array.isArray(root.item)) return this.postman(root, baseUrl);
    if (typeof root.openapi !== 'string' || !/^3\.[01]\./.test(root.openapi)) {
      throw new BadRequestException('Only OpenAPI 3.0/3.1 JSON is supported in this release');
    }
    const servers = Array.isArray(root.servers) ? root.servers : [];
    const server = baseUrl ?? object(servers[0]).url;
    if (typeof server !== 'string') throw new BadRequestException('An HTTPS base URL is required');
    const warnings: string[] = [
      'Preview only. No requests were sent and no configuration was saved.',
      'All imported operations are classified as write until reviewed, including GET.',
      'Request bodies, parameters, response mappings and workflows require review; they are not imported in this release.',
    ];
    const operations: Record<string, { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; effect: 'write'; timeoutMs: number }> = {};
    let count = 0;
    for (const [path, rawPath] of Object.entries(object(root.paths))) {
      const pathItem = object(rawPath);
      if (pathItem.$ref) warnings.push(`Skipped referenced path: ${path}`);
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        if (!Object.hasOwn(pathItem, method)) continue;
        if (++count > 100) throw new BadRequestException('Maximum 100 operations per import');
        if (!/^\/[A-Za-z0-9/_{}.-]*$/.test(path) || path.startsWith('//') || path.includes('..')) {
          warnings.push(`Skipped unsupported path: ${method.toUpperCase()} ${path}`); continue;
        }
        const operation = object(pathItem[method]);
        if (operation.$ref || pathItem.servers || operation.servers) {
          warnings.push(`Skipped operation with references or server override: ${method.toUpperCase()} ${path}`); continue;
        }
        const source = typeof operation.operationId === 'string' ? operation.operationId : `${method}_${count}`;
        let name = source.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55);
        if (!/^[a-z]/.test(name)) name = `op_${name}`;
        if (Object.hasOwn(operations, name)) name = `${name}_${count}`;
        operations[name] = { method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path, effect: 'write', timeoutMs: 10000 };
      }
    }
    if (!Object.keys(operations).length) throw new BadRequestException('No supported operations found');
    // Do not copy examples, default values, headers or security credentials from documents.
    const definition = validateConnectorDefinition({ baseUrl: server, auth: { type: 'bearer' }, operations, actions: {} });
    warnings.push('Authentication defaults to Bearer; verify against provider documentation before publishing.');
    return { definition, operationCount: Object.keys(operations).length, warnings };
  }

  private postman(root: JsonObject, baseUrl?: string) {
    const schema = object(root.info).schema;
    if (typeof schema !== 'string' || !/\/collection\/v2\.[01]\.0\//.test(schema)) {
      throw new BadRequestException('Only Postman Collection v2.0/v2.1 is supported');
    }
    const warnings = [
      'Preview only. No requests were sent and no configuration was saved.',
      'All imported operations are classified as write until reviewed, including GET.',
      'Scripts, authentication credentials, headers, body examples and collection variables are not imported.',
      'Parameters, response mappings and workflows require manual review.',
    ];
    const operations: Record<string, { method: string; path: string; effect: string; timeoutMs: number }> = {};
    let server = baseUrl;
    let visited = 0;
    const walk = (items: unknown[], depth: number) => {
      if (depth > 10) throw new BadRequestException('Postman folders exceed maximum depth');
      for (const item of items) {
        if (++visited > 500) throw new BadRequestException('Postman collection exceeds 500 items');
        const entry = object(item);
        if (Array.isArray(entry.item)) { walk(entry.item, depth + 1); continue; }
        const request = object(entry.request);
        const method = request.method;
        if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          warnings.push('Skipped unsupported request method.'); continue;
        }
        const urlObject = object(request.url);
        const raw = typeof request.url === 'string' ? request.url : urlObject.raw;
        if (typeof raw !== 'string') { warnings.push('Skipped request without a raw URL.'); continue; }
        let normalized = raw;
        // An explicit base URL can replace exactly one leading origin variable.
        // Never evaluate variables or scripts from the collection.
        if (/^\{\{[^{}]+\}\}(\/|$)/.test(raw) && baseUrl) {
          normalized = raw.replace(/^\{\{[^{}]+\}\}/, baseUrl.replace(/\/$/, ''));
        }
        let url: URL;
        try { url = new URL(normalized); } catch { warnings.push('Skipped unresolved or invalid request URL.'); continue; }
        if (!server) server = url.origin;
        let expected: URL;
        try { expected = new URL(server); } catch { throw new BadRequestException('Invalid base URL'); }
        if (url.origin !== expected.origin || url.username || url.password) {
          warnings.push('Skipped request outside the selected origin or containing URL credentials.'); continue;
        }
        const prefix = expected.pathname.replace(/\/$/, '');
        if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) {
          warnings.push('Skipped request outside the selected base path.'); continue;
        }
        let path = url.pathname.slice(prefix.length) || '/';
        path = path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
        if (!/^\/[A-Za-z0-9/_{}.-]*$/.test(path) || path.includes('..') || path.startsWith('//')) {
          warnings.push('Skipped unsupported request path.'); continue;
        }
        if (url.search) warnings.push('Query parameters were omitted; configure them explicitly before use.');
        const count = Object.keys(operations).length + 1;
        if (count > 100) throw new BadRequestException('Maximum 100 operations per import');
        const name = `request_${count}`;
        operations[name] = { method, path, effect: 'write', timeoutMs: 10000 };
      }
    };
    walk(root.item as unknown[], 0);
    if (!server || !Object.keys(operations).length) throw new BadRequestException('No supported requests found; provide a base URL for origin variables');
    const definition = validateConnectorDefinition({ baseUrl: server, auth: { type: 'bearer' }, operations, actions: {} });
    warnings.push('Authentication defaults to Bearer; verify before publishing.');
    return { definition, operationCount: Object.keys(operations).length, warnings };
  }
}
