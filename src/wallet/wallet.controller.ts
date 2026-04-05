import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { WalletTransactionService } from './wallet-transaction.service';
import { WalletTxType } from '../schemas/wallet-transaction.schema';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';

@Controller()
@UseGuards(AuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletTransactionService) {}

  // ─── User: lịch sử ví của chính mình ──────────────────────────────────
  @Get('api/wallet/history')
  getMyHistory(
    @Req() req: Request,
    @Query('page')  page  = '1',
    @Query('limit') limit = '20',
    @Query('type')  type?: WalletTxType,
  ) {
    const userId = (req as any).user.sub as string;
    return this.walletService.findByUser(userId, Number(page), Number(limit), type);
  }

  // ─── Admin: lịch sử ví tất cả user ────────────────────────────────────
  @Get('api/admin/wallet/history')
  @UseGuards(AdminGuard)
  getAll(
    @Query('page')    page     = '1',
    @Query('limit')   limit    = '20',
    @Query('user_id') userId?: string,
    @Query('type')    type?: WalletTxType,
  ) {
    return this.walletService.findAll(Number(page), Number(limit), userId, type);
  }
}
