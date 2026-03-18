import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { BlogService } from './blog.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { Public } from '../guards/public.decorator';

@Controller('api')
export class BlogController {
  constructor(private blogService: BlogService) {}

  // Public endpoints
  @Public()
  @Get('blog')
  getPublished(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('tag') tag?: string,
  ) {
    return this.blogService.getPublished(
      Number(page) || 1,
      Number(limit) || 12,
      tag,
    );
  }

  @Public()
  @Get('blog/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.blogService.getBySlug(slug);
  }

  // Admin endpoints
  @UseGuards(AuthGuard, AdminGuard)
  @Get('admin/blog')
  adminList(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.blogService.adminList(
      Number(page) || 1,
      Number(limit) || 20,
      search,
      status,
    );
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Get('admin/blog/:id')
  adminGetById(@Param('id') id: string) {
    return this.blogService.adminGetById(id);
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Post('admin/blog')
  create(@Body() body: any) {
    return this.blogService.create(body);
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Put('admin/blog/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.blogService.update(id, body);
  }

  @UseGuards(AuthGuard, AdminGuard)
  @Delete('admin/blog/:id')
  delete(@Param('id') id: string) {
    return this.blogService.delete(id);
  }
}
