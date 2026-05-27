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
import type {
  IngestionEnvelope,
  OutboundEnvelope,
} from '../orchestrator/types.js';
import { HUD_SCHEMA } from './schema.js';
import { appendLog } from './store.js';

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

registerExtension({
  name: 'ops-router',
  dbSchema: HUD_SCHEMA,

  hooks: {
    postIngest(envelope: IngestionEnvelope): void {
      if (!isHudGroup(envelope.groupFolder)) return;
      // Mirror the inbound line into the HUD comms log. The board itself is
      // written by ARIA via hud/board.mjs (so she can ask for missing times
      // before recording) — not by an auto-classifier here.
      const prompt = (envelope.prompt || '').trim();
      if (prompt) appendLog('you', prompt);
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
