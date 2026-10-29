import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import { ConnectorAction, ConnectorDefinition, validateConnectorDefinition } from './connector-definition';
import { ConnectorDispatches, DispatchIdentity } from './connector-dispatch.service';
import { ConnectorHttp } from './connector-http.service';
import { buildConnectorRequest } from './connector-request';
import { mapConnectorOutput } from './connector-output';
import { validateConnectorResult } from './connector-contract';
import { connectorSucceeded } from './connector-success';

type MappedResult = ReturnType<typeof mapConnectorOutput>;

/** Local-only preflight shared by the order claim and durable dispatch fence. */
export function preflightConnectorWrite(definitionInput: ConnectorDefinition, action: ConnectorAction,
  input: Record<string, unknown>, token: string) {
  const definition = validateConnectorDefinition(definitionInput);
  if (!['buy', 'renew', 'rotate', 'cancel', 'topup', 'password', 'allowedIps'].includes(action)) {
    throw new BadRequestException('Order-bound write action required');
  }
  const binding = definition.actions[action];
  const operation = binding && 'operation' in binding ? definition.operations[binding.operation] : undefined;
  if (!binding || !('operation' in binding) || !operation || operation.effect !== 'write' || !operation.output || !operation.response) {
    throw new BadRequestException('Write action requires direct operation, success and output mappings');
  }
  buildConnectorRequest(definition, binding.operation, input, token);
  return { definition, binding, output: operation.output, response: operation.response };
}

/**
 * Internal orchestration primitive, deliberately NOT registered as an HTTP endpoint.
 * An order-ledger integration must authorize funds and pin the account/version before
 * invoking it. The completion sink must durably save the normalized result to that
 * exact order/attempt; otherwise the dispatch remains quarantined as unknown.
 */
export class ConnectorWriteExecutor {
  constructor(private readonly dispatches: ConnectorDispatches, private readonly http: ConnectorHttp) {}

  async execute(request: {
    identity: DispatchIdentity;
    definition: ConnectorDefinition;
    input: Record<string, unknown>;
    token: string;
    persistResult: (dispatchId: string, result: MappedResult) => Promise<void>;
  }) {
    const { identity, input, token, persistResult } = request;
    const action = identity.action as ConnectorAction;
    if (!['buy', 'renew', 'rotate', 'cancel', 'topup', 'password', 'allowedIps'].includes(action) || typeof persistResult !== 'function') {
      throw new BadRequestException('Order-bound write action and persistence sink required');
    }
    // Validate path placeholders and required inputs before permanently fencing a request.
    const { definition, binding, output, response: responseMapping } = preflightConnectorWrite(request.definition, action, input, token);
    const claim = await this.dispatches.claim(identity, input);
    if (!claim.acquired) throw new ConflictException('Provider dispatch already exists; reconcile instead of retrying');

    // If this commit fails, never send upstream. A stale claimed record is safe to inspect.
    await this.dispatches.submitted(claim.id, claim.owner);
    try {
      const response = await this.http.execute(definition, binding.operation, input, token, true);
      if (!connectorSucceeded(response, responseMapping.success)) {
        // Not an automatic refund/retry: provider-specific rejection semantics are not verified.
        throw new BadGatewayException('Provider write outcome requires reconciliation');
      }
      const result = validateConnectorResult(action, mapConnectorOutput(output, response));
      if (JSON.stringify(result).includes(token)) throw new BadGatewayException('Provider write output contains account credential');
      await this.dispatches.saveResult(claim.id, claim.owner, result);
      await persistResult(claim.id, result);
      await this.dispatches.complete(claim.id, claim.owner);
      return { dispatchId: claim.id, result };
    } catch {
      // Never expose upstream errors, callback payloads, credentials or raw response bodies.
      // If marking unknown also fails, submitted remains fenced and cannot be retried.
      try { await this.dispatches.unknown(claim.id, claim.owner); } catch { /* durable fence remains */ }
      throw new BadGatewayException('Provider write outcome requires reconciliation; do not retry automatically');
    }
  }
}
