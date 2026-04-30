import { randomUUID } from 'crypto'
import {
  insertPipelineEvent,
  insertPipelineTask,
  getPipelineEventsByStatus,
  getPipelineEventsByTaskAndType,
  updatePipelineEventStatus,
  updatePipelineTask,
} from './db.js'
import { PipelineEvent, PipelineTask } from './types.js'
import { logger } from './logger.js'

export type EventStatus = PipelineEvent['status']

export interface PublishInput {
  type: string
  source_agent: string
  task_id: string
  project?: string
  payload: Record<string, unknown>
  requires_approval?: boolean
}

export class EventBus {
  publish(input: PublishInput): PipelineEvent {
    const now = new Date().toISOString()
    const status: EventStatus = input.requires_approval ? 'pending_approval' : 'pending'
    const event: PipelineEvent = {
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: input.type,
      source_agent: input.source_agent,
      task_id: input.task_id,
      project: input.project ?? null,
      payload: JSON.stringify(input.payload),
      status,
      requires_approval: input.requires_approval ? 1 : 0,
      iteration: 0,
      created_at: now,
      updated_at: now,
    }
    insertPipelineEvent(event)
    logger.info({ eventId: event.id, type: event.type, source: event.source_agent }, 'Event published')
    return event
  }

  getPendingEvents(): PipelineEvent[] {
    return getPipelineEventsByStatus('pending')
  }

  getPendingApprovalEvents(): PipelineEvent[] {
    return getPipelineEventsByStatus('pending_approval')
  }

  allTypesPresent(taskId: string, types: string[]): boolean {
    return types.every(type => getPipelineEventsByTaskAndType(taskId, type).length > 0)
  }

  markDispatched(id: string): void {
    updatePipelineEventStatus(id, 'dispatched')
  }

  markDone(id: string): void {
    updatePipelineEventStatus(id, 'done')
  }

  approve(id: string): void {
    updatePipelineEventStatus(id, 'pending')
  }

  reject(id: string): void {
    updatePipelineEventStatus(id, 'failed')
  }

  createTask(description: string, project?: string): string {
    const id = `task_${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const task: PipelineTask = {
      id,
      description,
      project: project ?? null,
      status: 'active',
      current_agent: null,
      iteration: 0,
      created_at: now,
      updated_at: now,
    }
    insertPipelineTask(task)
    return id
  }

  updateTask(id: string, updates: { status?: string; current_agent?: string; iteration?: number }): void {
    updatePipelineTask(id, updates)
  }
}

export const eventBus = new EventBus()
