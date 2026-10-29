import { Body, Controller, Get, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ConnectorWorkflowsService } from './connector-workflows.service';
import { ConnectorAction } from './connector-definition';

@Controller('api/admin/connector-workflows')
@UseGuards(AuthGuard, AdminGuard)
export class ConnectorWorkflowsController {
  constructor(private readonly workflows: ConnectorWorkflowsService, private readonly config: ConfigService) {}

  @Post() start(@Body() body: { accountId: string; action: ConnectorAction; requestReference: string }) {
    if (this.config.get<string>('CONNECTOR_WORKFLOWS_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('Read-only connector workflows are not enabled');
    }
    return this.workflows.startReadOnly(body?.accountId, body?.action, body?.requestReference);
  }

  @Get(':id') inspect(@Param('id') id: string) { return this.workflows.inspect(id); }
}
