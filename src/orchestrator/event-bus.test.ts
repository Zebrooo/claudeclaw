import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { EventBus } from './event-bus.js'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE pipeline_events (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, source_agent TEXT NOT NULL,
      task_id TEXT NOT NULL, project TEXT, payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending', requires_approval INTEGER NOT NULL DEFAULT 0,
      iteration INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE pipeline_tasks (
      id TEXT PRIMARY KEY, description TEXT NOT NULL, project TEXT,
      status TEXT NOT NULL DEFAULT 'active', current_agent TEXT,
      iteration INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  return db
}

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => { bus = new EventBus(makeDb()) })

  it('publishes an event with status pending', () => {
    const evt = bus.publish({ type: 'task_created', source_agent: 'orchestrator',
      task_id: 'task_1', payload: { description: 'build auth' } })
    expect(evt.status).toBe('pending')
    expect(evt.id).toMatch(/^evt_/)
  })

  it('sets status pending_approval when requires_approval is true', () => {
    const evt = bus.publish({ type: 'all_checks_passed', source_agent: 'orchestrator',
      task_id: 'task_1', payload: {}, requires_approval: true })
    expect(evt.status).toBe('pending_approval')
  })

  it('getPendingEvents returns only pending events', () => {
    bus.publish({ type: 'task_created', source_agent: 'orchestrator', task_id: 't1', payload: {} })
    bus.publish({ type: 'spec_ready', source_agent: 'pm', task_id: 't1', payload: {}, requires_approval: true })
    const pending = bus.getPendingEvents()
    expect(pending).toHaveLength(1)
    expect(pending[0].type).toBe('task_created')
  })

  it('markDispatched changes status to dispatched', () => {
    const evt = bus.publish({ type: 'task_created', source_agent: 'orchestrator', task_id: 't1', payload: {} })
    bus.markDispatched(evt.id)
    expect(bus.getPendingEvents()).toHaveLength(0)
  })

  it('approve changes pending_approval to pending', () => {
    const evt = bus.publish({ type: 'all_checks_passed', source_agent: 'orchestrator',
      task_id: 't1', payload: {}, requires_approval: true })
    bus.approve(evt.id)
    expect(bus.getPendingEvents()).toHaveLength(1)
  })

  it('allTypesPresent returns true when all required events exist for task', () => {
    bus.publish({ type: 'tests_passed', source_agent: 'tester', task_id: 't1', payload: {} })
    bus.publish({ type: 'security_ok', source_agent: 'security', task_id: 't1', payload: {} })
    bus.publish({ type: 'analysis_done', source_agent: 'analyst', task_id: 't1', payload: {} })
    bus.publish({ type: 'arch_ok', source_agent: 'architect', task_id: 't1', payload: {} })
    expect(bus.allTypesPresent('t1', ['tests_passed', 'security_ok', 'analysis_done', 'arch_ok'])).toBe(true)
  })

  it('allTypesPresent returns false when some events missing', () => {
    bus.publish({ type: 'tests_passed', source_agent: 'tester', task_id: 't1', payload: {} })
    expect(bus.allTypesPresent('t1', ['tests_passed', 'security_ok'])).toBe(false)
  })
})
