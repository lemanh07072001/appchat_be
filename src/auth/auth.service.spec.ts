import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

/**
 * Dùng JwtService THẬT, không mock: giá trị của bài test này nằm ở chỗ ký và
 * verify bằng secret thật. Mock đi thì chỉ còn kiểm tra rằng mock được gọi.
 *
 * Tính chất quan trọng nhất ở đây: access token và refresh token ký bằng hai
 * secret khác nhau, nên không được phép dùng thay cho nhau.
 */
describe('AuthService', () => {
  const ACCESS_SECRET = 'test-access-secret';
  const REFRESH_SECRET = 'test-refresh-secret';

  let service: AuthService;
  let jwt: JwtService;

  beforeEach(() => {
    process.env.JWT_SECRET = ACCESS_SECRET;
    process.env.JWT_REFRESH_SECRET = REFRESH_SECRET;

    jwt = new JwtService({});
    // login()/refresh() không chạm tới UsersService.
    service = new AuthService({} as any, jwt);
  });

  describe('refresh', () => {
    it('từ chối khi thiếu refresh token', async () => {
      await expect(service.refresh('')).rejects.toThrow(UnauthorizedException);
    });

    it('KHÔNG chấp nhận access token dùng thay refresh token', async () => {
      // Hai secret khác nhau chính là ranh giới đó. Nếu ai đó vô tình để cả hai
      // dùng chung một secret, access token bị lộ sẽ đẻ ra access token mới mãi.
      const accessToken = jwt.sign(
        { email: 'a@b.c', sub: 'u1', role: 'user' },
        { secret: ACCESS_SECRET, expiresIn: '1h' },
      );

      await expect(service.refresh(accessToken)).rejects.toThrow(UnauthorizedException);
    });

    it('từ chối refresh token đã hết hạn', async () => {
      const expired = jwt.sign(
        { email: 'a@b.c', sub: 'u1', role: 'user' },
        { secret: REFRESH_SECRET, expiresIn: '-1s' },
      );

      await expect(service.refresh(expired)).rejects.toThrow(UnauthorizedException);
    });

    it('từ chối token ký bằng secret bịa', async () => {
      const forged = jwt.sign(
        { email: 'a@b.c', sub: 'u1', role: 'admin' },
        { secret: 'secret-cua-ke-tan-cong', expiresIn: '1h' },
      );

      await expect(service.refresh(forged)).rejects.toThrow(UnauthorizedException);
    });

    it('cấp access token mới giữ nguyên sub và role', async () => {
      const refreshToken = jwt.sign(
        { email: 'a@b.c', sub: 'u1', role: 'admin' },
        { secret: REFRESH_SECRET, expiresIn: '1h' },
      );

      const { access_token } = await service.refresh(refreshToken);

      // Verify bằng ACCESS secret — token mới phải dùng được cho API thường.
      const payload = jwt.verify(access_token, { secret: ACCESS_SECRET }) as any;
      expect(payload.sub).toBe('u1');
      expect(payload.role).toBe('admin');
      expect(payload.email).toBe('a@b.c');
    });

    it('access token mới KHÔNG dùng lại được làm refresh token', async () => {
      const refreshToken = jwt.sign(
        { email: 'a@b.c', sub: 'u1', role: 'user' },
        { secret: REFRESH_SECRET, expiresIn: '1h' },
      );

      const { access_token } = await service.refresh(refreshToken);

      await expect(service.refresh(access_token)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('login', () => {
    it('không trả mật khẩu ra ngoài', async () => {
      const res = await service.login({
        id: 'u1',
        email: 'a@b.c',
        name: 'A',
        role: 'user',
        money: 1000,
        password: '$2b$10$hash-that-must-never-leave-the-server',
      });

      expect(res.user).not.toHaveProperty('password');
      // Chặn cả trường hợp hash lọt vào chỗ khác trong payload trả về.
      expect(JSON.stringify(res)).not.toContain('hash-that-must-never-leave-the-server');
    });

    it('access token và refresh token ký bằng hai secret khác nhau', async () => {
      const res = await service.login({ id: 'u1', email: 'a@b.c', role: 'user' });

      expect(() => jwt.verify(res.access_token, { secret: ACCESS_SECRET })).not.toThrow();
      expect(() => jwt.verify(res.refresh_token, { secret: REFRESH_SECRET })).not.toThrow();
      // Đổi chéo phải hỏng — đó chính là ranh giới bảo vệ.
      expect(() => jwt.verify(res.access_token, { secret: REFRESH_SECRET })).toThrow();
    });
  });
});
