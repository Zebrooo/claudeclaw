import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
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

export type EventStatus = 'pending' | 'dispatched' | 'done' | 'failed' | 'pending_approval'

export interface PublishInput {
  type: string
  source_agent: string
  task_id: string
  project?: string
  payload: Record<string, unknown>
  requires_approval?: boolean
}

export class EventBus {
  constructor(private testDb?: Database.Database) {}

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
    if (this.testDb) {
      this.testDb.prepare(`
        INSERT INTO pipeline_events (id,type,source_agent,task_id,project,payload,status,requires_approval,iteration,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(event.id, event.type, event.source_agent, event.task_id, event.project,
             event.payload, event.status, event.requires_approval, event.iteration,
             event.created_at, event.updated_at)
    } else {
      insertPipelineEvent(event)
    }
    logger.info({ eventId: event.id, type: event.type, source: event.source_agent }, 'Event published')
    return event
  }

  getPendingEvents(): PipelineEvent[] {
    if (this.testDb) {
      return this.testDb.prepare(`SELECT * FROM pipeline_events WHERE status='pending' ORDER BY created_at ASC`).all() as PipelineEvent[]
    }
    return getPipelineEventsByStatus('pending')
  }

  getPendingApprovalEvents(): PipelineEvent[] {
    if (this.testDb) {
      return this.testDb.prepare(`SELECT * FROM pipeline_events WHERE status='pending_approval' ORDER BY created_at ASC`).all() as PipelineEvent[]
    }
    return getPipelineEventsByStatus('pending_approval')
  }

  allTypesPresent(taskId: string, types: string[]): boolean {
    return types.every(type => {
      const rows = this.testDb
        ? this.testDb.prepare(`SELECT id FROM pipeline_events WHERE task_id=? AND type=?`).all(taskId, type)
        : getPipelineEventsByTaskAndType(taskId, type)
      return rows.length > 0
    })
  }

  markDispatched(id: string): void {
    this.testDb
      ? this.testDb.prepare(`UPDATE pipeline_events SET status='dispatched', updated_at=? WHERE id=?`).run(new Date().toISOString(), id)
      : updatePipelineEventStatus(id, 'dispatched')
  }

  markDone(id: string): void {
    this.testDb
      ? this.testDb.prepare(`UPDATE pipeline_events SET status='done', updated_at=? WHERE id=?`).run(new Date().toISOString(), id)
      : updatePipelineEventStatus(id, 'done')
  }

  approve(id: string): void {
    this.testDb
      ? this.testDb.prepare(`UPDATE pipeline_events SET status='pending', updated_at=? WHERE id=?`).run(new Date().toISOString(), id)
      : updatePipelineEventStatus(id, 'pending')
  }

  reject(id: string): void {
    this.testDb
      ? this.testDb.prepare(`UPDATE pipeline_events SET status='failed', updated_at=? WHERE id=?`).run(new Date().toISOString(), id)
      : updatePipelineEventStatus(id, 'failed')
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
    if (this.testDb) {
      this.testDb.prepare(`INSERT INTO pipeline_tasks (id,description,project,status,current_agent,iteration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, description, project ?? null, 'active', null, 0, now, now)
    } else {
      insertPipelineTask(task)
    }
    return id
  }

  updateTask(id: string, updates: { status?: string; current_agent?: string; iteration?: number }): void {
    if (this.testDb) {
      const now = new Date().toISOString()
      if (updates.status !== undefined) this.testDb.prepare(`UPDATE pipeline_tasks SET status=?,updated_at=? WHERE id=?`).run(updates.status, now, id)
      if (updates.current_agent !== undefined) this.testDb.prepare(`UPDATE pipeline_tasks SET current_agent=?,updated_at=? WHERE id=?`).run(updates.current_agent, now, id)
      if (updates.iteration !== undefined) this.testDb.prepare(`UPDATE pipeline_tasks SET iteration=?,updated_at=? WHERE id=?`).run(updates.iteration, now, id)
    } else {
      updatePipelineTask(id, updates)
    }
  }
}

export const eventBus = new EventBus()
