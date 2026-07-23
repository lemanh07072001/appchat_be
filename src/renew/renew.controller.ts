import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../guards/auth.guard';
import { RenewService } from './renew.service';
import { BulkRenewDto } from './dto/bulk-renew.dto';
import { CreateSelectionDto } from './dto/create-selection.dto';
import { UpdateSelectionDto } from './dto/update-selection.dto';
import { LookupProxiesDto } from './dto/lookup-proxies.dto';

/**
 * Gia hạn proxy hàng loạt (user tự thao tác) — trang /renew bên FE.
 * Prefix riêng `api/renew` để không đụng route `api/orders/my/:id`.
 */
@Controller('api/renew')
@UseGuards(AuthGuard)
export class RenewController {
  constructor(private readonly renewService: RenewService) {}

  /** Tra cứu proxy theo danh sách ip:port:user:pass user dán/upload */
  @Post('lookup')
  lookupProxies(@Req() req: Request, @Body() dto: LookupProxiesDto) {
    const userId = (req as any).user.sub as string;
    return this.renewService.lookupProxies(userId, dto.lines);
  }

  /** Danh sách đơn ACTIVE + proxy, kèm cờ eligible/lý do */
  @Get('orders')
  getRenewableOrders(@Req() req: Request) {
    const userId = (req as any).user.sub as string;
    return this.renewService.getRenewableOrders(userId);
  }

  /** Gia hạn các proxy đã chọn (có thể trải trên nhiều đơn) */
  @Post('bulk')
  bulkRenew(@Req() req: Request, @Body() dto: BulkRenewDto) {
    const userId = (req as any).user.sub as string;
    return this.renewService.bulkRenew(userId, dto.proxy_ids, dto.duration_days);
  }

  /** Bộ lựa chọn đã lưu: { last, presets[] } */
  @Get('selections')
  getSelections(@Req() req: Request) {
    const userId = (req as any).user.sub as string;
    return this.renewService.getSelections(userId);
  }

  @Post('selections')
  createSelection(@Req() req: Request, @Body() dto: CreateSelectionDto) {
    const userId = (req as any).user.sub as string;
    return this.renewService.createSelection(userId, dto);
  }

  @Put('selections/:id')
  updateSelection(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateSelectionDto,
  ) {
    const userId = (req as any).user.sub as string;
    return this.renewService.updateSelection(userId, id, dto);
  }

  @Delete('selections/:id')
  deleteSelection(@Req() req: Request, @Param('id') id: string) {
    const userId = (req as any).user.sub as string;
    return this.renewService.deleteSelection(userId, id);
  }
}
