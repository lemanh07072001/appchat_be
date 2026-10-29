import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorAccount } from './connector-account.schema';
import { PersistedWorkflowRun } from './workflow-run.schema';
import { ConnectorSecrets } from './connector-secrets.service';
import { ConnectorHttp } from './connector-http.service';
import { MongoWorkflowStore } from './mongo-workflow.store';
import { ProviderWorkflowRunner } from '../proxy-providers/workflows/provider-workflow';
import { ConnectorAction } from './connector-definition';

/** First live integration is deliberately read-only. Paid flows require order/ledger integration. */
@Injectable()
export class ConnectorWorkflowsService {
  constructor(
    @InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    @InjectModel(PersistedWorkflowRun.name) private readonly runs: Model<PersistedWorkflowRun>,
    private readonly connectors: ProviderConnectorsService,
    private readonly secrets: ConnectorSecrets,
    private readonly http: ConnectorHttp,
    private readonly store: MongoWorkflowStore,
  ) {}

  async inspect(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid workflow ID');
    // Persisted variables/output may contain proxy passwords or provider secrets.
    // Return operational metadata only, never raw payloads to the admin UI.
    const run = await this.runs.findById(id)
      .select('_id accountId connectorCode definitionVersion workflow step status attempts deadlineAt nextCheckAt history createdAt updatedAt')
      .lean().exec();
    if (!run) throw new NotFoundException('Workflow not found');
    return run;
  }

  async startReadOnly(accountId: string, action: ConnectorAction, requestReference: string) {
    if (!Types.ObjectId.isValid(accountId) || !['check', 'catalog', 'fetch', 'usage'].includes(action) ||
        typeof requestReference !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestReference)) {
      throw new BadRequestException('Invalid read-only workflow request');
    }
    accountId = new Types.ObjectId(accountId).toHexString();
    const account = await this.accounts.findById(accountId).lean().exec();
    if (!account?.enabled) throw new BadRequestException('Connector account unavailable');
    const definition = await this.connectors.publishedDefinition(account.connectorCode, account.connectorVersion);
    const binding = definition?.actions[action];
    if (!binding || !('workflow' in binding)) throw new BadRequestException('Action requires a workflow binding');
    const workflow = definition!.workflows![binding.workflow];
    if (workflow.version !== account.connectorVersion || workflow.steps.some(step => step.effect !== 'read')) {
      throw new BadRequestException('Read-only workflow with matching connector version required');
    }
    // Fixed input surface for now: request values/credentials cannot be persisted by callers.
    try {
      const row = await this.runs.create({ accountId, connectorCode: account.connectorCode,
        definitionVersion: account.connectorVersion, workflow: binding.workflow, requestReference,
        step: workflow.entry, status: 'ready', variables: {}, deadlineAt: Date.now() + 15 * 60000 });
      return { id: String(row._id), status: row.status };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const existing = await this.runs.findOne({ accountId, requestReference }).lean().exec();
      if (!existing || existing.workflow !== binding.workflow || existing.connectorCode !== account.connectorCode ||
          existing.definitionVersion !== account.connectorVersion) throw new BadRequestException('Request reference already used for another workflow');
      return { id: String(existing._id), status: existing.status };
    }
  }

  async tick(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid workflow ID');
    const run = await this.runs.findById(id).lean().exec();
    if (!run) throw new NotFoundException('Workflow not found');
    if (!['ready', 'waiting'].includes(run.status)) return;
    const definition = await this.connectors.publishedDefinition(run.connectorCode, run.definitionVersion);
    const workflow = definition?.workflows?.[run.workflow];
    if (!definition || !workflow || workflow.version !== run.definitionVersion || workflow.steps.some(step => step.effect !== 'read')) {
      throw new BadRequestException('Runnable read-only workflow required');
    }
    const runner = new ProviderWorkflowRunner(this.store, {
      execute: async (operation, input) => {
        // Re-read account status/key immediately before each upstream operation.
        const account = await this.accounts.findById(run.accountId).select('+credential').lean().exec();
        if (!account?.enabled || account.connectorCode !== run.connectorCode || account.connectorVersion !== run.definitionVersion) {
          throw new BadRequestException('Connector account unavailable or binding changed');
        }
        const token = this.secrets.decrypt(account.credential, run.accountId);
        return this.http.execute(definition, operation, input, token, false);
      },
    });
    await runner.tick(id, workflow);
  }

  async processDue() {
    await this.store.quarantineExpired();
    const due = await this.runs.find({ status: { $in: ['ready', 'waiting'] },
      $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: { $lte: Date.now() } }] })
      .select('_id').sort({ createdAt: 1 }).limit(20).lean().exec();
    // Bounded serial processing. Atomic Mongo leases protect overlapping workers.
    for (const row of due) {
      try { await this.tick(String(row._id)); }
      catch { /* Leave transient pre-acquisition failures for later; deadlines are bounded. */ }
    }
  }
}
