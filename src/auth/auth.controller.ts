import {
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
  Get,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { LoginUserDto } from '../dto/login-user.dto';
import { AuthGuard } from '../guards/auth.guard';
import { Public } from '../guards/public.decorator';

@Controller('api/auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly affiliateService: AffiliateService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() createUserDto: CreateUserDto) {
    // Tạo user mới
    const user = await this.usersService.create(createUserDto);

    // Tự động tạo referral_code + gán referred_by nếu có ref
    console.log('[register] ref received:', createUserDto.ref);
    await this.affiliateService.initNewUser(user._id.toString(), createUserDto.ref);

    // Tự động login sau khi đăng ký thành công
    const { user: userInfo, ...tokens } = await this.authService.login(user);

    // Trả về thông tin user và tokens (không trả về password)
    return {
      message: 'User registered successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        money: user.money,
        country: user.country,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        topup_code: user.topup_code,
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
  async login(@Body() loginUserDto: LoginUserDto) {
    const user = await this.authService.validateUser(
      loginUserDto.email,
      loginUserDto.password,
    );
    if (!user) {
      throw new UnauthorizedException('Email or password is incorrect');
    }
    return this.authService.login(user);
  }

  @Get('profile')
  async getProfile(@Request() req: any) {
    const user = await this.usersService.fineByEmail(req.user.email);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return {
      email: user.email,
      name: user.name,
      money: user.money ?? 0,
      role: user.role,
      country: user.country ?? '',
      topup_code: user.topup_code ?? '',
    };
  }

  @Public()
  @Post('refresh')
  refresh(@Body('refresh_token') refresh_token: any) {
    console.log(refresh_token);
    return this.authService.refresh(refresh_token);
  }
}
