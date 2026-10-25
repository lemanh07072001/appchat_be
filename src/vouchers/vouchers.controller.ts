import { Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { VouchersService } from './vouchers.service';

@Controller('api')
@UseGuards(AuthGuard, AdminGuard)
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}
  @Get('admin/vouchers') list(@Query() q: any) { return this.vouchers.list(q); }
  @Post('admin/vouchers') create(@Body() b: any, @Req() r: any) { return this.vouchers.write(b, r.user.sub); }
  @Put('admin/vouchers/:id') update(@Param('id') id: string, @Body() b: any, @Req() r: any) { return this.vouchers.write(b, r.user.sub, id); }
  @Get('admin/vouchers/stats') stats() { return this.vouchers.stats(); }
  @Get('admin/vouchers/usages') usages(@Query() q: any) { return this.vouchers.usages(q); }
  @Get('admin/vouchers/audit') audit(@Query() q: any) { return this.vouchers.audit(q); }
  @Get('admin/vouchers/export') async export(@Query() q: any, @Res() res: Response) {
    const csv = await this.vouchers.export(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="voucher-usages.csv"');
    res.send('\ufeff' + csv);
  }
  @Get('vouchers/products') products(@Query('search') search?: string) { return this.vouchers.products(search); }
  @Post('admin/vouchers/orders/:id/confirm-failure') confirmFailure(@Param('id') id: string, @Body('evidence') evidence: string, @Req() r: any) {
    return this.vouchers.confirmFailure(id, r.user.sub, evidence);
  }
}
