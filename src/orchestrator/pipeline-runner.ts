import { EventBus } from './event-bus.js'
import { MessageRouter, PipelineEvent, RegisteredGroup } from './types.js'
import { logger } from './logger.js'

// Which agent group(s) subscribe to each event type
export const SUBSCRIPTIONS: Record<string, string[]> = {
  task_created:         ['pipeline_pm'],
  spec_ready:           ['pipeline_architect', 'pipeline_designer'],
  architect_approved:   [],   // AND-gated
  design_ready:         [],   // AND-gated
  code_ready:           ['pipeline_tester', 'pipeline_security', 'pipeline_analyst', 'pipeline_architect'],
  tests_failed:         ['pipeline_developer'],
  security_issues:      ['pipeline_developer'],
  arch_violation:       ['pipeline_developer'],
  discovery_requested:  ['pipeline_discovery'],
  server_state_updated: ['pipeline_deployer'],
  deployed:             ['pipeline_orchestrator'],
  task_completed:       [],
}

// AND-gates: all `requires` types must exist for the same task_id before `dispatches` runs
export const AND_GATES: Record<string, { requires: string[]; dispatches: string[] }> = {
  developer_start: {
    requires: ['architect_approved', 'design_ready'],
    dispatches: ['pipeline_developer'],
  },
  all_checks_passed: {
    requires: ['tests_passed', 'security_ok', 'analysis_done', 'arch_ok'],
    dispatches: [],
  },
}

// Which AND-gate does each event type trigger a check for?
const AND_GATE_TRIGGERS: Record<string, string> = {
  architect_approved: 'developer_start',
  design_ready:       'developer_start',
  tests_passed:       'all_checks_passed',
  security_ok:        'all_checks_passed',
  analysis_done:      'all_checks_passed',
  arch_ok:            'all_checks_passed',
}

const POLL_INTERVAL = 3000

export class PipelineRunner {
  private running = false

  constructor(
    private bus: EventBus,
    private router: MessageRouter,
    private getRegisteredGroups: () => Record<string, RegisteredGroup>,
  ) {}

  getTargetAgents(event: PipelineEvent): string[] {
    const gateName = AND_GATE_TRIGGERS[event.type]
    if (gateName) {
      const gate = AND_GATES[gateName]
      if (!gate) return []
      if (!this.bus.allTypesPresent(event.task_id, gate.requires)) return []
      return gate.dispatches
    }
    return SUBSCRIPTIONS[event.type] ?? []
  }

  private findJidForFolder(folder: string): string | null {
    const groups = this.getRegisteredGroups()
    const entry = Object.entries(groups).find(([, g]) => g.folder === folder)
    return entry ? entry[0] : null
  }

  private buildPrompt(event: PipelineEvent): string {
    const payload = JSON.parse(event.payload) as Record<string, unknown>
    return [
      `[PIPELINE] Event: ${event.type}`,
      `Task ID: ${event.task_id}`,
      event.project ? `Project: ${event.project}` : '',
      `From: ${event.source_agent}`,
      `Payload:\n${JSON.stringify(payload, null, 2)}`,
      '',
      'Process this pipeline event according to your role. When done, publish the result event via IPC.',
    ].filter(Boolean).join('\n')
  }

  private async dispatchToAgent(event: PipelineEvent, agentFolder: string): Promise<void> {
    const jid = this.findJidForFolder(agentFolder)
    if (!jid) {
      logger.warn({ agentFolder, eventId: event.id }, 'No registered JID for agent — skipping')
      return
    }
    await this.router.route({
      chatJid: jid,
      text: this.buildPrompt(event),
      triggerType: 'ipc',
      groupFolder: agentFolder,
    })
    logger.info({ agentFolder, eventId: event.id, type: event.type }, 'Dispatched to agent')
  }

  async tick(): Promise<void> {
    for (const event of this.bus.getPendingEvents()) {
      const targets = this.getTargetAgents(event)
      if (targets.length === 0 && !AND_GATE_TRIGGERS[event.type]) {
        this.bus.markDone(event.id)
        continue
      }
      if (targets.length === 0) continue  // AND-gate not satisfied yet
      this.bus.markDispatched(event.id)
      for (const folder of targets) {
        await this.dispatchToAgent(event, folder)
      }
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = async () => {
      if (!this.running) return
      try { await this.tick() } catch (err) { logger.error({ err }, 'PipelineRunner tick error') }
      setTimeout(loop, POLL_INTERVAL)
    }
    loop()
    logger.info('PipelineRunner started')
  }

  stop(): void { this.running = false }
}
