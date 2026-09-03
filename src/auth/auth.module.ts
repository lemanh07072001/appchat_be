import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from '../guards/constants';

@Module({
  imports: [
    UsersModule,
    AffiliateModule,
    PassportModule,
    // `registerAsync` chứ không phải `register`: factory chạy sau khi
    // ConfigModule đã nạp .env, nên đọc được biến môi trường. Thiếu JWT_SECRET
    // thì ném lỗi ngay lúc khởi động — chết ồn ào còn hơn chạy tiếp rồi cấp
    // token bằng một secret dự phòng mà không ai biết.
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtConstants.secret,
        signOptions: { expiresIn: '4M' },
      }),
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
})
export class AuthModule {}
