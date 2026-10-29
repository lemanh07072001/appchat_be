import { BadRequestException } from '@nestjs/common';
import { ConnectorDefinition, ConnectorRequestValue, validateConnectorDefinition } from './connector-definition';
import { readWorkflowPath, WorkflowValue } from '../proxy-providers/workflows/provider-workflow';
import { evaluateConnectorBody } from './connector-body';
import { assertPurchaseProtocolInput, assertPurchaseIspInput, assertPurchaseCountryInput, assertPurchaseTextInputs } from './connector-purchase-policy';

export interface ConnectorRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

function fields(mapping: Record<string, ConnectorRequestValue> | undefined, input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(mapping ?? {}).map(([key, expression]) => {
    const resolve = (part: WorkflowValue) => {
      const value = 'literal' in part ? part.literal : readWorkflowPath({ input }, part.path);
      if (value === undefined) throw new BadRequestException(`Missing provider input: ${key}`);
      return value;
    };
    const value = 'concat' in expression ? expression.concat.map(part => scalar(resolve(part))).join('') : resolve(expression);
    if (typeof value === 'string' && value.length > 8192) throw new BadRequestException('Provider parameter exceeds limit');
    if (value === undefined) throw new BadRequestException(`Missing provider input: ${key}`);
    return [key, value];
  }));
}

function scalar(value: unknown): string {
  if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) {
    throw new BadRequestException('Provider path/query/form values must be finite scalar values');
  }
  return String(value);
}

/** Never log/serialize this object: URL, headers and body may contain credentials. */
export function buildConnectorRequest(definition: ConnectorDefinition, operation: string,
  input: Record<string, unknown>, token: string): ConnectorRequest {
  validateConnectorDefinition(definition);
  if (!Object.hasOwn(definition.operations, operation)) throw new BadRequestException('Unknown provider operation');
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new BadRequestException('Invalid API key');
  const op = definition.operations[operation];
  const buy = definition.actions.buy;
  if (buy && 'operation' in buy && buy.operation === operation) {
    assertPurchaseProtocolInput(definition.purchasePolicy, input);
    assertPurchaseIspInput(definition.purchasePolicy, input);
    assertPurchaseCountryInput(definition.purchasePolicy, input);
    assertPurchaseTextInputs(definition.purchasePolicy, input);
  }
  const pathValues = fields(op.request?.path, input);
  if (definition.auth.type === 'path') {
    if (!op.path.includes(`{${definition.auth.name}}`)) throw new BadRequestException('Missing credential path placeholder');
    pathValues[definition.auth.name!] = token;
  }
  const path = op.path.replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g, (_, key: string) => {
    if (!Object.hasOwn(pathValues, key)) throw new BadRequestException(`Missing provider path parameter: ${key}`);
    const value = scalar(pathValues[key]);
    // Prevent dot-segment normalization and path/scheme injection, even after upstream decoding.
    if (!value || value === '.' || value === '..' || /[\/\\%?#\x00-\x20]/.test(value)) {
      throw new BadRequestException('Unsafe provider path value');
    }
    return encodeURIComponent(value);
  });
  if (/[{}]/.test(path)) throw new BadRequestException('Unresolved provider path placeholder');
  const url = new URL(definition.baseUrl.replace(/\/$/, '') + path);
  for (const [key, value] of Object.entries(fields(op.request?.query, input))) url.searchParams.set(key, scalar(value));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (definition.auth.type === 'query') url.searchParams.set(definition.auth.name!, token);
  else if (definition.auth.type === 'bearer') headers.Authorization = `Bearer ${token}`;
  else if (definition.auth.type === 'header') headers[definition.auth.name!] = token;
  let body: string | undefined;
  if (op.request?.body) {
    const values = Object.fromEntries(Object.entries(op.request.body).map(([key, expression]) =>
      [key, evaluateConnectorBody(expression, input)]));
    if (op.request.encoding === 'form') {
      body = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, scalar(value)])).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      try { body = JSON.stringify(values); } catch { throw new BadRequestException('Invalid provider JSON input'); }
      headers['Content-Type'] = 'application/json';
    }
    if (Buffer.byteLength(body) > 100_000) throw new BadRequestException('Provider request body exceeds limit');
  }
  return { url, method: op.method, headers, body, timeoutMs: op.timeoutMs };
}
