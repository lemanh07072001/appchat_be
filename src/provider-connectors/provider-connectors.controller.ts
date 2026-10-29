import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorImport } from './connector-import.service';

@Controller('api/admin/provider-connectors')
@UseGuards(AuthGuard, AdminGuard)
export class ProviderConnectorsController {
  constructor(private readonly connectors: ProviderConnectorsService, private readonly importer: ConnectorImport) {}
  @Post('import-preview') preview(@Body() body: { document?: unknown; baseUrl?: string }) {
    return this.importer.preview(body?.document, body?.baseUrl);
  }
  @Get() list() { return this.connectors.list(); }
  @Post('output-preview') outputPreview(@Body() body: Parameters<ProviderConnectorsService['previewOutput']>[0]) {
    return this.connectors.previewOutput(body);
  }
  @Post('templates/import') importTemplate(@Body() body: unknown) { return this.connectors.importTemplate(body); }
  @Get(':code/:version/readiness') readiness(@Param('code') code: string, @Param('version', ParseIntPipe) version: number) {
    return this.connectors.readiness(code, version);
  }
  @Get(':code/:version/template') exportTemplate(@Param('code') code: string, @Param('version', ParseIntPipe) version: number) {
    return this.connectors.exportTemplate(code, version);
  }
  @Get('legacy-templates') legacyTemplates() { return this.connectors.legacyTemplates(); }
  @Post('import-legacy-drafts') importLegacyDrafts() { return this.connectors.importLegacyDrafts(); }
  @Get(':code/:version') get(@Param('code') code: string, @Param('version', ParseIntPipe) version: number) {
    return this.connectors.get(code, version);
  }
  @Post() create(@Body() body: Parameters<ProviderConnectorsService['create']>[0]) {
    return this.connectors.create(body);
  }
  @Put(':code/:version') update(@Param('code') code: string, @Param('version', ParseIntPipe) version: number,
    @Body() body: Parameters<ProviderConnectorsService['update']>[2]) {
    return this.connectors.update(code, version, body);
  }
  @Post(':code/:version/publish') publish(@Param('code') code: string, @Param('version', ParseIntPipe) version: number,
    @Body('revision') revision: number) {
    return this.connectors.publish(code, version, revision);
  }
  @Post(':code/:version/fork') fork(@Param('code') code: string, @Param('version', ParseIntPipe) version: number,
    @Body() body: { revision: number; targetVersion: number }) {
    return this.connectors.fork(code, version, body);
  }
}
