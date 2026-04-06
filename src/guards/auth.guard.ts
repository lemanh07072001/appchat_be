import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { jwtConstants } from './constants';
import { IS_PUBLIC_KEY } from './public.decorator';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException({ code: 'NO_TOKEN', message: 'No token provided' });
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: jwtConstants.secret,
      });
      request['user'] = payload;
    } catch (err: any) {
      // JwtService throws TokenExpiredError khi hết hạn
      const isExpired = err?.name === 'TokenExpiredError' || err?.message?.includes('expired');
      throw new UnauthorizedException({
        code: isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: isExpired ? 'Token đã hết hạn' : 'Token không hợp lệ',
      });
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

// ─── Refresh token (logic cũ — giữ lại, tạm không dùng) ─────────────────────
// async refresh(refresh_token: string) {
//   if (!refresh_token) throw new UnauthorizedException('Missing refresh token');
//   try {
//     const payload = await this.jwtService.verifyAsync(refresh_token, {
//       secret: process.env.JWT_REFRESH_SECRET,
//     });
//     const newAccessToken = this.jwtService.sign(
//       { email: payload.email, sub: payload.sub, role: payload.role },
//       { secret: process.env.JWT_SECRET, expiresIn: '15m' },
//     );
//     return { access_token: newAccessToken };
//   } catch (error) {
//     throw new UnauthorizedException('Invalid or expired refresh token');
//   }
// }
