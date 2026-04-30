import { EventBus } from './event-bus.js'
import { PipelineEvent, MessageRouter } from './types.js'
import { logger } from './logger.js'

const POLL_INTERVAL = 5000

export class ApprovalGate {
  private notified = new Set<string>()

  constructor(
    private bus: EventBus,
    private router: MessageRouter,
    private orchestratorJid: string,
  ) {}

  private formatApprovalMessage(event: PipelineEvent): string {
    let summary: string
    try {
      const parsed = JSON.parse(event.payload) as Record<string, unknown>
      summary = JSON.stringify(parsed)
    } catch {
      summary = event.payload
    }

    return [
      '⚠️ Требуется подтверждение',
      `Тип: ${event.type}`,
      `Задача: ${event.task_id}`,
      `Данные: ${summary}`,
      '',
      'Ответьте "да" для подтверждения или "нет, <инструкция>" для отклонения с уточнением.',
      `ID события: ${event.id}`,
    ].join('\n')
  }

  async tick(): Promise<void> {
    const events = this.bus.getPendingApprovalEvents()
    for (const event of events) {
      if (this.notified.has(event.id)) continue
      const message = this.formatApprovalMessage(event)
      await this.router.send(this.orchestratorJid, message)
      this.notified.add(event.id)
    }
  }

  handleUserReply(eventId: string, reply: string): void {
    const normalized = reply.trim().toLowerCase()

    if (normalized === 'да' || normalized === 'yes') {
      this.bus.approve(eventId)
      this.notified.delete(eventId)
      return
    }

    if (normalized.startsWith('нет, ') || normalized.startsWith('no, ')) {
      const instruction = normalized.startsWith('нет, ')
        ? reply.trim().slice('нет, '.length)
        : reply.trim().slice('no, '.length)
      this.bus.reject(eventId)
      this.notified.delete(eventId)
      void this.router.send(
        this.orchestratorJid,
        `Событие ${eventId} отклонено. Инструкция для пересмотра: ${instruction}`,
      )
      return
    }

    // Any other reply — reject without specific instruction
    this.bus.reject(eventId)
    this.notified.delete(eventId)
    void this.router.send(
      this.orchestratorJid,
      `Событие ${eventId} отклонено.`,
    )
  }

  start(): void {
    const poll = () => {
      this.tick().catch((err: unknown) => {
        logger.error({ err }, 'ApprovalGate tick error')
      })
    }
    setInterval(poll, POLL_INTERVAL)
    logger.info('ApprovalGate started')
  }
}
