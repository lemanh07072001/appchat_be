import { BadGatewayException } from '@nestjs/common';
import { ConnectorAction, ConnectorDefinition } from './connector-definition';
import { mapConnectorOutput } from './connector-output';

type Mapped = ReturnType<typeof mapConnectorOutput>;
type Field = string | number | boolean;

/** Business contracts are provider independent. Never infer success from HTTP 200. */
export function validateConnectorResult(action: ConnectorAction, result: Mapped): Mapped {
  const fail = (): never => { throw new BadGatewayException('Provider result violates action contract'); };
  const text = (value: Field | undefined) => typeof value === 'string' && !!value.trim();
  const nonnegative = (value: Field | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const port = (value: Field | undefined) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
  const proxies = () => {
    if (!Array.isArray(result.items)) return fail();
    for (const proxy of result.items) {
      if (!text(proxy.host) || /[\s/\\?#]/.test(String(proxy.host)) ||
          ((proxy.httpPort !== undefined || proxy.socks5Port !== undefined)
            ? !port(proxy.httpPort) || !port(proxy.socks5Port) || proxy.port !== undefined || proxy.protocol !== undefined
            : !port(proxy.port) || !['http', 'https', 'socks5', 'socks4'].includes(String(proxy.protocol))) ||
          (proxy.username !== undefined && typeof proxy.username !== 'string') ||
          (proxy.password !== undefined && typeof proxy.password !== 'string')) fail();
    }
  };
  switch (action) {
    case 'buy':
      if (!text(result.fields.provider_order_id)) fail();
      // An accepted order may not have proxies yet. Fetch/poll is a separate read.
      if (result.items !== undefined) proxies();
      break;
    case 'fetch': proxies(); break;
    case 'catalog':
      if (!result.items || result.items.some(item => !text(item.id) || !text(item.name))) fail();
      break;
    case 'usage': if (!nonnegative(result.fields.used_gb)) fail(); break;
    case 'rotate': if (!text(result.fields.new_host)) fail(); break;
    case 'renew':
    case 'cancel':
    case 'topup':
    case 'password':
    case 'allowedIps': if (result.fields.success !== true) fail(); break;
  }
  return result;
}

export function connectorActionReadiness(definition: ConnectorDefinition) {
  return Object.entries(definition.actions).map(([name, binding]) => {
    const action = name as ConnectorAction;
    const issues: string[] = [];
    if ('workflow' in binding) {
      issues.push('Workflow requires order lifecycle integration');
    } else {
      const op = definition.operations[binding.operation];
      if (!op?.response) issues.push('Missing success assertion');
      if (action !== 'check' && !op?.output) issues.push('Missing output mapping');
      const required: Partial<Record<ConnectorAction, string[]>> = {
        buy: ['provider_order_id'], usage: ['used_gb'], rotate: ['new_host'],
        renew: ['success'], cancel: ['success'], topup: ['success'], password: ['success'], allowedIps: ['success'],
      };
      for (const field of required[action] ?? []) {
        if (!op?.output?.fields?.[field]?.required) issues.push(`Missing required output: ${field}`);
      }
      if (['fetch', 'catalog'].includes(action) && !op?.output?.items) issues.push('Missing item mapping');
      const itemFields = action === 'fetch' ? (definition.purchasePolicy?.protocolMode === 'dual'
        ? { host: 'string', httpPort: 'number', socks5Port: 'number' } : { host: 'string', port: 'number', protocol: 'string' })
        : action === 'catalog' ? { id: 'string', name: 'string' } : {};
      for (const [field, type] of Object.entries(itemFields)) {
        const mapped = op?.output?.items?.fields?.[field];
        if (!mapped?.required || mapped.type !== type) issues.push(`Missing required item output: ${field}`);
      }
      if (action === 'check' && op?.method !== 'GET') issues.push('Connection check requires GET');
      if (op?.effect === 'write' || !['check', 'catalog', 'fetch', 'usage'].includes(action)) {
        issues.push('Paid/write execution is not connected to order ledger');
      }
    }
    return { action, ready: issues.length === 0, issues };
  });
}
