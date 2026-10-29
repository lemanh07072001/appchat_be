import { validateConnectorDefinition } from './connector-definition';
import { buildConnectorRequest } from './connector-request';
import { evaluateConnectorBody } from './connector-body';

describe('Declarative nested JSON request bodies', () => {
  function definition() {
    return validateConnectorDefinition({ baseUrl: 'https://api.homeproxy.vn/api', auth: { type: 'bearer' },
      operations: { buy: { method: 'POST', path: '/merchant/orders', effect: 'write', timeoutMs: 30000,
        request: { body: {
          paymentMethod: { literal: 'WALLET' }, products: { array: [{ object: {
            isCdk: { literal: false }, dayOfUse: { path: '$.input.durationDays' }, rotateInterval: { literal: 0 },
            user: { path: '$.input.username' }, password: { path: '$.input.password' },
            protocolType: { literal: 'HTTP' }, provider: { literal: 'VIETTEL' }, quantity: { path: '$.input.quantity' },
            product: { object: { id: { path: '$.input.packageId' } } },
          } }] },
        } },
      } }, actions: { buy: { operation: 'buy' } } });
  }
  it('constructs HomeProxy-shaped products without embedding credentials or provider branches', () => {
    const input = { durationDays: 30, quantity: 2, username: 'user', password: 'pass', packageId: 'product-id' };
    const request = buildConnectorRequest(definition(), 'buy', input, 'account-token');
    expect(JSON.parse(request.body!)).toEqual({ paymentMethod: 'WALLET', products: [{ isCdk: false,
      dayOfUse: 30, rotateInterval: 0, user: 'user', password: 'pass', protocolType: 'HTTP',
      provider: 'VIETTEL', quantity: 2, product: { id: 'product-id' } }] });
    expect(request.body).not.toContain('account-token');
    expect(JSON.stringify(definition())).not.toContain('pass"');
  });
  it('refuses missing nested inputs before any dispatch', () => {
    expect(() => buildConnectorRequest(definition(), 'buy', { quantity: 1 }, 'token')).toThrow('Missing provider input');
  });
  it.each([
    { path: '$.input.__proto__.x' }, { object: JSON.parse('{"__proto__":{"literal":"unsafe"}}') },
    { literal: JSON.parse('{"constructor":true}') }, { array: Array(101).fill({ literal: 1 }) },
    { object: { x: { script: 'return 1' } } }, { literal: undefined }, { literal: NaN },
    { path: '$.input.x', literal: 1 },
  ])('rejects unsafe or unsupported body expression %#', expression => {
    expect(() => evaluateConnectorBody(expression as any, {}, true)).toThrow();
  });
  it('bounds expression depth and disallows nested form values', () => {
    let expression: any = { literal: 1 };
    for (let i = 0; i < 14; i++) expression = { array: [expression] };
    expect(() => evaluateConnectorBody(expression, {}, true)).toThrow();
    const d = definition(); d.operations.buy.request!.encoding = 'form';
    expect(() => validateConnectorDefinition(d)).toThrow();
  });
});
