import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PipelineRunner, SUBSCRIPTIONS, AND_GATES } from './pipeline-runner.js'
import { EventBus } from './event-bus.js'
import { _initTestDatabase } from './db.js'

describe('SUBSCRIPTIONS', () => {
  it('task_created triggers pipeline_pm', () => {
    expect(SUBSCRIPTIONS['task_created']).toContain('pipeline_pm')
  })
  it('code_ready triggers tester, security, analyst, architect', () => {
    const subs = SUBSCRIPTIONS['code_ready']
    expect(subs).toContain('pipeline_tester')
    expect(subs).toContain('pipeline_security')
    expect(subs).toContain('pipeline_analyst')
    expect(subs).toContain('pipeline_architect')
  })
})

describe('AND_GATES', () => {
  it('developer_start requires architect_approved and design_ready', () => {
    expect(AND_GATES['developer_start'].requires).toContain('architect_approved')
    expect(AND_GATES['developer_start'].requires).toContain('design_ready')
  })
  it('all_checks_passed requires 4 events', () => {
    expect(AND_GATES['all_checks_passed'].requires).toHaveLength(4)
  })
})

describe('PipelineRunner.getTargetAgents', () => {
  let bus: EventBus
  let runner: PipelineRunner

  beforeEach(() => {
    _initTestDatabase()
    bus = new EventBus()
    runner = new PipelineRunner(bus, { route: vi.fn().mockResolvedValue(undefined), send: vi.fn(), addPreHook: vi.fn(), addPostHook: vi.fn() } as any, () => ({}))
  })

  it('returns pm for task_created event', () => {
    const taskId = bus.createTask('build auth')
    const evt = bus.publish({ type: 'task_created', source_agent: 'orchestrator', task_id: taskId, payload: {} })
    const targets = runner.getTargetAgents(evt)
    expect(targets).toContain('pipeline_pm')
  })

  it('returns empty for architect_approved when design_ready not yet published', () => {
    const taskId = bus.createTask('build auth')
    bus.publish({ type: 'architect_approved', source_agent: 'architect', task_id: taskId, payload: {} })
    const evt = bus.getPendingEvents()[0]
    const targets = runner.getTargetAgents(evt)
    expect(targets).toHaveLength(0)
  })

  it('returns developer when both architect_approved and design_ready published', () => {
    const taskId = bus.createTask('build auth')
    bus.publish({ type: 'design_ready', source_agent: 'designer', task_id: taskId, payload: {} })
    bus.publish({ type: 'architect_approved', source_agent: 'architect', task_id: taskId, payload: {} })
    const evt = bus.getPendingEvents().find(e => e.type === 'architect_approved')!
    const targets = runner.getTargetAgents(evt)
    expect(targets).toContain('pipeline_developer')
  })
})
