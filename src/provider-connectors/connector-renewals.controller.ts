import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ResolveConnectorRenewalDto } from '../dto/resolve-connector-renewal.dto';
import { ConnectorRenewalReconciliation } from './connector-renewal-reconciliation.service';

@Controller('api/admin/connector-renewals')
@UseGuards(AuthGuard, AdminGuard)
export class ConnectorRenewalsController {
  constructor(private readonly reconciliation: ConnectorRenewalReconciliation) {}

  /** Những lượt gia hạn đang treo chờ đối soát. */
  @Get()
  pending() {
    return this.reconciliation.pending();
  }

  @Post(':orderId/resolve')
  resolve(@Param('orderId') orderId: string, @Body() dto: ResolveConnectorRenewalDto, @Req() req?: Request) {
    const actor = (req as { user?: { sub?: string } } | undefined)?.user?.sub ?? 'admin';
    return this.reconciliation.resolve(orderId, { outcome: dto.outcome, evidence: dto.evidence, actor });
  }
}
