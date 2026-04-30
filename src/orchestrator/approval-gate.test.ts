import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import { EventBus } from './event-bus.js';
import { ApprovalGate } from './approval-gate.js';
import { MessageRouter } from './types.js';

describe('ApprovalGate', () => {
  let bus: EventBus;
  let gate: ApprovalGate;
  let mockRouter: { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    _initTestDatabase();
    bus = new EventBus();
    mockRouter = { send: vi.fn().mockResolvedValue(undefined) };
    gate = new ApprovalGate(
      bus,
      mockRouter as unknown as MessageRouter,
      'tg:999',
    );
  });

  it('sends message with ⚠️ for pending_approval events on tick()', async () => {
    const taskId = bus.createTask('build auth');
    bus.publish({
      type: 'all_checks_passed',
      source_agent: 'orchestrator',
      task_id: taskId,
      payload: { summary: 'all tests green' },
      requires_approval: true,
    });

    await gate.tick();

    expect(mockRouter.send).toHaveBeenCalledTimes(1);
    const [jid, message] = mockRouter.send.mock.calls[0];
    expect(jid).toBe('tg:999');
    expect(message).toContain('⚠️');
    expect(message).toContain('all_checks_passed');
    expect(message).toContain(taskId);
  });

  it('does NOT send duplicate notification if tick() called twice', async () => {
    const taskId = bus.createTask('build auth');
    bus.publish({
      type: 'all_checks_passed',
      source_agent: 'orchestrator',
      task_id: taskId,
      payload: {},
      requires_approval: true,
    });

    await gate.tick();
    await gate.tick();

    expect(mockRouter.send).toHaveBeenCalledTimes(1);
  });

  it('approves event when user replies "да" — event moves to getPendingEvents()', async () => {
    const taskId = bus.createTask('build auth');
    const evt = bus.publish({
      type: 'all_checks_passed',
      source_agent: 'orchestrator',
      task_id: taskId,
      payload: {},
      requires_approval: true,
    });

    await gate.tick();
    gate.handleUserReply(evt.id, 'да');

    expect(bus.getPendingApprovalEvents()).toHaveLength(0);
    expect(bus.getPendingEvents()).toHaveLength(1);
  });

  it('rejects event when user replies "нет" — event leaves getPendingApprovalEvents()', async () => {
    const taskId = bus.createTask('build auth');
    const evt = bus.publish({
      type: 'all_checks_passed',
      source_agent: 'orchestrator',
      task_id: taskId,
      payload: {},
      requires_approval: true,
    });

    await gate.tick();
    gate.handleUserReply(evt.id, 'нет');

    expect(bus.getPendingApprovalEvents()).toHaveLength(0);
    expect(bus.getPendingEvents()).toHaveLength(0);
  });

  it('rejects with correction when user replies "нет, fix auth" — sends rerouting message to orchestrator', async () => {
    const taskId = bus.createTask('build auth');
    const evt = bus.publish({
      type: 'all_checks_passed',
      source_agent: 'orchestrator',
      task_id: taskId,
      payload: {},
      requires_approval: true,
    });

    await gate.tick();
    // reset the call count after tick notification
    mockRouter.send.mockClear();

    gate.handleUserReply(evt.id, 'нет, fix auth');

    expect(bus.getPendingApprovalEvents()).toHaveLength(0);
    expect(bus.getPendingEvents()).toHaveLength(0);
    expect(mockRouter.send).toHaveBeenCalledTimes(1);
    const [jid, message] = mockRouter.send.mock.calls[0];
    expect(jid).toBe('tg:999');
    expect(message).toContain('fix auth');
  });
});
