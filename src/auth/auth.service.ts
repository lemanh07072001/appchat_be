import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  validateUser(email: string, password: string) {
    return this.usersService.validateUser(email, password);
  }

  async login(user: any) {
    const payload = { email: user.email, sub: user.id, role: user.role };

    // 1️⃣ Access token (1 phút)
    const access_token = this.jwtService.sign(payload, {
      expiresIn: '1m',
      secret: process.env.JWT_SECRET,
    });

    // 2️⃣ Refresh token (1 phút — giữ nguyên, không dùng tạm thời)
    const refresh_token = this.jwtService.sign(payload, {
      expiresIn: '1m',
      secret: process.env.JWT_REFRESH_SECRET,
    });

    // 3️⃣ Trả về cho client
    return {
      user: {
        id: user.id ?? user._id,
        email: user.email,
        name: user.name,
        money: user.money ?? 0,
        role: user.role,
        country: user.country ?? '',
        topup_code: user.topup_code ?? '',
      },
      access_token,
      refresh_token,
      token_type: 'bearer',
    };
  }
  async refresh(refresh_token: string) {
    if (!refresh_token)
      throw new UnauthorizedException('Missing refresh token');

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const payload = await this.jwtService.verifyAsync(refresh_token, {
        secret: process.env.JWT_REFRESH_SECRET,
      });

      // 🔄 Tạo access token mới
      const newAccessToken = this.jwtService.sign(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { email: payload.email, sub: payload.sub, role: payload.role },
        { secret: process.env.JWT_SECRET, expiresIn: '1m' },
      );

      return { access_token: newAccessToken };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}
