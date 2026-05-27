/**
 * HUD channel — a local, no-op delivery channel for the ARIA Command Center.
 *
 * The web HUD console talks to ARIA through its own group ("aria") instead of
 * the Telegram group, so console conversations never echo into the user's
 * Telegram chat. This channel owns the `hud:` JID space and performs NO
 * external delivery: the HUD reads ARIA's replies from the `hud_log` table,
 * which the ops-router `postRoute` hook populates after routing.
 *
 * It exists only so the orchestrator has a connected channel that owns the
 * group's JID (the agent pipeline requires one) without sending anything out.
 */
import {
  registerChannel,
  ChannelOpts,
} from '../orchestrator/channel-registry.js';
import { Channel } from '../orchestrator/types.js';
import { logger } from '../orchestrator/logger.js';

const HUD_JID_PREFIX = 'hud:';
const HUD_CONSOLE_JID = 'hud:console';

class HudChannel implements Channel {
  name = 'hud';

  constructor(private readonly opts: ChannelOpts) {}

  async connect(): Promise<void> {
    // Ensure a chats row exists for the console JID, so storeMessage's
    // chat_jid → chats.jid foreign key is satisfied when the HUD ingests a
    // command. Without this the webhook ingest throws and the request hangs.
    try {
      this.opts.onChatMetadata?.(
        HUD_CONSOLE_JID,
        new Date().toISOString(),
        'ARIA Console',
        'hud',
        false,
      );
    } catch (err) {
      logger.warn({ err }, 'HUD channel: could not register console chat');
    }
    logger.info('HUD channel connected (local, no external delivery)');
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(HUD_JID_PREFIX);
  }

  async sendMessage(jid: string, _text: string): Promise<void> {
    // Intentionally local: the HUD renders ARIA's reply from hud_log
    // (written by ops-router postRoute). Nothing leaves the server.
    logger.debug({ jid }, 'HUD channel: reply kept local (no Telegram echo)');
  }

  async setTyping(): Promise<void> {
    /* no typing indicator for the local HUD channel */
  }

  async disconnect(): Promise<void> {
    /* nothing to tear down */
  }
}

registerChannel('hud', (opts: ChannelOpts) => new HudChannel(opts));
