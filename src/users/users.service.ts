import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { User, UserDocument } from '../schemas/users.schema';
import { Model } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { CreateUserDto } from '../dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
  ) {}

  async findAll() {
    return await this.userModel.find().exec();
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

  private async generateTopupCode(): Promise<string> {
    let code: string;
    let exists: boolean;
    do {
      code = 'NAP' + crypto.randomBytes(4).toString('hex').toUpperCase(); // VD: NAP3F9A2C1D
      exists = !!(await this.userModel.findOne({ topup_code: code }).exec());
    } while (exists);
    return code;
  }

  async create(data: CreateUserDto): Promise<UserDocument> {
    const existingUser = await this.fineByEmail(data.email);

    // 🔹 Kiểm tra Email có trong cơ sở dữ liệu không?
    if (existingUser) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: {
          email: 'Email already exists',
        },
      });
    }

    // 🔹 Hash mật khẩu trước khi lưu
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(data.password, salt);

    const topup_code = await this.generateTopupCode();

    const user = new this.userModel({
      ...data,
      password: hashedPassword,
      topup_code,
    });
    return user.save();
  }
}
