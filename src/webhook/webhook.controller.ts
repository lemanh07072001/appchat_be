import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, Headers, UnauthorizedException, Request } from '@nestjs/common';
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
  async handlePays2(
    @Headers('authorization') authorization: string,
    @Req() req: any,
    @Body() body: { transactions: any[] },
  ) {
    const token = process.env.PAYS2_WEBHOOK_TOKEN;

    // Token chưa cấu hình — lưu log lỗi rồi mới throw
    if (!token) {
      await this.webhookService.saveErrorLog(body, req.headers, req.ip, 'Webhook token not configured');
      throw new UnauthorizedException('Webhook token not configured');
    }

    const bearer = (authorization ?? '').replace('Bearer ', '').trim();

    // Token sai — lưu log lỗi rồi mới throw
    if (bearer !== token) {
      await this.webhookService.saveErrorLog(body, req.headers, req.ip, 'Invalid webhook token');
      throw new UnauthorizedException('Invalid webhook token');
    }

    return this.webhookService.handlePays2(body, req.headers, req.ip);
  }

  // ─── SePay gọi vào đây khi có giao dịch ───────────────────────────────
  // Auth: header "Authorization: Apikey XXX"
  @Public()
  @Post('webhook/sepay')
  async handleSepay(
    @Headers('authorization') authorization: string,
    @Req() req: any,
    @Body() body: any,
  ) {
    const apiKey = process.env.SEPAY_WEBHOOK_API_KEY;

    if (!apiKey) {
      await this.webhookService.saveErrorLog(body, req.headers, req.ip, 'SePay API key not configured', 'sepay');
      throw new UnauthorizedException('SePay API key not configured');
    }

    // SePay gửi "Apikey XXX" hoặc "Bearer XXX"
    const raw = (authorization ?? '').trim();
    const provided = raw.replace(/^Apikey\s+/i, '').replace(/^Bearer\s+/i, '').trim();

    if (provided !== apiKey) {
      await this.webhookService.saveErrorLog(body, req.headers, req.ip, 'Invalid SePay API key', 'sepay');
      throw new UnauthorizedException('Invalid SePay API key');
    }

    return this.webhookService.handleSepay(body, req.headers, req.ip);
  }

  // ─── Admin: webhook steps theo transaction ──────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admin/transactions/:id/webhook-steps')
  getTransactionWebhookSteps(@Param('id') id: string) {
    return this.webhookService.getStepsByTransactionId(id);
  }

  // ─── Admin: danh sách webhook log ────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admin/webhooks')
  getWebhookLogs(
    @Query('page')      page      = '1',
    @Query('limit')     limit     = '10',
    @Query('from_date') from_date?: string,
    @Query('to_date')   to_date?: string,
  ) {
    return this.webhookService.getWebhookLogs(Number(page), Number(limit), from_date, to_date);
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
    @Query('gateway')   gateway?: string,
    @Query('content')   content?: string,
  ) {
    return this.webhookService.getList(Number(page), Number(limit), status, source, from_date, to_date, gateway, content);
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
