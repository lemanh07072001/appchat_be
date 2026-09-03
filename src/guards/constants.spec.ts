import { jwtConstants } from './constants';

/**
 * Bài học từ sự cố production: thiếu `JWT_SECRET` thì `login()` vẫn ký được
 * bằng secret dự phòng của JwtModule, còn AuthGuard verify thì hỏng — backend
 * cấp token rồi từ chối chính token đó, mọi request 401, không một dòng log
 * nào chỉ ra nguyên nhân.
 *
 * Nên hợp đồng ở đây là: THIẾU BIẾN PHẢI NÉM LỖI. Không dự phòng, không chuỗi
 * rỗng, không undefined lọt xuống dưới.
 */
describe('jwtConstants', () => {
  const goc = { ...process.env };

  afterEach(() => {
    process.env = { ...goc };
  });

  it.each([
    ['secret', 'JWT_SECRET'],
    ['refreshSecret', 'JWT_REFRESH_SECRET'],
  ])('%s ném lỗi nêu rõ tên biến khi thiếu %s', (prop, envName) => {
    delete process.env[envName];
    expect(() => jwtConstants[prop as 'secret' | 'refreshSecret']).toThrow(envName);
  });

  it.each([
    ['secret', 'JWT_SECRET'],
    ['refreshSecret', 'JWT_REFRESH_SECRET'],
  ])('%s coi chuỗi rỗng là thiếu, không trả về ""', (prop, envName) => {
    process.env[envName] = '';
    expect(() => jwtConstants[prop as 'secret' | 'refreshSecret']).toThrow(envName);
  });

  it('đọc lazily — đổi biến sau khi import vẫn có tác dụng', () => {
    // Đây là lý do dùng getter thay vì hằng số: .env được ConfigModule nạp
    // SAU khi module này được import.
    process.env.JWT_SECRET = 'secret-dat-sau-khi-import';
    expect(jwtConstants.secret).toBe('secret-dat-sau-khi-import');
  });

  it('access token và refresh token đọc hai biến KHÁC nhau', () => {
    // Dùng chung một secret thì access token bị lộ sẽ đổi được thành refresh
    // token — xem auth.service.spec.ts.
    process.env.JWT_SECRET = 'secret-access';
    process.env.JWT_REFRESH_SECRET = 'secret-refresh';
    expect(jwtConstants.secret).toBe('secret-access');
    expect(jwtConstants.refreshSecret).toBe('secret-refresh');
  });
});
