import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../schemas/users.schema';
import { UserStatusEnum } from '../enum/user.enum';

@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const auth = request.headers.authorization ?? '';
    const header = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;

    if (!header) throw new UnauthorizedException('API token không được cung cấp');

    const user = await this.userModel
      .findOne({ api_token: header })
      .select('_id email money status role')
      .exec();

    if (!user) throw new UnauthorizedException('API token không hợp lệ');
    if (user.status !== UserStatusEnum.ACTIVE) throw new UnauthorizedException('Tài khoản đã bị khoá');

    // Gắn user vào request giống AuthGuard (sub = userId)
    request['user'] = { sub: (user._id as any).toString(), email: user.email, role: user.role };

    return true;
  }
}
