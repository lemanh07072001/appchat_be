import { Controller, Post, Get, Body, Query, UseGuards, Headers, UnauthorizedException } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { AdminGuard } from '../guards/admin.guard';
import { Public } from '../guards/public.decorator';

@Controller('api')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  // ─── Pays2 gọi vào đây khi có giao dịch ─────────────────────────────────
  @Public()
  @Post('webhook/pays2')
  handlePays2(
    @Headers('authorization') authorization: string,
    @Body() body: { transactions: any[] },
  ) {
    const token = process.env.PAYS2_WEBHOOK_TOKEN;
    if (token) {
      const bearer = (authorization ?? '').replace('Bearer ', '').trim();
      if (bearer !== token) throw new UnauthorizedException('Invalid webhook token');
    }
    return this.webhookService.handlePays2(body);
  }

  // ─── Admin: thống kê tổng quan ───────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admin/transactions/stats')
  getStats() {
    return this.webhookService.getStats();
  }

  // ─── Admin: danh sách giao dịch ──────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admin/transactions')
  getList(
    @Query('page')   page   = '1',
    @Query('limit')  limit  = '20',
    @Query('status') status?: string,
  ) {
    return this.webhookService.getList(Number(page), Number(limit), status);
  }
}
