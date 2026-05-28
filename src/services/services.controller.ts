import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ServicesService } from './services.service';
import { CreateServiceDto } from '../dto/create-service.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { AuthGuard } from '../guards/auth.guard';
import { Public } from '../guards/public.decorator';
import { ApiTokenGuard } from '../guards/api-token.guard';
import { jwtConstants } from '../guards/constants';

@Controller()
@UseGuards(AuthGuard)
export class ServicesController {
  constructor(
    private readonly servicesService: ServicesService,
    private readonly jwtService: JwtService,
  ) {}

  /** Soft-parse JWT từ Authorization header — không throw nếu thiếu/invalid. */
  private async resolveUserId(req: Request): Promise<string | null> {
    const [type, token] = req.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) return null;
    try {
      const payload = await this.jwtService.verifyAsync(token, { secret: jwtConstants.secret });
      return (payload?.sub as string) ?? null;
    } catch {
      return null;
    }
  }

  @Public()
  @UseGuards(ApiTokenGuard)
  @Get('api/services/api-list')
  async findApiEnabledList(@Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?._id ?? null;
    return this.servicesService.findApiEnabledList(userId);
  }

  @Public()
  @Get('api/services')
  async findPublicList(
    @Req() req: Request,
    @Query('category') category?: 'static' | 'rotating',
    @Query('usage_type') usage_type?: string,
    @Query('ip_version') ip_version?: string,
  ) {
    const userId = await this.resolveUserId(req);
    return this.servicesService.findPublicList(category, usage_type, ip_version, userId);
  }

  @Get('api/admin/services')
  findAll(@Query() query: PaginationQueryDto) {
    return this.servicesService.findAllPaginated(query);
  }

  @Post('api/admin/services')
  create(@Body() createServiceDto: CreateServiceDto) {
    return this.servicesService.create(createServiceDto);
  }

  @Put('api/admin/services/:id')
  update(@Param('id') id: string, @Body() updateServiceDto: CreateServiceDto) {
    return this.servicesService.update(id, updateServiceDto);
  }

  @Patch('api/admin/services/:id/status')
  toggleStatus(@Param('id') id: string, @Body('status') status: boolean) {
    return this.servicesService.toggleStatus(id, status);
  }

  @Post('api/admin/services/:id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.servicesService.duplicate(id);
  }

  @Delete('api/admin/services/:id')
  delete(@Param('id') id: string) {
    return this.servicesService.delete(id);
  }

  @Delete('api/admin/services')
  deleteMany(@Body('ids') ids: string[]) {
    return this.servicesService.deleteMany(ids);
  }
}
