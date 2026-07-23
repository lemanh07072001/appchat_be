import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StatsService } from './stats.service';

/**
 * Thống kê daily_user_stats: chạy mỗi 5 phút + backfill ngay khi khởi động.
 * Recompute idempotent nên bỏ lỡ tick cũng tự sửa ở tick kế tiếp.
 */
@Injectable()
export class StatsScheduler implements OnModuleInit {
  private readonly logger = new Logger(StatsScheduler.name);
  private isRunning = false;

  constructor(private readonly statsService: StatsService) {}

  async onModuleInit(): Promise<void> {
    await this.run('startup backfill');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async cron(): Promise<void> {
    await this.run('cron 5m');
  }

  private async run(source: string): Promise<void> {
    if (this.isRunning) {
      this.logger.warn(`Skip (${source}) — previous run still in progress`);
      return;
    }
    this.isRunning = true;
    const t0 = Date.now();
    try {
      const rows = await this.statsService.recompute();
      this.logger.log(
        `[${source}] daily_user_stats done: ${rows} rows in ${Date.now() - t0}ms`,
      );
    } catch (err) {
      this.logger.error(`[${source}] daily_user_stats failed`, err as Error);
    } finally {
      this.isRunning = false;
    }
  }
}
