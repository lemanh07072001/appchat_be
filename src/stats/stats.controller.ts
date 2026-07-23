import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { StatsService } from './stats.service';

@Controller('api/admin/stats')
@UseGuards(AuthGuard, AdminGuard)
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /**
   * GET /api/admin/stats/daily?page=&limit=&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD&user_id=
   * Thống kê theo (ngày, user_id) từ bảng daily_user_stats.
   */
  @Get('daily')
  getDaily(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('user_id') user_id?: string,
  ) {
    return this.statsService.getDaily({
      page,
      limit,
      from_date,
      to_date,
      user_id,
    });
  }
}
