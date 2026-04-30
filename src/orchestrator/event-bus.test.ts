import { describe, it, expect, beforeEach } from 'vitest'
import { _initTestDatabase } from './db.js'
import { EventBus } from './event-bus.js'

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => {
    _initTestDatabase()
    bus = new EventBus()
  })

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

  it('markDone changes status to done', () => {
    const evt = bus.publish({ type: 'task_created', source_agent: 'orchestrator', task_id: 't1', payload: {} })
    bus.markDone(evt.id)
    expect(bus.getPendingEvents()).toHaveLength(0)
  })

  it('reject changes pending_approval to failed', () => {
    const evt = bus.publish({ type: 'all_checks_passed', source_agent: 'orchestrator',
      task_id: 't1', payload: {}, requires_approval: true })
    bus.reject(evt.id)
    expect(bus.getPendingApprovalEvents()).toHaveLength(0)
    expect(bus.getPendingEvents()).toHaveLength(0)
  })
})
