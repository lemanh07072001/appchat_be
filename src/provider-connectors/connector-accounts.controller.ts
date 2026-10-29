import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Types } from 'mongoose';
import { ConnectorCheckLock } from './connector-check-lock.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ConnectorAccountsService } from './connector-accounts.service';
import { ConnectorRuntime } from './connector-runtime.service';
import { ConnectorServiceBinding } from './connector-service-binding.service';
import { ConnectorAccountReadiness } from './connector-account-readiness.service';

@Controller('api/admin/connector-accounts')
@UseGuards(AuthGuard, AdminGuard)
export class ConnectorAccountsController {
  constructor(private readonly accounts: ConnectorAccountsService, private readonly checkLock: ConnectorCheckLock,
    private readonly runtime: ConnectorRuntime, private readonly bindings: ConnectorServiceBinding,
    private readonly readiness: ConnectorAccountReadiness) {}
  @Get(':id/readiness') readinessInfo(@Param('id') id: string) { return this.readiness.inspect(id); }
  @Get() list() { return this.accounts.list(); }
  @Post() create(@Body() body: Parameters<ConnectorAccountsService['create']>[0]) { return this.accounts.create(body); }
  @Put(':id') update(@Param('id') id: string, @Body() body: Parameters<ConnectorAccountsService['update']>[1]) {
    return this.accounts.update(id, body);
  }
  @Post(':id/check') check(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid account ID');
    return this.checkLock.run(id, () => this.accounts.check(id));
  }
  @Post(':id/upgrade') upgrade(@Param('id') id: string, @Body() body: { revision: number; targetVersion: number }) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid account ID');
    return this.checkLock.run(id, () => this.accounts.upgrade(id, body));
  }
  @Post(':id/catalog') catalog(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid account ID');
    return this.checkLock.run(id, () => this.runtime.catalog(id));
  }
  @Post(':id/services/:serviceId') bindService(@Param('id') id: string, @Param('serviceId') serviceId: string,
    @Body() body: Parameters<ConnectorServiceBinding['bind']>[2]) {
    return this.checkLock.run(id, () => this.bindings.bind(id, serviceId, body));
  }
}
