/** Declarative connector primitives. No JavaScript or executable templates. */
export type WorkflowValue =
  | { literal: unknown }
  | { path: string };

export interface WorkflowCondition {
  path: string;
  equals: string | number | boolean | null;
}

export interface ProviderWorkflowStep {
  id: string;
  /** Local operation name; the transport resolves a vetted endpoint definition. */
  operation: string;
  effect: 'read' | 'write';
  input: Record<string, WorkflowValue>;
  save: Record<string, string>;
  success: WorkflowCondition;
  pending?: WorkflowCondition;
  rejected?: WorkflowCondition;
  next?: string;
  pollAfterMs?: number;
}

export interface ProviderWorkflow {
  version: number;
  entry: string;
  steps: ProviderWorkflowStep[];
  output: Record<string, WorkflowValue>;
}

export interface WorkflowRun {
  id: string;
  definitionVersion: number;
  step: string;
  status: 'ready' | 'running' | 'waiting' | 'completed' | 'rejected' | 'unknown';
  /** Persist only explicitly mapped fields; never request tokens or raw responses. */
  variables: Record<string, unknown>;
  nextCheckAt?: number;
  output?: Record<string, unknown>;
  /** Fencing token supplied by the persistent store, never by callers. */
  leaseOwner?: string;
}

export interface WorkflowStore {
  /** Atomically acquire a run. Running/terminal runs must not be returned. */
  acquire(id: string, now: number): Promise<WorkflowRun | null>;
  /** Commit the next state before releasing ownership. Must reject stale owners. */
  commit(run: WorkflowRun): Promise<void>;
}

export interface WorkflowTransport {
  /** Credentials stay in the transport and are never added to workflow state. */
  execute(operation: string, input: Record<string, unknown>): Promise<unknown>;
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function readWorkflowPath(value: unknown, path: string): unknown {
  if (path === '$') return value;
  if (!path.startsWith('$.')) throw new Error('Paths must start with $.');
  let current = value;
  const parts = path.slice(2).split('.');
  if (parts.some(part => !part || forbidden.has(part))) throw new Error('Unsafe workflow path');
  for (const part of parts) {
    if (current === null || typeof current !== 'object' ||
        !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function validateProviderWorkflow(definition: ProviderWorkflow): void {
  if (!definition || typeof definition !== 'object' || !Array.isArray(definition.steps) ||
      !Number.isSafeInteger(definition.version) || definition.version < 1 ||
      !definition.steps.length || definition.steps.length > 50) {
    throw new Error('Invalid workflow version or step count');
  }
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (!step || !step.success || !step.save || typeof step.save !== 'object' || Array.isArray(step.save) ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(step.id) || ids.has(step.id) ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(step.operation) ||
        !['read', 'write'].includes(step.effect)) throw new Error('Invalid workflow step');
    ids.add(step.id);
    validateValues(step.input);
    for (const condition of [step.success, step.pending, step.rejected]) {
      if (condition) {
        readWorkflowPath({}, condition.path);
        if (condition.equals !== null && !['string', 'boolean', 'number'].includes(typeof condition.equals) ||
            typeof condition.equals === 'number' && !Number.isFinite(condition.equals)) throw new Error('Invalid condition');
      }
    }
    if (step.pending && (step.effect !== 'read' ||
        !Number.isSafeInteger(step.pollAfterMs) || step.pollAfterMs! < 1000 ||
        step.pollAfterMs! > 3_600_000)) throw new Error('Polling requires a read operation and a bounded interval');
    for (const [key, path] of Object.entries(step.save)) {
      if (forbidden.has(key)) throw new Error('Unsafe variable name');
      readWorkflowPath({}, path);
    }
  }
  validateValues(definition.output);
  if (!ids.has(definition.entry)) throw new Error('Missing entry step');
  for (const step of definition.steps) {
    if (step.next && !ids.has(step.next)) throw new Error('Missing next step');
  }
  // Only polling a read step may repeat. A graph cycle could buy twice.
  for (const origin of definition.steps) {
    const visited = new Set<string>();
    let current: ProviderWorkflowStep | undefined = origin;
    while (current) {
      if (visited.has(current.id)) throw new Error('Workflow cycles are forbidden');
      visited.add(current.id);
      current = definition.steps.find(step => step.id === current!.next);
    }
  }
}

function validateValues(values: Record<string, WorkflowValue>): void {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid field mappings');
  for (const [key, expression] of Object.entries(values)) {
    if (forbidden.has(key) || !expression || typeof expression !== 'object' || Array.isArray(expression) ||
        Object.keys(expression).length !== 1) throw new Error('Invalid expression');
    if ('path' in expression) readWorkflowPath({}, expression.path);
    else if (!('literal' in expression)) throw new Error('Invalid expression');
  }
}

function resolve(values: Record<string, WorkflowValue>, context: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([key, expression]) => {
    if (forbidden.has(key)) throw new Error('Unsafe field name');
    const value = 'literal' in expression ? expression.literal : readWorkflowPath(context, expression.path);
    if (value === undefined) throw new Error(`Missing workflow field: ${key}`);
    return [key, value];
  }));
}

function matches(response: unknown, condition?: WorkflowCondition): boolean {
  return !!condition && readWorkflowPath(response, condition.path) === condition.equals;
}

/** One durable step per invocation. Scheduling and HTTP policy remain separate. */
export class ProviderWorkflowRunner {
  constructor(private readonly store: WorkflowStore, private readonly transport: WorkflowTransport) {}

  async tick(id: string, definition: ProviderWorkflow, now = Date.now()): Promise<void> {
    validateProviderWorkflow(definition);
    const run = await this.store.acquire(id, now);
    if (!run) return;
    try {
      if (run.definitionVersion !== definition.version) throw new Error('Workflow version mismatch');
      const step = definition.steps.find(item => item.id === run.step);
      if (!step) throw new Error('Unknown persisted step');
      const input = resolve(step.input, { variables: run.variables });
      const response = await this.transport.execute(step.operation, input);
      if (matches(response, step.rejected)) {
        run.status = 'rejected';
      } else if (matches(response, step.success)) {
        for (const [key, path] of Object.entries(step.save)) {
          const value = readWorkflowPath(response, path);
          if (value === undefined) throw new Error('Missing response field');
          run.variables[key] = value;
        }
        delete run.nextCheckAt;
        if (step.next) {
          run.step = step.next;
          run.status = 'ready';
        } else {
          run.output = resolve(definition.output, { variables: run.variables });
          run.status = 'completed';
        }
      } else if (matches(response, step.pending)) {
        run.status = 'waiting';
        run.nextCheckAt = now + step.pollAfterMs!;
      } else {
        run.status = 'unknown';
      }
    } catch {
      // An exception cannot prove whether an upstream purchase succeeded.
      // Never reset to ready or silently replay a paid operation.
      run.status = 'unknown';
    }
    await this.store.commit(run);
  }
}
