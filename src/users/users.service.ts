import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { User, UserDocument } from '../schemas/users.schema';
import { Transaction, TransactionDocument, TransactionStatus } from '../schemas/transactions.schema';
import { Model } from 'mongoose';
import { CreateUserDto } from '../dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
    @InjectModel(Transaction.name)
    private txModel: Model<TransactionDocument>,
  ) {}

  async findAll() {
    return await this.userModel.find().exec();
  }

  async findAllPaginated(
    page = 1,
    limit = 10,
    search?: string,
    status?: number,
    role?: number,
  ) {
    const filter: any = {};

    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [
        { name: regex },
        { email: regex },
        { topup_code: regex },
      ];
    }

    if (status != null) filter.status = status;
    if (role != null) filter.role = role;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.userModel.countDocuments(filter),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findById(id: string) {
    const user = await this.userModel.findById(id).select('-password').exec();
    if (!user) throw new BadRequestException('User không tồn tại');
    return user;
  }

  async fineByEmail(email: string) {
    return await this.userModel.findOne({ email }).exec();
  }

  async validateUser(email: string, password: string) {
    const user = await this.fineByEmail(email);

    if (!user) {
      return null;
    }

    const status = await bcrypt.compare(password, user.password);
    if (status) {
      return user;
    }

    return null;
  }

  private async generateUniqueTopupCode(): Promise<string> {
    let code: string;
    let exists: boolean;
    do {
      code = 'NAP' + crypto.randomBytes(4).toString('hex').toUpperCase();
      exists = !!(await this.userModel.findOne({ topup_code: code }).exec());
    } while (exists);
    return code;
  }

  async create(data: CreateUserDto): Promise<UserDocument> {
    const existingUser = await this.fineByEmail(data.email);

    if (existingUser) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: {
          email: 'Email already exists',
        },
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(data.password, salt);

    const topup_code = await this.generateUniqueTopupCode();

    const user = new this.userModel({
      ...data,
      password: hashedPassword,
      topup_code,
    });
    return user.save();
  }

  async update(id: string, data: any) {
    // Nếu đổi password → hash lại
    if (data.password) {
      const salt = await bcrypt.genSalt(10);
      data.password = await bcrypt.hash(data.password, salt);
    } else {
      delete data.password;
    }

    // Không cho sửa email trùng
    if (data.email) {
      const existing = await this.userModel.findOne({ email: data.email, _id: { $ne: id } }).exec();
      if (existing) {
        throw new BadRequestException('Email đã tồn tại');
      }
    }

    const user = await this.userModel
      .findByIdAndUpdate(id, data, { new: true })
      .select('-password')
      .exec();
    if (!user) throw new BadRequestException('User không tồn tại');
    return user;
  }

  async delete(id: string) {
    const user = await this.userModel.findByIdAndDelete(id).exec();
    if (!user) throw new BadRequestException('User không tồn tại');
    return { message: 'Xoá user thành công' };
  }

  async deleteMany(ids: string[]) {
    if (!ids?.length) throw new BadRequestException('Cần truyền danh sách ids');
    const result = await this.userModel.deleteMany({ _id: { $in: ids } }).exec();
    return { message: `Đã xoá ${result.deletedCount} user` };
  }

  // ─── Admin: nạp tiền cho user ─────────────────────────────────────────
  async deposit(userId: string, amount: number, note?: string) {
    if (!amount || amount <= 0) {
      throw new BadRequestException('Số tiền phải lớn hơn 0');
    }

    // Atomic: $inc + trả về document SAU khi cộng → tránh race condition
    const updatedUser = await this.userModel.findByIdAndUpdate(
      userId,
      { $inc: { money: amount } },
      { new: true },
    ).select('_id email money').exec();
    if (!updatedUser) throw new BadRequestException('User không tồn tại');

    const balanceAfter = Number(updatedUser.money ?? 0);
    const balanceBefore = balanceAfter - amount;

    const txId = Date.now() + Math.floor(Math.random() * 1000);
    await this.txModel.create({
      transaction_id: txId,
      gateway: 'MANUAL',
      transaction_date: new Date(),
      transaction_number: '',
      account_number: '',
      content: note || `Admin nạp ${amount.toLocaleString('vi-VN')}đ cho ${updatedUser.email}`,
      code: '',
      transfer_type: 'IN',
      transfer_amount: amount,
      checksum: '',
      status: TransactionStatus.PROCESSED,
      user_id: updatedUser._id,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      source: 'manual',
      note: note || `Admin nạp ${amount.toLocaleString('vi-VN')}đ cho ${updatedUser.email}`,
    });

    this.logger.log(`Deposit: +${amount.toLocaleString('vi-VN')}đ → ${updatedUser.email} (${balanceBefore} → ${balanceAfter})`);

    return {
      message: `Đã nạp ${amount.toLocaleString('vi-VN')}đ cho ${updatedUser.email}`,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    };
  }

  // ─── Admin: trừ tiền user ─────────────────────────────────────────────
  async deduct(userId: string, amount: number, note?: string) {
    if (!amount || amount <= 0) {
      throw new BadRequestException('Số tiền phải lớn hơn 0');
    }

    // Atomic: chỉ trừ nếu đủ tiền (money >= amount), trả về document SAU khi trừ
    const updatedUser = await this.userModel.findOneAndUpdate(
      { _id: userId, money: { $gte: amount } },
      { $inc: { money: -amount } },
      { new: true },
    ).select('_id email money').exec();

    if (!updatedUser) {
      // Kiểm tra user có tồn tại không để trả lỗi chính xác
      const exists = await this.userModel.findById(userId).select('money').exec();
      if (!exists) throw new BadRequestException('User không tồn tại');
      throw new BadRequestException(`Số dư không đủ (hiện có: ${Number(exists.money ?? 0).toLocaleString('vi-VN')}đ)`);
    }

    const balanceAfter = Number(updatedUser.money ?? 0);
    const balanceBefore = balanceAfter + amount;

    const txId = Date.now() + Math.floor(Math.random() * 1000);
    await this.txModel.create({
      transaction_id: txId,
      gateway: 'MANUAL',
      transaction_date: new Date(),
      transaction_number: '',
      account_number: '',
      content: note || `Admin trừ ${amount.toLocaleString('vi-VN')}đ từ ${updatedUser.email}`,
      code: '',
      transfer_type: 'OUT',
      transfer_amount: amount,
      checksum: '',
      status: TransactionStatus.PROCESSED,
      user_id: updatedUser._id,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      source: 'manual',
      note: note || `Admin trừ ${amount.toLocaleString('vi-VN')}đ từ ${updatedUser.email}`,
    });

    this.logger.log(`Deduct: -${amount.toLocaleString('vi-VN')}đ → ${updatedUser.email} (${balanceBefore} → ${balanceAfter})`);

    return {
      message: `Đã trừ ${amount.toLocaleString('vi-VN')}đ từ ${updatedUser.email}`,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    };
  }

  // ─── Admin: tạo/đổi mã nạp tiền ─────────────────────────────────────
  async generateTopupCode(userId: string) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new BadRequestException('Không tìm thấy người dùng');

    const topup_code = await this.generateUniqueTopupCode();
    user.topup_code = topup_code;
    await user.save();

    return { topup_code, message: 'Tạo mã nạp thành công' };
  }
}
