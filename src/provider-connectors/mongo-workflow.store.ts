import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { PersistedWorkflowRun } from './workflow-run.schema';
import { WorkflowRun, WorkflowStore } from '../proxy-providers/workflows/provider-workflow';

/** MongoDB is authoritative. Redis notifications must never grant execution ownership. */
@Injectable()
export class MongoWorkflowStore implements WorkflowStore {
  constructor(@InjectModel(PersistedWorkflowRun.name) private readonly runs: Model<PersistedWorkflowRun>) {}

  async acquire(id: string, now: number): Promise<WorkflowRun | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const owner = randomUUID();
    const row = await this.runs.findOneAndUpdate({ _id: id, status: { $in: ['ready', 'waiting'] },
      deadlineAt: { $gt: now }, attempts: { $lt: 200 },
      $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: { $lte: now } }] },
      { $set: { status: 'running', leaseOwner: owner, leaseUntil: now + 90000 },
        $inc: { attempts: 1 }, $push: { history: { $each: [{ status: 'running', at: now }], $slice: -300 } } },
      { new: true }).lean().exec();
    if (!row) return null;
    return { id: String(row._id), definitionVersion: row.definitionVersion, step: row.step,
      status: 'running', variables: structuredClone(row.variables), leaseOwner: owner };
  }

  async commit(run: WorkflowRun): Promise<void> {
    if (!run.leaseOwner || !Types.ObjectId.isValid(run.id) ||
        !['ready', 'waiting', 'completed', 'rejected', 'unknown'].includes(run.status)) {
      throw new ConflictException('Invalid workflow ownership or transition');
    }
    const now = Date.now();
    const result = await this.runs.updateOne({ _id: run.id, status: 'running',
      leaseOwner: run.leaseOwner, leaseUntil: { $gt: now } }, {
      $set: { step: run.step, status: run.status, variables: run.variables,
        ...(run.output !== undefined ? { output: run.output } : {}),
        ...(run.nextCheckAt !== undefined ? { nextCheckAt: run.nextCheckAt } : {}) },
      $unset: { leaseOwner: '', leaseUntil: '', ...(run.nextCheckAt === undefined ? { nextCheckAt: '' } : {}) },
      $push: { history: { $each: [{ step: run.step, status: run.status, at: now }], $slice: -300 } },
    }).exec();
    if (result.modifiedCount !== 1) throw new ConflictException('Workflow lease lost; result requires reconciliation');
  }

  /** Never replay abandoned paid requests. Even read steps conservatively require review for now. */
  async quarantineExpired(now = Date.now()) {
    return this.runs.updateMany({ $or: [
      { status: 'running', leaseUntil: { $lte: now } },
      { status: { $in: ['ready', 'waiting'] }, deadlineAt: { $lte: now } },
      { status: { $in: ['ready', 'waiting'] }, attempts: { $gte: 200 } },
    ] }, { $set: { status: 'unknown' }, $unset: { leaseOwner: '', leaseUntil: '' },
      $push: { history: { $each: [{ status: 'unknown', at: now }], $slice: -300 } } }).exec();
  }
}
