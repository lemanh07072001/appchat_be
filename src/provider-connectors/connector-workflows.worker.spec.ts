import { ConfigService } from '@nestjs/config';
import { ConnectorWorkflowsWorker } from './connector-workflows.worker';

describe('Connector workflow worker lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not process work without explicit opt-in', async () => {
    const workflows = { processDue: jest.fn() };
    const worker = new ConnectorWorkflowsWorker(workflows as any, new ConfigService());
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(5000);
    expect(workflows.processDue).not.toHaveBeenCalled();
    worker.onModuleDestroy();
  });

  it('does not overlap batches while a previous batch is running', async () => {
    let finish!: () => void;
    const workflows = { processDue: jest.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; })) };
    const worker = new ConnectorWorkflowsWorker(workflows as any, new ConfigService({ CONNECTOR_WORKFLOWS_ENABLED: 'true' }));
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(10000);
    expect(workflows.processDue).toHaveBeenCalledTimes(1);
    finish();
    await jest.advanceTimersByTimeAsync(1000);
    expect(workflows.processDue).toHaveBeenCalledTimes(2);
    worker.onModuleDestroy();
    finish();
    await jest.advanceTimersByTimeAsync(5000);
    expect(workflows.processDue).toHaveBeenCalledTimes(2);
  });

  it('reschedules after transient database failures and stops on shutdown', async () => {
    const workflows = { processDue: jest.fn().mockRejectedValue(new Error('database offline')) };
    const worker = new ConnectorWorkflowsWorker(workflows as any, new ConfigService({ CONNECTOR_WORKFLOWS_ENABLED: 'true' }));
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(3000);
    expect(workflows.processDue).toHaveBeenCalledTimes(3);
    worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(workflows.processDue).toHaveBeenCalledTimes(3);
  });
});
