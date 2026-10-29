import { BadRequestException } from '@nestjs/common';
import { readWorkflowPath } from '../proxy-providers/workflows/provider-workflow';

/** Nested JSON construction, not string interpolation or executable code. */
export type ConnectorBodyValue = { literal: unknown } | { path: string } |
  { object: Record<string, ConnectorBodyValue> } | { array: ConnectorBodyValue[] };

export function evaluateConnectorBody(expression: ConnectorBodyValue, input: Record<string, unknown>, validateOnly = false): unknown {
  let nodes = 0;
  const walk = (value: ConnectorBodyValue, depth: number): unknown => {
    const fail = (): never => { throw new BadRequestException('Invalid nested provider body mapping'); };
    if (++nodes > 1000 || depth > 12 || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return fail();
    if ('path' in value) {
      if (typeof value.path !== 'string' || !value.path.startsWith('$.input.')) return fail();
      let result: unknown;
      try { result = readWorkflowPath({ input }, value.path); } catch { return fail(); }
      if (!validateOnly && result === undefined) throw new BadRequestException('Missing provider input');
      return result;
    }
    if ('literal' in value) {
      if (validateOnly) {
        const check = (item: unknown, at: number) => {
          if (++nodes > 1000 || at > 12) return fail();
          if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
          if (Array.isArray(item)) { item.forEach(child => check(child, at + 1)); return; }
          if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) return fail();
          for (const [key, child] of Object.entries(item)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) return fail();
            check(child, at + 1);
          }
        };
        check(value.literal, depth);
      }
      return value.literal;
    }
    if ('array' in value) {
      if (!Array.isArray(value.array) || value.array.length > 100) return fail();
      return value.array.map(child => walk(child, depth + 1));
    }
    if ('object' in value) {
      if (!value.object || typeof value.object !== 'object' || Array.isArray(value.object) || Object.keys(value.object).length > 100) return fail();
      return Object.fromEntries(Object.entries(value.object).map(([key, child]) => {
        if (!key || key.length > 100 || ['__proto__', 'prototype', 'constructor'].includes(key)) return fail();
        return [key, walk(child, depth + 1)];
      }));
    }
    return fail();
  };
  return walk(expression, 0);
}
