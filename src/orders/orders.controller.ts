import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OrdersService } from './orders.service';
import { OrdersExpirationScheduler } from './orders-expiration.scheduler';
import { OrderLogService } from './order-log.service';
import { CreateOrderDto } from '../dto/create-order.dto';
import { BuyOrderDto } from '../dto/buy-order.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { UserOrderQueryDto } from '../dto/user-order-query.dto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ApiTokenGuard } from '../guards/api-token.guard';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';

@Controller()
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly expirationScheduler: OrdersExpirationScheduler,
    private readonly orderLogService: OrderLogService,
  ) {}

  @Post('api/admin/orders/run-expiration')
  @UseGuards(AdminGuard)
  runExpiration() {
    return this.expirationScheduler.checkExpiredOrders();
  }

  // ─── User: mua dịch vụ (qua JWT) ─────────────────────────
  @Post('api/orders/buy')
  buy(@Req() req: Request, @Body() dto: BuyOrderDto) {
    const userId = (req as any).user.sub as string;
    return this.ordersService.buy(userId, dto);
  }

  // ─── User: mua dịch vụ (qua API token) ───────────────────
  @Post('api/orders/buy-external')
  @UseGuards(ApiTokenGuard)
  buyExternal(@Req() req: Request, @Body() dto: BuyOrderDto) {
    const userId = (req as any).user.sub as string;
    return this.ordersService.buy(userId, dto);
  }

  @Get('api/orders/my')
  findMyOrders(@Req() req: Request, @Query() query: UserOrderQueryDto) {
    const userId = (req as any).user.sub as string;
    return this.ordersService.findByUser(userId, query);
  }

  @Get('api/orders/my/:id')
  findMyOrderDetail(@Req() req: Request, @Param('id') id: string, @Query() query: PaginationQueryDto) {
    const userId = (req as any).user.sub as string;
    return this.ordersService.findOneByUser(userId, id, query);
  }

  // ─── Admin ────────────────────────────────────────────────
  @Get('api/admin/orders')
  @UseGuards(AdminGuard)
  findAll(@Query() query: PaginationQueryDto) {
    return this.ordersService.findAllPaginated(query);
  }

  @Get('api/admin/orders/:id')
  @UseGuards(AdminGuard)
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Post('api/admin/orders')
  @UseGuards(AdminGuard)
  create(@Body() dto: CreateOrderDto) {
    return this.ordersService.create(dto);
  }

  @Patch('api/admin/orders/:id/status')
  @UseGuards(AdminGuard)
  updateStatus(@Param('id') id: string, @Body('status') status: OrderStatusEnum) {
    return this.ordersService.updateStatus(id, status);
  }

  @Patch('api/admin/orders/:id/payment-status')
  @UseGuards(AdminGuard)
  updatePaymentStatus(@Param('id') id: string, @Body('payment_status') status: PaymentStatusEnum) {
    return this.ordersService.updatePaymentStatus(id, status);
  }

  @Post('api/admin/orders/:id/renew')
  @UseGuards(AdminGuard)
  renew(@Param('id') id: string) {
    return this.ordersService.renew(id);
  }

  @Post('api/admin/orders/:id/approve-refund')
  @UseGuards(AdminGuard)
  approveRefund(@Param('id') id: string) {
    return this.ordersService.approveRefund(id);
  }

  @Delete('api/admin/orders/:id')
  @UseGuards(AdminGuard)
  delete(@Param('id') id: string) {
    return this.ordersService.delete(id);
  }

  // ─── Order Logs ───────────────────────────────────────────
  @Get('api/admin/orders/:id/logs')
  @UseGuards(AdminGuard)
  getOrderLogs(@Param('id') id: string) {
    return this.orderLogService.findByOrder(id);
  }
}
