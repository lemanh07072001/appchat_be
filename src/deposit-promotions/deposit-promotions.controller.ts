import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { Transaction, TransactionStatus } from '../schemas/transactions.schema';
import { DepositPromotionsService } from './deposit-promotions.service';

@Controller('api/deposit-promotions')
@UseGuards(AuthGuard)
export class DepositPromotionsController {
  constructor(private readonly promotions: DepositPromotionsService) {}
  @Get('quote') quote(@Query('amount') amount: string) { return this.promotions.quote(Number(amount)); }
  @Post('intents') intent(@Req() req: any, @Body() body: any) { return this.promotions.createIntent(req.user.sub, body?.amount); }
}

@Controller('api/admin/deposit-promotions')
@UseGuards(AuthGuard, AdminGuard)
export class AdminDepositPromotionsController {
  constructor(
    private readonly promotions: DepositPromotionsService,
    @InjectModel(Transaction.name) private readonly transactions: Model<Transaction>,
  ) {}
  @Get() list() { return this.promotions.list(); }
  @Get('stats') async stats() {
    const [metrics] = await this.transactions.aggregate([
      { $match: { status: TransactionStatus.PROCESSED, 'promotion_snapshot.promotionId': { $type: 'string' } } },
      { $group: { _id: null, receipts: { $sum: 1 }, depositAmount: { $sum: '$promotion_snapshot.amount' }, bonusAmount: { $sum: '$promotion_snapshot.bonusAmount' }, totalAmount: { $sum: '$promotion_snapshot.totalAmount' } } },
      { $project: { _id: 0 } },
    ]).exec();
    return metrics ?? { receipts: 0, depositAmount: 0, bonusAmount: 0, totalAmount: 0 };
  }
  @Post() create(@Body() body: any) { return this.promotions.save(body); }
  @Put(':id') update(@Param('id') id: string, @Body() body: any) { return this.promotions.save(body, id); }
  @Delete(':id') remove(@Param('id') id: string) { return this.promotions.remove(id); }
}
