import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { readWorkflowPath } from '../proxy-providers/workflows/provider-workflow';

export interface ConnectorOutputField {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'isoDate' | 'unixSeconds' | 'unixMilliseconds';
  required?: boolean;
  /** Exact, typed scalar translation; unknown upstream values fail closed. */
  values?: { from: string | number | boolean; to: string | number | boolean }[];
}

/** Output names are stable contracts; paths refer to the upstream response. */
export interface ConnectorOutput {
  fields?: Record<string, ConnectorOutputField>;
  items?: { path: string; fields: Record<string, ConnectorOutputField> };
}

const safeName = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'token', 'token_api', 'apiKey', 'credential']);

export function validateConnectorOutput(input: unknown): asserts input is ConnectorOutput {
  const fail = (): never => { throw new BadRequestException('Invalid provider output mapping'); };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const path = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 500) return fail();
    try { readWorkflowPath({}, value); } catch { fail(); }
  };
  const fields = (value: unknown) => {
    if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 50) return fail();
    for (const [name, field] of Object.entries(value)) {
      if (!safeName.test(name) || forbidden.has(name) || !object(field) ||
          Object.keys(field).some(key => !['path', 'type', 'required', 'values'].includes(key)) ||
          !['string', 'number', 'boolean', 'isoDate', 'unixSeconds', 'unixMilliseconds'].includes(field.type as string) ||
          (field.required !== undefined && typeof field.required !== 'boolean')) return fail();
      path(field.path);
      if (field.values !== undefined) {
        if (['isoDate', 'unixSeconds', 'unixMilliseconds'].includes(field.type as string) || !Array.isArray(field.values) || !field.values.length || field.values.length > 100) return fail();
        const seen = new Set<string>();
        for (const pair of field.values) {
          if (!object(pair) || Object.keys(pair).length !== 2 || !Object.hasOwn(pair, 'from') || !Object.hasOwn(pair, 'to') ||
              !['string', 'number', 'boolean'].includes(typeof pair.from) || typeof pair.to !== field.type ||
              [pair.from, pair.to].some(value => typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && value.length > 8192)) return fail();
          const key = JSON.stringify([typeof pair.from, pair.from]);
          if (seen.has(key)) return fail();
          seen.add(key);
        }
      }
    }
  };
  if (!object(input) || Object.keys(input).some(key => !['fields', 'items'].includes(key)) ||
      input.fields === undefined && input.items === undefined) return fail();
  if (input.fields !== undefined) fields(input.fields);
  if (input.items !== undefined) {
    if (!object(input.items) || Object.keys(input.items).some(key => !['path', 'fields'].includes(key))) return fail();
    path(input.items.path); fields(input.items.fields);
  }
}

/** No raw-response fallback, scripts, implicit coercion or arbitrary object copies. */
export function mapConnectorOutput(mapping: ConnectorOutput, response: unknown): {
  fields: Record<string, string | number | boolean>;
  items?: Record<string, string | number | boolean>[];
} {
  validateConnectorOutput(mapping);
  const fail = (): never => { throw new BadGatewayException('Provider response does not match output mapping'); };
  const fields = (definitions: Record<string, ConnectorOutputField>, source: unknown) => {
    const result: Record<string, string | number | boolean> = {};
    for (const [name, definition] of Object.entries(definitions)) {
      let value = readWorkflowPath(source, definition.path);
      if (value === undefined || value === null) {
        if (definition.required) fail();
        continue;
      }
      if (definition.values) {
        const translation = definition.values.find(pair => pair.from === value);
        if (!translation) return fail();
        value = translation.to;
      }
      if (definition.type === 'unixSeconds' || definition.type === 'unixMilliseconds') {
        // Units are explicit in the template; never guess from magnitude or coerce strings.
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail();
        const milliseconds = definition.type === 'unixSeconds' ? value * 1000 : value;
        if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) return fail();
        result[name] = new Date(milliseconds).toISOString();
      } else if (definition.type === 'isoDate') {
        // Require an explicit timezone. Numeric timestamps have ambiguous units.
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return fail();
        result[name] = new Date(value).toISOString();
      } else {
        if (typeof value !== definition.type || typeof value === 'number' && !Number.isFinite(value) ||
            typeof value === 'string' && value.length > 8192) return fail();
        result[name] = value as string | number | boolean;
      }
    }
    return result;
  };
  const result: ReturnType<typeof mapConnectorOutput> = { fields: fields(mapping.fields ?? {}, response) };
  if (mapping.items) {
    const items = readWorkflowPath(response, mapping.items.path);
    if (!Array.isArray(items) || items.length > 5000) return fail();
    result.items = items.map(item => fields(mapping.items!.fields, item));
  }
  return result;
}
