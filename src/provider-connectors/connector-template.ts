import { BadRequestException } from '@nestjs/common';
import { ConnectorDefinition, validateConnectorDefinition } from './connector-definition';

export interface ConnectorTemplate {
  format: 'fastproxy-provider';
  formatVersion: 1;
  name: string;
  definition: ConnectorDefinition;
}

/** Portable configuration only. Never import identity, publication state or credentials. */
export function validateConnectorTemplate(input: unknown): ConnectorTemplate {
  const fail = (): never => { throw new BadRequestException('Invalid provider template'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const value = input as ConnectorTemplate;
  if (Object.keys(value).some(key => !['format', 'formatVersion', 'name', 'definition'].includes(key)) ||
      value.format !== 'fastproxy-provider' || value.formatVersion !== 1 ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) return fail();
  const definition = validateConnectorDefinition(value.definition);
  // The account checker needs an explicit, read-only success assertion.
  const check = definition.actions.check;
  if (!check || !('operation' in check) || !definition.operations[check.operation].response) {
    throw new BadRequestException('Template requires a read-only connection check with response mapping');
  }
  return { format: 'fastproxy-provider', formatVersion: 1, name: value.name.trim(), definition };
}
