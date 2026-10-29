import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectorWorkflowsService } from './connector-workflows.service';

@Injectable()
export class ConnectorWorkflowsWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly workflows: ConnectorWorkflowsService, private readonly config: ConfigService) {}
  onModuleInit() {
    // Explicit opt-in, and registered only in the standalone worker module.
    if (this.config.get<string>('CONNECTOR_WORKFLOWS_ENABLED') === 'true') this.schedule();
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.process(); }, 1000);
  }
  private async process() {
    try { await this.workflows.processDue(); }
    catch { /* Database may be temporarily unavailable. No work is replayed here. */ }
    finally { this.schedule(); }
  }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}
