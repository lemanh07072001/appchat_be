import { BadRequestException } from '@nestjs/common';
import { PartnersService } from './partners.service';

describe('Admin provider package catalog', () => {
  it('requires a stored key even for an inactive setup partner', async () => {
    const svc: any = Object.create(PartnersService.prototype);
    svc.partnerModel = {
      findById: () => ({
        exec: async () => ({ code: 'gpnip', token_api: '' }),
      }),
    };
    const factory: any = { getProvider: jest.fn() };
    await expect(
      svc.listProviderPackages(factory, '000000000000000000000009'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(factory.getProvider).not.toHaveBeenCalled();
  });
  it('uses stored credentials and retains catalog metadata without returning the key', async () => {
    const svc: any = Object.create(PartnersService.prototype);
    svc.partnerModel = {
      findById: () => ({
        exec: async () => ({
          code: 'gpnip',
          status: false,
          token_api: 'test-only-key',
        }),
      }),
    };
    const listPackages = jest
      .fn()
      .mockResolvedValue({ data: [{ id: 42 }], meta: { current_page: 2 } });
    const factory: any = { getProvider: () => ({ listPackages }) };
    const result = await svc.listProviderPackages(
      factory,
      '000000000000000000000009',
      2,
    );
    expect(result).toEqual({ data: [{ id: 42 }], meta: { current_page: 2 } });
    expect(listPackages).toHaveBeenCalledWith('test-only-key', 2, 20);
  });
});
