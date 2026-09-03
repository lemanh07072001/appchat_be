import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';

/**
 * `deduct` là chỗ tiền rời khỏi ví khách. Hai điều phải đúng tuyệt đối:
 * không bao giờ trừ quá số dư, và không bao giờ ghi sổ một khoản chưa xảy ra.
 *
 * Theo idiom sẵn có trong repo (xem check-connection.spec.ts): dựng prototype
 * trần rồi gán thẳng dependency giả, không qua Nest DI.
 */
describe('UsersService', () => {
  type Svc = UsersService;

  /** Model giả: vừa gọi được như hàm khởi tạo, vừa có static method. */
  const makeUserModel = (over: Record<string, any> = {}) => {
    const saved: any[] = [];
    const model: any = function (this: any, doc: any) {
      Object.assign(this, doc);
      this.save = jest.fn(async () => {
        saved.push(doc);
        return doc;
      });
    };
    model.saved = saved;
    model.findOne = jest.fn(() => ({ exec: async () => null }));
    model.findById = jest.fn(() => ({ select: () => ({ exec: async () => null }) }));
    model.findOneAndUpdate = jest.fn(() => ({
      select: () => ({ exec: async () => null }),
    }));
    Object.assign(model, over);
    return model;
  };

  const makeService = (userModel: any) => {
    const svc = Object.create(UsersService.prototype) as Svc;
    (svc as any).userModel = userModel;
    (svc as any).txModel = { create: jest.fn(async () => ({})) };
    (svc as any).walletTxService = { log: jest.fn() };
    (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return svc;
  };

  describe('deduct', () => {
    it.each([0, -1, -0.5, NaN])('từ chối số tiền %p mà không chạm DB', async (amount) => {
      const model = makeUserModel();
      const svc = makeService(model);

      await expect(svc.deduct('u1', amount as number)).rejects.toThrow(BadRequestException);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('không đủ tiền thì KHÔNG ghi transaction lẫn wallet log', async () => {
      // Đây là ca đắt nhất: ghi sổ một khoản trừ chưa từng xảy ra thì sổ sách
      // sai vĩnh viễn, và đối soát sau này không tài nào lần ra.
      const model = makeUserModel({
        // Điều kiện money >= amount không khớp → Mongo trả null.
        findOneAndUpdate: jest.fn(() => ({ select: () => ({ exec: async () => null }) })),
        findById: jest.fn(() => ({ select: () => ({ exec: async () => ({ money: 500 }) }) })),
      });
      const svc = makeService(model);

      await expect(svc.deduct('u1', 1000)).rejects.toThrow(/Số dư không đủ/);

      expect((svc as any).txModel.create).not.toHaveBeenCalled();
      expect((svc as any).walletTxService.log).not.toHaveBeenCalled();
    });

    it('phân biệt user không tồn tại với số dư không đủ', async () => {
      const model = makeUserModel({
        findOneAndUpdate: jest.fn(() => ({ select: () => ({ exec: async () => null }) })),
        findById: jest.fn(() => ({ select: () => ({ exec: async () => null }) })),
      });
      const svc = makeService(model);

      await expect(svc.deduct('u-khong-co', 1000)).rejects.toThrow(/User không tồn tại/);
    });

    it('trừ thành công thì balance_before = balance_after + amount', async () => {
      const model = makeUserModel({
        findOneAndUpdate: jest.fn(() => ({
          select: () => ({
            // Document SAU khi trừ: 5000 - 2000
            exec: async () => ({ _id: 'u1', email: 'a@b.c', money: 3000 }),
          }),
        })),
      });
      const svc = makeService(model);

      const res = await svc.deduct('u1', 2000);

      expect(res.balance_after).toBe(3000);
      expect(res.balance_before).toBe(5000);
      expect((svc as any).txModel.create).toHaveBeenCalledTimes(1);
    });

    it('trừ tiền bằng một lệnh atomic có điều kiện money >= amount', async () => {
      // Đọc rồi trừ theo hai bước là chỗ đẻ ra số dư âm khi có hai request
      // song song. Ghim lại điều kiện để không ai refactor mất nó.
      const model = makeUserModel({
        findOneAndUpdate: jest.fn(() => ({
          select: () => ({ exec: async () => ({ _id: 'u1', email: 'a@b.c', money: 0 }) }),
        })),
      });
      const svc = makeService(model);

      await svc.deduct('u1', 1000);

      const [filter, update] = model.findOneAndUpdate.mock.calls[0];
      expect(filter.money).toEqual({ $gte: 1000 });
      expect(update).toEqual({ $inc: { money: -1000 } });
    });
  });

  describe('validateUser', () => {
    it('email không tồn tại → null, và thoát trước khi so mật khẩu', async () => {
      const model = makeUserModel({ findOne: jest.fn(() => ({ exec: async () => null })) });
      const svc = makeService(model);

      // `null` ở đây tự chứng minh đã thoát sớm: nếu chạy tiếp tới
      // bcrypt.compare(password, undefined) thì nó ném lỗi, không trả null.
      await expect(svc.validateUser('la@b.c', 'bat-ky')).resolves.toBeNull();
    });

    it('sai mật khẩu → null, không trả về user', async () => {
      const hash = await bcrypt.hash('dung-mat-khau', 10);
      const model = makeUserModel({
        findOne: jest.fn(() => ({ exec: async () => ({ email: 'a@b.c', password: hash }) })),
      });
      const svc = makeService(model);

      await expect(svc.validateUser('a@b.c', 'sai-mat-khau')).resolves.toBeNull();
    });

    it('đúng mật khẩu → trả về user', async () => {
      const hash = await bcrypt.hash('dung-mat-khau', 10);
      const model = makeUserModel({
        findOne: jest.fn(() => ({ exec: async () => ({ email: 'a@b.c', password: hash }) })),
      });
      const svc = makeService(model);

      await expect(svc.validateUser('a@b.c', 'dung-mat-khau')).resolves.toMatchObject({
        email: 'a@b.c',
      });
    });
  });

  describe('create', () => {
    it('email trùng → từ chối, không tạo user', async () => {
      const model = makeUserModel({
        findOne: jest.fn(() => ({ exec: async () => ({ email: 'a@b.c' }) })),
      });
      const svc = makeService(model);

      await expect(
        svc.create({ email: 'a@b.c', password: 'x', name: 'A' } as any),
      ).rejects.toThrow(BadRequestException);

      expect(model.saved).toHaveLength(0);
    });

    it('lưu mật khẩu đã hash, không bao giờ lưu plaintext', async () => {
      const model = makeUserModel();
      const svc = makeService(model);

      await svc.create({
        email: 'moi@b.c',
        password: 'mat-khau-goc',
        name: 'Moi',
      } as any);

      expect(model.saved).toHaveLength(1);
      const doc = model.saved[0];
      expect(doc.password).not.toBe('mat-khau-goc');
      expect(await bcrypt.compare('mat-khau-goc', doc.password)).toBe(true);
    });
  });
});
