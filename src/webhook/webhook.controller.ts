import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, Headers, UnauthorizedException } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { Public } from '../guards/public.decorator';

@Controller('api')
@UseGuards(AuthGuard)
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  // ─── User: dashboard ───────────────────────────────────────────────────
  @Get('dashboard')
  getDashboard(@Req() req: any) {
    return this.webhookService.getUserDashboard(req.user.sub);
  }

  // ─── User: lịch sử nạp tiền của chính mình ─────────────────────────────
  @Get('transactions')
  getUserTransactions(
    @Req() req: any,
    @Query('page')      page      = '1',
    @Query('limit')     limit     = '10',
    @Query('status')    status?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date')   to_date?: string,
  ) {
    return this.webhookService.getUserTransactions(
      req.user.sub,
      Number(page),
      Number(limit),
      status,
      from_date,
      to_date,
    );
  }

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

  // ─── Admin: dashboard ──────────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admin/dashboard')
  getAdminDashboard() {
    return this.webhookService.getAdminDashboard();
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
    @Query('page')      page      = '1',
    @Query('limit')     limit     = '10',
    @Query('status')    status?: string,
    @Query('source')    source?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date')   to_date?: string,
  ) {
    return this.webhookService.getList(Number(page), Number(limit), status, source, from_date, to_date);
  }

  // ─── Admin: duyệt giao dịch — cộng tiền ────────────────────────────────
  @UseGuards(AdminGuard)
  @Post('admin/transactions/:id/approve')
  approve(
    @Req() req: any,
    @Param('id') id: string,
    @Body('email') email?: string,
  ) {
    return this.webhookService.approveTransaction(id, email, req.user.sub);
  }

  // ─── Admin: huỷ giao dịch ─────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Post('admin/transactions/:id/reject')
  reject(
    @Param('id') id: string,
    @Body('note') note?: string,
  ) {
    return this.webhookService.rejectTransaction(id, note);
  }
}
