import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { readWorkflowPath, validateProviderWorkflow, ProviderWorkflow, WorkflowValue } from '../proxy-providers/workflows/provider-workflow';
import { ConnectorOutput, validateConnectorOutput } from './connector-output';
import { ConnectorBodyValue, evaluateConnectorBody } from './connector-body';
import { ConnectorSuccess } from './connector-success';
import { ConnectorPurchasePolicy, validatePurchasePolicy } from './connector-purchase-policy';

export const CONNECTOR_ACTIONS = ['check', 'catalog', 'buy', 'fetch', 'renew', 'rotate', 'cancel', 'usage', 'topup', 'password', 'allowedIps'] as const;
export type ConnectorAction = typeof CONNECTOR_ACTIONS[number];
/** Bounded text assembly for provider filters; URL encoding remains transport-owned. */
export type ConnectorRequestValue = WorkflowValue | { concat: WorkflowValue[] };

export interface ConnectorDefinition {
  baseUrl: string;
  auth: { type: 'bearer' | 'header' | 'query' | 'path'; name?: string };
  purchasePolicy?: ConnectorPurchasePolicy;
  operations: Record<string, {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    effect: 'read' | 'write';
    timeoutMs: number;
    output?: ConnectorOutput;
    pagination?: { pageParameter: string; hasNextPath: string; pageSizeParameter: string; pageSize: number; maxPages: number };
    request?: {
      path?: Record<string, ConnectorRequestValue>;
      query?: Record<string, ConnectorRequestValue>;
      body?: Record<string, ConnectorBodyValue>;
      encoding?: 'json' | 'form';
    };
    response?: {
      success: ConnectorSuccess;
      account?: string;
      balance?: string;
      currency?: string;
    };
  }>;
  workflows?: Record<string, ProviderWorkflow>;
  actions: Partial<Record<ConnectorAction, { operation: string } | { workflow: string }>>;
}

/** Intentionally restricted first schema; never accepts scripts or embedded credentials. */
export function validateConnectorDefinition(input: unknown): ConnectorDefinition {
  const fail = (): never => { throw new BadRequestException('Invalid connector definition'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const value = input as ConnectorDefinition;
  if (Object.keys(value).some(k => !['baseUrl', 'auth', 'operations', 'workflows', 'actions', 'purchasePolicy'].includes(k))) fail();
  if (value.purchasePolicy !== undefined) validatePurchasePolicy(value.purchasePolicy);
  let url: URL;
  try { url = new URL(value.baseUrl); } catch { return fail(); }
  // This is configuration validation, not an SSRF-safe network transport.
  // Runtime must additionally resolve DNS, pin public addresses and forbid redirects.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)) fail();
  if (!value.auth || !['bearer', 'header', 'query', 'path'].includes(value.auth.type) ||
      Object.keys(value.auth).some(k => !['type', 'name'].includes(k)) ||
      (value.auth.type !== 'bearer' && (!value.auth.name ||
        !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value.auth.name) ||
        /^(host|cookie|content-length|connection)$/i.test(value.auth.name)))) fail();
  if (!value.operations || typeof value.operations !== 'object' || Array.isArray(value.operations) ||
      !Object.keys(value.operations).length || Object.keys(value.operations).length > 100) fail();
  for (const [name, op] of Object.entries(value.operations)) {
    if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name) || !op ||
        Object.keys(op).some(k => !['method', 'path', 'effect', 'timeoutMs', 'response', 'request', 'output', 'pagination'].includes(k)) ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method) ||
        !['read', 'write'].includes(op.effect) || typeof op.path !== 'string' ||
        !/^\/[A-Za-z0-9/_{}.-]*$/.test(op.path) || op.path.startsWith('//') || op.path.includes('..') ||
        !Number.isInteger(op.timeoutMs) || op.timeoutMs < 1000 || op.timeoutMs > 60000) fail();
    if (op.output !== undefined) validateConnectorOutput(op.output);
    if (op.pagination !== undefined) {
      const p = op.pagination;
      if (!p || typeof p !== 'object' || Array.isArray(p) ||
          Object.keys(p).some(key => !['pageParameter', 'hasNextPath', 'pageSizeParameter', 'pageSize', 'maxPages'].includes(key)) ||
          op.effect !== 'read' || op.method !== 'GET' || !op.output?.items ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(p.pageParameter) ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(p.pageSizeParameter) || p.pageParameter === p.pageSizeParameter ||
          !Number.isSafeInteger(p.pageSize) || p.pageSize < 1 || p.pageSize > 1000 ||
          !Number.isSafeInteger(p.maxPages) || p.maxPages < 1 || p.maxPages > 50 ||
          typeof p.hasNextPath !== 'string' || p.hasNextPath.length > 500 ||
          [p.pageParameter, p.pageSizeParameter].some(key => ['constructor', 'prototype', '__proto__'].includes(key) || Object.hasOwn(op.request?.query ?? {}, key) ||
            value.auth.type === 'query' && value.auth.name === key)) fail();
      try { readWorkflowPath({}, p.hasNextPath); } catch { fail(); }
    }
    if (op.request) {
      if (Object.keys(op.request).some(k => !['path', 'query', 'body', 'encoding'].includes(k)) ||
          (op.request.encoding !== undefined && !['json', 'form'].includes(op.request.encoding)) ||
          (op.request.body !== undefined && ['GET', 'DELETE'].includes(op.method))) fail();
      for (const section of [op.request.path, op.request.query, op.request.body]) {
        if (section === undefined) continue;
        if (!section || typeof section !== 'object' || Array.isArray(section) || Object.keys(section).length > 100) fail();
        for (const [key, expression] of Object.entries(section)) {
          if (section === op.request.body) {
            if (['__proto__', 'prototype', 'constructor'].includes(key) || !key || key.length > 100) fail();
            evaluateConnectorBody(expression as ConnectorBodyValue, {}, true);
            if (op.request.encoding === 'form' && ('object' in expression || 'array' in expression)) fail();
            continue;
          }
          if (['__proto__', 'prototype', 'constructor'].includes(key) || !key || key.length > 100 ||
              !expression || typeof expression !== 'object' || Array.isArray(expression) || Object.keys(expression).length !== 1) fail();
          const parts = 'concat' in expression ? expression.concat : [expression];
          if (!Array.isArray(parts) || !parts.length || parts.length > 20) fail();
          for (const part of parts) {
            if (!part || typeof part !== 'object' || Array.isArray(part) || Object.keys(part).length !== 1) fail();
            if ('path' in part) {
              if (typeof part.path !== 'string' || !part.path.startsWith('$.input.')) fail();
              try { readWorkflowPath({}, part.path); } catch { fail(); }
            } else if (!('literal' in part)) fail();
            else if ('concat' in expression && (!['string', 'number', 'boolean'].includes(typeof part.literal) ||
                typeof part.literal === 'number' && !Number.isFinite(part.literal) || typeof part.literal === 'string' && part.literal.length > 8192)) fail();
          }
        }
      }
    }
    if (op.response) {
      const mapping = op.response;
      if (Object.keys(mapping).some(k => !['success', 'account', 'balance', 'currency'].includes(k)) ||
          !mapping.success || typeof mapping.success.path !== 'string') fail();
      const condition = mapping.success;
      if ('type' in condition) {
        if (Object.keys(condition).some(k => !['path', 'type'].includes(k)) ||
            !['array', 'nonemptyString'].includes(condition.type) || condition.type === 'array' && op.effect !== 'read') fail();
      } else if (Object.keys(condition).some(k => !['path', 'equals'].includes(k)) ||
          !['string', 'number', 'boolean'].includes(typeof condition.equals) && condition.equals !== null) fail();
      try {
        for (const path of [mapping.success.path, mapping.account, mapping.balance, mapping.currency]) {
          if (path !== undefined) readWorkflowPath({}, path);
        }
      } catch { fail(); }
    }
  }
  if (value.workflows !== undefined) {
    if (!value.workflows || typeof value.workflows !== 'object' || Array.isArray(value.workflows) || Object.keys(value.workflows).length > 30) fail();
    for (const [name, workflow] of Object.entries(value.workflows)) {
      if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name)) fail();
      try { validateProviderWorkflow(workflow); } catch { fail(); }
      for (const step of workflow.steps) {
        if (!Object.hasOwn(value.operations, step.operation) || value.operations[step.operation].effect !== step.effect) fail();
      }
    }
  }
  if (!value.actions || typeof value.actions !== 'object' || Array.isArray(value.actions)) fail();
  for (const [name, action] of Object.entries(value.actions)) {
    if (!CONNECTOR_ACTIONS.includes(name as ConnectorAction) || !action) fail();
    if ('workflow' in action) {
      if (Object.keys(action).length !== 1 || !value.workflows || !Object.hasOwn(value.workflows, action.workflow)) fail();
      if (['check', 'catalog', 'fetch', 'usage'].includes(name) && value.workflows![action.workflow].steps.some(step => step.effect !== 'read')) fail();
      continue;
    }
    if (
        Object.keys(action).some(k => k !== 'operation') ||
        !Object.hasOwn(value.operations, action.operation)) fail();
    if (['check', 'catalog', 'fetch', 'usage'].includes(name) &&
        value.operations[action.operation].effect !== 'read') fail();
  }
  if (value.purchasePolicy) {
    const catalog = value.actions.catalog;
    const fields = catalog && 'operation' in catalog ? value.operations[catalog.operation].output?.items?.fields : undefined;
    // Optional catalog metadata may be null on unrelated products. Eligibility
    // still fails closed when a selected product lacks the mapped field.
    if (!fields || value.purchasePolicy.catalog.some(rule => !fields[rule.field] ||
        fields[rule.field].type !== typeof rule.equals)) fail();
    if (!value.actions.buy) fail();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 100_000) fail();
  return structuredClone(value);
}
