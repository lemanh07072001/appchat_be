import {
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
  Get,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { AuthGuard } from '../guards/auth.guard';
import { Public } from '../guards/public.decorator';

@Controller('auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    // Tạo user mới
    const user = await this.usersService.create(createUserDto);

    // Tự động login sau khi đăng ký thành công
    const tokens = await this.authService.login({
      email: user.email,
      id: user._id,
    });

    // Trả về thông tin user và tokens (không trả về password)
    return {
      message: 'User registered successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        email_verified_at: user.email_verified_at,
        last_login_at: user.last_login_at,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      ...tokens,
    };
  }

  @Public()
  @Post('login')
  login(@Request() req: any) {
    return this.authService.login(req.body);
  }

  @Get('profile')
  getProfile(@Request() req: any) {
    return req.user;
  }

  @Public()
  @Post('refresh')
  refresh(@Body('refresh_token') refresh_token: any) {
    console.log(refresh_token);
    return this.authService.refresh(refresh_token);
  }
}
