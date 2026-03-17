import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { AffiliateService } from './affiliate.service';
import { PaginationQueryDto } from '../dto/pagination-query.dto';

@Controller('api/admin/affiliate')
@UseGuards(AuthGuard, AdminGuard)
export class AffiliateAdminController {
  constructor(private readonly affiliateService: AffiliateService) {}

  // ─── Config ────────────────────────────────────────────────────────────────

  @Get('config')
  getConfig() {
    return this.affiliateService.getConfig();
  }
   

  
  @Patch('config')
  updateConfig(@Body() body: { commission_rate?: number; is_active?: boolean }) {
    return this.affiliateService.updateConfig(body);
  }

  // ─── Danh sách tất cả giao dịch rút (filter status nếu cần) ───────────────

  @Get('withdraw-requests')
  getWithdrawRequests(@Query() query: PaginationQueryDto & { status?: string }) {
    return this.affiliateService.getWithdrawRequests(query);
  }

  // ─── Duyệt / từ chối yêu cầu rút ──────────────────────────────────────────

  @Post('approve/:withdrawalId')
  approveWithdraw(@Param('withdrawalId') withdrawalId: string) {
    return this.affiliateService.approveWithdraw(withdrawalId);
  }

  @Post('reject/:withdrawalId')
  rejectWithdraw(@Param('withdrawalId') withdrawalId: string) {
    return this.affiliateService.rejectWithdraw(withdrawalId);
  }

  @Patch('withdraw-requests/:id')
  updateWithdrawal(
    @Param('id') id: string,
    @Body('action') action: 'approve' | 'reject',
  ) {
    if (action === 'approve') return this.affiliateService.approveWithdraw(id);
    if (action === 'reject')  return this.affiliateService.rejectWithdraw(id);
    throw new BadRequestException('action phải là approve hoặc reject');
  }

  // ─── Duyệt commission CONFIRMED → CREDITED + cộng affiliate_balance ──────────

  @Post('credit/:commissionId')
  creditCommission(@Param('commissionId') commissionId: string) {
    return this.affiliateService.creditCommission(commissionId);
  }

  // ─── Thống kê affiliate của 1 user ─────────────────────────────────────────

  @Get('stats/:userId')
  getUserStats(@Param('userId') userId: string) {
    return this.affiliateService.getStats(userId);
  }

  // ─── Danh sách tất cả commission (có filter theo status) ──────────────────

  @Get('commissions')
  getAllCommissions(@Query() query: PaginationQueryDto & { status?: string }) {
    return this.affiliateService.getAllCommissions(query);
  }

  // ─── Danh sách commission của 1 user ───────────────────────────────────────

  @Get('commissions/:userId')
  getUserCommissions(@Param('userId') userId: string, @Query() query: PaginationQueryDto) {
    return this.affiliateService.getCommissions(userId, query);
  }
}
