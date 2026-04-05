import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { Public } from '../guards/public.decorator';

@Controller('api')
@UseGuards(AuthGuard)
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}

  // ─── Public: danh sách thông báo đang hiển thị ──────────────────────
  @Public()
  @Get('announcements')
  getPublicList() {
    return this.service.findPublicList();
  }

  // ─── Admin: CRUD ────────────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admin/announcements')
  getList(
    @Query('page')   page   = '1',
    @Query('limit')  limit  = '10',
    @Query('search') search?: string,
    @Query('tag')    tag?: string,
  ) {
    return this.service.findAllPaginated(Number(page), Number(limit), search, tag);
  }

  @UseGuards(AdminGuard)
  @Get('admin/announcements/:id')
  getById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @UseGuards(AdminGuard)
  @Post('admin/announcements')
  create(@Body() body: any) {
    return this.service.create(body);
  }

  @UseGuards(AdminGuard)
  @Put('admin/announcements/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @UseGuards(AdminGuard)
  @Delete('admin/announcements/:id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }

  @UseGuards(AdminGuard)
  @Delete('admin/announcements')
  deleteMany(@Body('ids') ids: string[]) {
    return this.service.deleteMany(ids);
  }
}
