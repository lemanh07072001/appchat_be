import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../guards/auth.guard';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { AffiliateService } from './affiliate.service';

@Controller('api/affiliate')
@UseGuards(AuthGuard)
export class AffiliateController {
  constructor(private readonly affiliateService: AffiliateService) {}

  @Get('get-link')
  getMyLink(@Req() req: Request) {
    const userId = (req as any).user.sub as string;
    return this.affiliateService.getMyLink(userId);
  }

  @Get('stats')
  getStats(@Req() req: Request) {
    const userId = (req as any).user.sub as string;
    return this.affiliateService.getStats(userId);
  }

  @Get('commissions')
  getCommissions(@Req() req: Request, @Query() query: PaginationQueryDto & { status?: string }) {
    const userId = (req as any).user.sub as string;
    return this.affiliateService.getCommissions(userId, query);
  }

  // Cập nhật thông tin ngân hàng
  @Patch('bank-info')
  updateBankInfo(
    @Req() req: Request,
    @Body() body: { bank_name: string; bank_account: string; bank_owner: string },
  ) {
    const userId = (req as any).user.sub as string;
    return this.affiliateService.updateBankInfo(userId, body);
  }

  // Danh sách yêu cầu rút tiền của user (requested + paid)
  @Get('withdrawals')
  getMyWithdrawals(@Req() req: Request, @Query() query: PaginationQueryDto) {
    const userId = (req as any).user.sub as string;
    return this.affiliateService.getMyWithdrawals(userId, query);
  }

  // User gửi yêu cầu rút về ngân hàng (từng commission)
  @Post('withdraw/:commissionId')
  requestWithdraw(@Req() req: Request, @Param('commissionId') commissionId: string) {
    const userId = (req as any).user.sub as string;
    return this.affiliateService.requestWithdraw(userId, commissionId);
  }

  // User rút toàn bộ số dư về ngân hàng (body optional — chỉ cần lần đầu)
  @Post('withdraw-all')
  requestWithdrawAll(
    @Req() req: Request,
    @Body() body?: { bank_name?: string; bank_account?: string; bank_owner?: string },
  ) {
    const userId = (req as any).user.sub as string;
    return this.affiliateService.requestWithdrawAll(userId, body);
  }
}
