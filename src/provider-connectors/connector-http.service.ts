import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { ConnectorDefinition, validateConnectorDefinition } from './connector-definition';
import { buildConnectorRequest } from './connector-request';
import { mapConnectorOutput } from './connector-output';
import { readWorkflowPath } from '../proxy-providers/workflows/provider-workflow';
import { connectorSucceeded } from './connector-success';

/** Conservative IPv4-only egress policy. IPv6 and special-use ranges fail closed. */
export function isPublicConnectorAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

@Injectable()
export class ConnectorHttp {
  /** Read-only normalized actions. Paid execution must go through the order ledger. */
  async readMapped(definition: ConnectorDefinition, action: 'catalog' | 'fetch' | 'usage',
    input: Record<string, unknown>, token: string) {
    const binding = definition.actions[action];
    const op = binding && 'operation' in binding ? definition.operations[binding.operation] : undefined;
    if (!binding || !('operation' in binding) || !op || op.effect !== 'read' || !op.output || !op.response) {
      throw new BadRequestException('Read action requires success and output mappings');
    }
    validateConnectorDefinition(definition);
    let result: ReturnType<typeof mapConnectorOutput> | undefined;
    const deadline = Date.now() + 60_000;
    for (let page = 1; page <= (op.pagination?.maxPages ?? 1); page++) {
      const remaining = deadline - Date.now();
      if (remaining < 1000) throw new BadGatewayException('Provider pagination timed out');
      const paged = structuredClone(definition);
      const requestOp = paged.operations[binding.operation];
      requestOp.timeoutMs = Math.min(requestOp.timeoutMs, remaining);
      if (op.pagination) {
        requestOp.request = { ...requestOp.request, query: { ...requestOp.request?.query,
          [op.pagination.pageParameter]: { literal: page },
          [op.pagination.pageSizeParameter]: { literal: op.pagination.pageSize } } };
        // Pagination is orchestrated here; avoid conflicting query mappings on revalidation.
        delete requestOp.pagination;
      }
      const response = await this.execute(paged, binding.operation, input, token, false);
      if (!connectorSucceeded(response, op.response.success)) {
        throw new BadGatewayException('Provider did not confirm read action');
      }
      const mapped = mapConnectorOutput(op.output, response);
      if (JSON.stringify(mapped).includes(token)) throw new BadGatewayException('Provider output contains account credential');
      if (!result) result = mapped;
      else {
        if (JSON.stringify(result.fields) !== JSON.stringify(mapped.fields)) throw new BadGatewayException('Provider pagination fields changed');
        result.items!.push(...mapped.items!);
      }
      if ((result.items?.length ?? 0) > 5000 || Buffer.byteLength(JSON.stringify(result)) > 5_000_000) {
        throw new BadGatewayException('Provider pagination exceeds limit');
      }
      if (!op.pagination) return result;
      const next = readWorkflowPath(response, op.pagination.hasNextPath);
      if (typeof next !== 'boolean') throw new BadGatewayException('Invalid provider pagination marker');
      if (!next) return result;
      if (!mapped.items?.length) throw new BadGatewayException('Provider pagination made no progress');
    }
    // Never project a truncated page set as a delivered/partial order.
    throw new BadGatewayException('Provider pagination incomplete');
  }
  async check(definition: ConnectorDefinition, token: string): Promise<unknown> {
    const action = definition.actions.check;
    const op = action && 'operation' in action && definition.operations[action.operation];
    // First release deliberately exposes only body-free read-only checks.
    if (!op || op.effect !== 'read' || op.method !== 'GET') {
      throw new BadRequestException('A read-only GET connection check is required');
    }
    const prepared = buildConnectorRequest(definition, action && 'operation' in action ? action.operation : '', {}, token);
    return this.send(prepared);
  }

  /** Internal workflow transport, not an arbitrary HTTP admin endpoint. */
  async execute(definition: ConnectorDefinition, operation: string, input: Record<string, unknown>, token: string,
    allowWrite = false): Promise<unknown> {
    const op = Object.hasOwn(definition.operations, operation) ? definition.operations[operation] : undefined;
    if (!op || (op.effect === 'write' && !allowWrite)) throw new BadRequestException('Provider write operation is disabled');
    return this.send(buildConnectorRequest(definition, operation, input, token));
  }

  private async send(prepared: ReturnType<typeof buildConnectorRequest>): Promise<unknown> {
    const url = prepared.url;
    const deadline = Date.now() + prepared.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses: Awaited<ReturnType<typeof lookup>>[];
    try {
      addresses = await Promise.race([
        lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), prepared.timeoutMs); }),
      ]);
    } catch { throw new BadGatewayException('Provider DNS lookup failed'); }
    finally { if (timer) clearTimeout(timer); }
    if (!addresses.length || addresses.some(item => !isPublicConnectorAddress(item.address))) {
      throw new BadRequestException('Provider address is not allowed');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BadGatewayException('Provider request timed out');
    return new Promise((resolve, reject) => {
      const fail = () => reject(new BadGatewayException('Provider request failed; upstream outcome may require reconciliation'));
      const req = request(url, {
        method: prepared.method, agent: false, family: 4,
        headers: prepared.headers,
        // Pin the validated address; TLS still verifies the original hostname.
        lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
      }, response => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy(); req.destroy(); fail(); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1_048_576) { response.destroy(); req.destroy(); fail(); }
          else chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { fail(); }
        });
      });
      const timeout = setTimeout(() => req.destroy(new Error('timeout')), remaining);
      req.on('close', () => clearTimeout(timeout));
      req.on('error', fail);
      req.end(prepared.body);
    });
  }
}
