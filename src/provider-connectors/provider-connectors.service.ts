import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConnectorVersion } from './connector-version.schema';
import { ConnectorCache } from './connector-cache.service';
import { CONNECTOR_ACTIONS, ConnectorAction, validateConnectorDefinition } from './connector-definition';
import { legacyConnectorTemplates } from './legacy-connector-templates';
import { randomUUID } from 'node:crypto';
import { validateConnectorTemplate } from './connector-template';
import { connectorActionReadiness, validateConnectorResult } from './connector-contract';
import { mapConnectorOutput } from './connector-output';
import { connectorSucceeded } from './connector-success';

@Injectable()
export class ProviderConnectorsService {
  constructor(@InjectModel(ConnectorVersion.name) private readonly versions: Model<ConnectorVersion>,
    private readonly cache: ConnectorCache) {}

  private identity(code: string, version: number) {
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(code) || !Number.isSafeInteger(version) || version < 1) {
      throw new BadRequestException('Invalid connector code or version');
    }
  }

  private validateVersion(definition: unknown, version: number) {
    const validated = validateConnectorDefinition(definition);
    if (Object.values(validated.workflows ?? {}).some(workflow => workflow.version !== version)) {
      throw new BadRequestException('Workflow version must match connector version');
    }
    return validated;
  }

  list() {
    return this.versions.find().select('code name version status revision updatedAt').sort({ code: 1, version: -1 }).limit(500).lean().exec();
  }

  legacyTemplates() { return legacyConnectorTemplates(); }

  async importTemplate(input: unknown) {
    const template = validateConnectorTemplate(input);
    const definition = structuredClone(template.definition);
    for (const workflow of Object.values(definition.workflows ?? {})) workflow.version = 1;
    // A new local identity prevents imported files from replacing existing integrations.
    return this.create({ code: `provider_${randomUUID().replace(/-/g, '')}`,
      name: template.name, version: 1, definition });
  }

  async exportTemplate(code: string, version: number) {
    const row = await this.get(code, version);
    return validateConnectorTemplate({ format: 'fastproxy-provider', formatVersion: 1,
      name: row.name, definition: row.definition });
  }

  async readiness(code: string, version: number) {
    const row = await this.get(code, version);
    return { code, version, status: row.status, actions: connectorActionReadiness(row.definition) };
  }

  /** Pure offline validation. Return counts only: sample responses may contain secrets. */
  previewOutput(body: { definition: unknown; action: ConnectorAction; sample: unknown }) {
    if (!body || !CONNECTOR_ACTIONS.includes(body.action) || body.action === 'check') {
      throw new BadRequestException('Invalid output preview action');
    }
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(body.sample) ?? ''); }
    catch { throw new BadRequestException('Invalid response sample'); }
    if (!size || size > 100_000) throw new BadRequestException('Response sample exceeds limit');
    const definition = validateConnectorDefinition(body.definition);
    const binding = definition.actions[body.action];
    const operation = binding && 'operation' in binding ? definition.operations[binding.operation] : undefined;
    if (!operation?.output || !operation.response) throw new BadRequestException('Success and output mappings required');
    if (!connectorSucceeded(body.sample, operation.response.success)) {
      return { ok: false, reason: 'success-condition', fieldCount: 0, itemCount: 0 };
    }
    const output = validateConnectorResult(body.action, mapConnectorOutput(operation.output, body.sample));
    return { ok: true, fieldCount: Object.keys(output.fields).length, itemCount: output.items?.length ?? 0 };
  }

  async importLegacyDrafts() {
    const results: { code: string; version: number; status: string; warnings: string[] }[] = [];
    for (const template of legacyConnectorTemplates()) {
      try {
        await this.versions.create({ code: template.code, name: template.name, version: 1,
          status: 'draft', revision: 0, definition: template.definition });
        results.push({ code: template.code, version: 1, status: 'created', warnings: template.warnings });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        results.push({ code: template.code, version: 1, status: 'exists-unchanged', warnings: template.warnings });
      }
    }
    return results;
  }

  async get(code: string, version: number) {
    this.identity(code, version);
    const result = await this.versions.findOne({ code, version }).lean().exec();
    if (!result) throw new NotFoundException('Connector version not found');
    return result;
  }

  async create(body: { code: string; name: string; version: number; definition: unknown }) {
    if (!body) throw new BadRequestException('Body required');
    this.identity(body.code, body.version);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) throw new BadRequestException('Invalid name');
    const definition = this.validateVersion(body.definition, body.version);
    try {
      return await this.versions.create({ code: body.code, name: body.name.trim(), version: body.version, definition, status: 'draft', revision: 0 });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Version already exists');
      throw error;
    }
  }

  async update(code: string, version: number, body: { revision: number; definition: unknown }) {
    this.identity(code, version);
    if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new BadRequestException('Revision required');
    const definition = this.validateVersion(body.definition, version);
    const result = await this.versions.findOneAndUpdate({ code, version, status: 'draft', revision: body.revision },
      { $set: { definition }, $inc: { revision: 1 } }, { new: true }).lean().exec();
    if (!result) throw new ConflictException('Draft changed or version is immutable');
    return result;
  }

  /** Explicit copy to a new revision; never repoints accounts, services or historical orders. */
  async fork(code: string, version: number, body: { revision: number; targetVersion: number }) {
    this.identity(code, version);
    if (!body || Object.keys(body).some(key => !['revision', 'targetVersion'].includes(key)) ||
        !Number.isSafeInteger(body.revision) || body.revision < 0 ||
        !Number.isSafeInteger(body.targetVersion) || body.targetVersion <= version) {
      throw new BadRequestException('Invalid draft copy request');
    }
    const source = await this.get(code, version);
    if (source.status !== 'published' || source.revision !== body.revision) {
      throw new ConflictException('Published source changed; reload before copying');
    }
    const definition = structuredClone(source.definition);
    for (const workflow of Object.values(definition.workflows ?? {})) workflow.version = body.targetVersion;
    return this.create({ code, name: source.name, version: body.targetVersion, definition });
  }

  async publish(code: string, version: number, revision: number) {
    this.identity(code, version);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new BadRequestException('Revision required');
    const current = await this.get(code, version);
    this.validateVersion(current.definition, version);
    const result = await this.versions.findOneAndUpdate({ code, version, status: 'draft', revision },
      { $set: { status: 'published' }, $inc: { revision: 1 } }, { new: true }).lean().exec();
    if (!result) throw new ConflictException('Draft changed or already published');
    return result;
  }

  async publishedDefinition(code: string, version: number) {
    this.identity(code, version);
    return this.cache.published(code, version, async () => {
      const row = await this.versions.findOne({ code, version, status: 'published' }).select('definition').lean().exec();
      return row?.definition ?? null;
    });
  }
}
