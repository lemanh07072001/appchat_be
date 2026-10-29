import { readWorkflowPath } from '../proxy-providers/workflows/provider-workflow';

export type ConnectorSuccess = { path: string; equals: string | number | boolean | null } |
  { path: string; type: 'array' | 'nonemptyString' };

/** Explicit envelope assertion for read APIs without a success flag. Missing data fails closed. */
export function connectorSucceeded(response: unknown, condition: ConnectorSuccess): boolean {
  const value = readWorkflowPath(response, condition.path);
  if (!('type' in condition)) return value === condition.equals;
  if (condition.type === 'array') return Array.isArray(value);
  return condition.type === 'nonemptyString' && typeof value === 'string' && value.trim().length > 0;
}
