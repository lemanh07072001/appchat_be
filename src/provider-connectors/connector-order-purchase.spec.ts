import { ConnectorOrderPurchase } from './connector-order-purchase.service';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';
import { validateConnectorDefinition } from './connector-definition';
import { homeproxyPurchaseCandidate } from './homeproxy-template';

describe('Order-bound Connector purchase bridge', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture() {
    const binding = { accountId: id, connectorCode: 'example', connectorVersion: 1, input: { quantity: 1 } };
    const order = { _id: id, connector_purchase: binding, connector_purchase_state: null,
      status: OrderStatusEnum.PENDING, payment_status: PaymentStatusEnum.PAID, provider_order_id: '' };
    const query = (value: unknown) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(value) });
    const orders = { findById: jest.fn(() => query(order)), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    const account = { enabled: true, connectorCode: 'example', connectorVersion: 1, credential: 'encrypted' };
    const accounts = { findById: jest.fn(() => query(account)) };
    const definition = validateConnectorDefinition({ baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
      operations: { buy: { method: 'POST', path: '/orders', effect: 'write', timeoutMs: 1000,
        response: { success: { path: '$.ok', equals: true } },
        output: { fields: { provider_order_id: { path: '$.id', type: 'string', required: true } } } } }, actions: { buy: { operation: 'buy' } } });
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue(definition) };
    const secrets = { decrypt: jest.fn().mockReturnValue('account-secret') };
    const dispatches = { claim: jest.fn().mockResolvedValue({ acquired: true, id, owner: 'owner' }),
      submitted: jest.fn(), saveResult: jest.fn(), complete: jest.fn(), unknown: jest.fn(), recoverResult: jest.fn() };
    const http = { execute: jest.fn().mockResolvedValue({ ok: true, id: 'upstream-order' }) };
    const service = new ConnectorOrderPurchase(orders as any, accounts as any, connectors as any, secrets as any, dispatches as any, http as any);
    return { service, order, orders, account, connectors, http, dispatches, definition, secrets };
  }
  it('dispatches only a paid, pinned order and projects the accepted upstream ID', async () => {
    const f = fixture();
    await f.service.purchase(id);
    expect(f.orders.updateOne.mock.calls[0][0]).toMatchObject({ payment_status: PaymentStatusEnum.PAID, connector_purchase: f.order.connector_purchase });
    expect(f.dispatches.claim).toHaveBeenCalledWith(expect.objectContaining({ reference: `buy:${id}`, action: 'buy', connectorVersion: 1 }), { quantity: 1 });
    expect(f.orders.updateOne.mock.calls[1][1]).toEqual({ $set: {
      provider_order_id: 'upstream-order', connector_purchase_state: 'awaiting_delivery', error_message: '',
    } });
  });
  it.each(['unpaid', 'attempted', 'voucher', 'provider-id', 'account-version', 'unpublished', 'race'])(
    'never sends upstream for %s orders', async reason => {
      const f = fixture();
      if (reason === 'unpaid') f.order.payment_status = PaymentStatusEnum.UNPAID;
      if (reason === 'attempted') (f.order as any).connector_purchase_state = 'dispatching';
      if (reason === 'voucher') (f.order as any).voucher_snapshot = {};
      if (reason === 'provider-id') f.order.provider_order_id = 'already-purchased';
      if (reason === 'account-version') f.account.connectorVersion = 2;
      if (reason === 'unpublished') f.connectors.publishedDefinition.mockResolvedValue(null);
      if (reason === 'race') f.orders.updateOne.mockResolvedValue({ modifiedCount: 0 });
      await expect(f.service.purchase(id)).rejects.toThrow();
      expect(f.http.execute).not.toHaveBeenCalled();
    });
  it('quarantines ambiguous purchases without changing payment status or scheduling refunds', async () => {
    const f = fixture(); f.http.execute.mockRejectedValue(new Error('private upstream data'));
    await expect(f.service.purchase(id)).rejects.toThrow('requires reconciliation');
    expect(f.orders.updateOne.mock.calls.at(-1)?.[1]).toEqual({ $set: {
      connector_purchase_state: 'reconciliation', error_message: expect.any(String),
    } });
    expect(f.dispatches.unknown).toHaveBeenCalled();
    expect(f.http.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['missing-input', 'unsafe-path', 'missing-action', 'read-operation', 'missing-output', 'missing-success', 'invalid-token', 'wrong-protocol', 'empty-password'])(
    'rejects local preflight failure before any permanent order or dispatch claim: %s', async reason => {
      const f = fixture();
      if (reason === 'missing-input') f.definition.operations.buy.request = { body: { product: { path: '$.input.packageId' } } };
      if (reason === 'unsafe-path') {
        f.definition.operations.buy.path = '/orders/{product}';
        f.definition.operations.buy.request = { path: { product: { literal: '..' } } };
      }
      if (reason === 'missing-action') delete f.definition.actions.buy;
      if (reason === 'read-operation') f.definition.operations.buy.effect = 'read';
      if (reason === 'missing-output') delete f.definition.operations.buy.output;
      if (reason === 'missing-success') delete f.definition.operations.buy.response;
      if (reason === 'invalid-token') f.secrets.decrypt.mockReturnValue('invalid\ncredential');
      if (reason === 'wrong-protocol' || reason === 'empty-password') {
        f.connectors.publishedDefinition.mockResolvedValue(homeproxyPurchaseCandidate());
        Object.assign(f.order.connector_purchase.input, { packageId: 'sample-product', durationDays: 1,
          protocol: reason === 'wrong-protocol' ? 'socks5' : 'http', username: 'sample-user',
          password: reason === 'empty-password' ? '  ' : 'sample-password' });
      }
      await expect(f.service.purchase(id)).rejects.toThrow();
      expect(f.orders.updateOne).not.toHaveBeenCalled();
      expect(f.dispatches.claim).not.toHaveBeenCalled();
      expect(f.dispatches.submitted).not.toHaveBeenCalled();
      expect(f.dispatches.unknown).not.toHaveBeenCalled();
      expect(f.http.execute).not.toHaveBeenCalled();
    });
  it('recovers an accepted result after order projection failure without any upstream call', async () => {
    const f = fixture();
    f.order.status = OrderStatusEnum.PROCESSING;
    (f.order as any).connector_purchase_state = 'reconciliation';
    f.dispatches.recoverResult.mockResolvedValue({ status: 'unknown', result: { fields: { provider_order_id: 'paid-order' } } });
    expect(await f.service.recover(id)).toBe(true);
    expect(f.dispatches.recoverResult).toHaveBeenCalledWith(expect.objectContaining({ reference: `buy:${id}`, action: 'buy' }), f.order.connector_purchase.input);
    expect(f.orders.updateOne.mock.calls[0][1]).toEqual({ $set: {
      provider_order_id: 'paid-order', connector_purchase_state: 'awaiting_delivery', error_message: '',
    } });
    expect(f.http.execute).not.toHaveBeenCalled();
    expect(f.dispatches.claim).not.toHaveBeenCalled();
    expect(f.dispatches.complete).not.toHaveBeenCalled();
  });
  it.each(['no-result', 'live-owner', 'different-id', 'unpaid', 'changed-order'])(
    'does not overwrite or resubmit unsafe recovery: %s', async reason => {
      const f = fixture();
      f.order.status = OrderStatusEnum.PROCESSING;
      (f.order as any).connector_purchase_state = 'reconciliation';
      f.dispatches.recoverResult.mockResolvedValue({ status: 'unknown', result: { fields: { provider_order_id: 'paid-order' } } });
      if (reason === 'no-result') f.dispatches.recoverResult.mockResolvedValue(null);
      if (reason === 'live-owner') f.dispatches.recoverResult.mockResolvedValue({ status: 'submitted', result: { fields: { provider_order_id: 'paid-order' } } });
      if (reason === 'different-id') f.order.provider_order_id = 'other-order';
      if (reason === 'unpaid') f.order.payment_status = PaymentStatusEnum.UNPAID;
      if (reason === 'changed-order') f.orders.updateOne.mockResolvedValue({ modifiedCount: 0 });
      if (reason === 'different-id') await expect(f.service.recover(id)).rejects.toThrow('differs');
      else expect(await f.service.recover(id)).toBe(false);
      expect(f.http.execute).not.toHaveBeenCalled();
      expect(f.dispatches.claim).not.toHaveBeenCalled();
      if (reason !== 'changed-order') expect(f.orders.updateOne).not.toHaveBeenCalled();
    });
});
