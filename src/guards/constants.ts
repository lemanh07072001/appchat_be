/**
 * Secret ký/verify JWT. Đọc lazily lúc truy cập để chắc chắn .env đã được
 * ConfigModule nạp vào process.env.
 *
 * KHÔNG có giá trị dự phòng, và đó là chủ ý. Trước đây `JwtModule.register()`
 * khai một secret placeholder chép từ tài liệu NestJS; khi production thiếu
 * `JWT_SECRET` thì `login()` vẫn ký được bằng chuỗi công khai đó, còn AuthGuard
 * verify thì ném lỗi — kết quả là cấp token rồi từ chối chính token vừa cấp,
 * mọi request trả 401, mà không có một dòng log nào chỉ ra nguyên nhân.
 * Thiếu biến thì phải chết ngay lúc khởi động, đừng chạy tiếp trong trạng thái
 * hỏng âm thầm.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} chưa được set — không thể ký/verify JWT. ` +
        `Thêm ${name} vào .env rồi khởi động lại.`,
    );
  }
  return value;
}

export const jwtConstants = {
  /** Secret của access token. */
  get secret(): string {
    return required('JWT_SECRET');
  },

  /** Secret của refresh token — PHẢI khác `secret`, xem auth.service.ts. */
  get refreshSecret(): string {
    return required('JWT_REFRESH_SECRET');
  },
};
