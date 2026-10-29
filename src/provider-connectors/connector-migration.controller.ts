import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ConnectorMigrationPreview } from './connector-migration-preview.service';
import { ConnectorCredentialMigration } from './connector-credential-migration.service';

@Controller('api/admin/provider-connectors/migration')
@UseGuards(AuthGuard, AdminGuard)
export class ConnectorMigrationController {
  constructor(private readonly migration: ConnectorMigrationPreview, private readonly credentials: ConnectorCredentialMigration) {}

  @Get(':partnerId/preview')
  preview(@Param('partnerId') partnerId: string) { return this.migration.preview(partnerId); }

  @Post(':partnerId/copy-credential')
  copyCredential(@Param('partnerId') partnerId: string,
    @Body() body: { connectorCode: string; connectorVersion: number; expectedOrigin: string }) {
    return this.credentials.copy(partnerId, body);
  }
}
