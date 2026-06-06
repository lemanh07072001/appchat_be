export const jwtConstants = {
  // Đọc lazily lúc truy cập để chắc chắn .env đã được ConfigModule nạp vào process.env.
  // PHẢI khớp với secret dùng để ký access_token ở auth.service.ts (process.env.JWT_SECRET).
  get secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) {
      throw new Error('JWT_SECRET is not set — không thể verify token');
    }
    return s;
  },
};
