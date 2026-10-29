import { Types } from 'mongoose';
import { VouchersService } from './vouchers.service';
import { OrderStatusEnum } from '../enum/order.enum';

describe('Voucher country materialization', () => {
  it.each([
    ['DE', 'US', 'DE'],
    [undefined, 'US', 'US'],
    [undefined, undefined, 'VN'],
  ])('provider=%s snapshot=%s materializes %s', async (providerCode, snapshotCode, expected) => {
    const sut: any = Object.create(VouchersService.prototype);
    const result = { proxies: [{ host: '127.0.0.1', port: 80, country_code: providerCode }] };
    const order = { _id: new Types.ObjectId(), status: OrderStatusEnum.PROCESSING, quantity: 1,
      voucher_resolution: 'fulfilled', voucher_fulfilment: { result, partnerCode: 'gpnip' },
      config: { country_policy: { code: snapshotCode } } };
    sut.orders = {
      updateOne: jest.fn(),
      findById: () => ({ select: () => ({ lean: async () => order }) }),
      findOneAndUpdate: () => ({ lean: async () => null }),
    };
    sut.proxies = { updateOne: jest.fn(), countDocuments: jest.fn().mockResolvedValue(1) };
    await sut.materialize(order._id, result, 'gpnip');
    expect(sut.proxies.updateOne).toHaveBeenCalledWith(expect.anything(),
      { $setOnInsert: expect.objectContaining({ country_code: expected }) }, { upsert: true, runValidators: true });
  });
});
