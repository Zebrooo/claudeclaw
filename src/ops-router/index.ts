/**
 * ops-router — additive ClaudeClaw extension that feeds the ARIA HUD.
 *
 * It observes the message flow without altering it:
 *   - postIngest : inbound messages to the HUD group are classified (Haiku)
 *                  and written to the HUD tables; the raw line is logged.
 *   - postRoute  : the bot's outbound replies are logged so the HUD console
 *                  shows ARIA's confirmations.
 *
 * Both hooks are observe-only (`void`), so they can never drop or modify a
 * message or block the bot. Classification is fire-and-forget.
 */
import { registerExtension } from '../orchestrator/extensions.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import type {
  IngestionEnvelope,
  OutboundEnvelope,
} from '../orchestrator/types.js';
import { HUD_SCHEMA } from './schema.js';
import { classifyMessage } from './classifier.js';
import { appendLog, getWorks, insertEvent, insertTask } from './store.js';

// The board (timeline/works/awaiting) is fed from the Telegram main group.
const HUD_GROUP_FOLDER =
  process.env.HUD_GROUP_FOLDER ||
  readEnvFile(['HUD_GROUP_FOLDER']).HUD_GROUP_FOLDER ||
  'telegram_main';

// The web HUD console is its own ARIA group, delivered via the local `hud:`
// channel so replies never echo to Telegram. Both groups feed the HUD.
const HUD_CONSOLE_FOLDER =
  process.env.HUD_CONSOLE_FOLDER ||
  readEnvFile(['HUD_CONSOLE_FOLDER']).HUD_CONSOLE_FOLDER ||
  'aria';

function isHudGroup(folder?: string): boolean {
  return folder === HUD_GROUP_FOLDER || folder === HUD_CONSOLE_FOLDER;
}

async function captureInbound(prompt: string): Promise<void> {
  // Read work areas fresh each time so newly-added projects apply without a restart.
  const works = getWorks();
  const c = await classifyMessage(prompt, works);
  switch (c.kind) {
    case 'event':
      insertEvent({
        title: c.title,
        project: c.project,
        start_ts: c.whenISO || new Date().toISOString(),
        protected: c.protectedBlock,
        source: 'classifier',
      });
      break;
    case 'task':
    case 'promise':
    case 'awaiting':
      // All actionable items become current tasks under their work area.
      insertTask({
        work: c.work,
        title: c.title,
        project: c.project,
        kind: c.kind,
      });
      break;
    case 'chatter':
    default:
      break; // only the log line, no panel entry
  }
}

registerExtension({
  name: 'ops-router',
  dbSchema: HUD_SCHEMA,

  hooks: {
    postIngest(envelope: IngestionEnvelope): void {
      if (!isHudGroup(envelope.groupFolder)) return;
      // Skip the bot's own echoes / non-channel synthetic triggers in the log
      const prompt = (envelope.prompt || '').trim();
      if (!prompt) return;

      appendLog('you', prompt);
      captureInbound(prompt).catch((err) =>
        logger.debug({ err }, 'ops-router: captureInbound failed'),
      );
    },

    postRoute(envelope: OutboundEnvelope): void {
      if (!isHudGroup(envelope.groupFolder)) return;
      if (
        envelope.triggerType !== 'agent-response' &&
        envelope.triggerType !== 'task-result'
      )
        return;
      const text = (envelope.text || '').trim();
      if (text) appendLog('aria', text);
    },
  },
});
