/**
 * ops-router — typed read/write helpers over the HUD tables.
 *
 * Writes are called from the extension hooks (in the orchestrator process).
 * Reads are also usable, but the HUD web server reads the same DB read-only
 * in its own process, so this module is the single source of column shapes.
 */
import { getDb } from '../orchestrator/db.js';

export interface HudEvent {
  title: string;
  project?: string | null;
  start_ts: string;
  end_ts?: string | null;
  protected?: boolean;
  source?: string | null;
}

export interface HudAwaiting {
  direction: 'in' | 'out';
  who: string;
  tag?: string | null;
}

export type HudLogRole = 'you' | 'aria' | 'sys' | 'alert';

export function insertEvent(e: HudEvent): void {
  getDb()
    .prepare(
      `INSERT INTO hud_events (title, project, start_ts, end_ts, protected, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.title,
      e.project ?? null,
      e.start_ts,
      e.end_ts ?? null,
      e.protected ? 1 : 0,
      e.source ?? null,
      new Date().toISOString(),
    );
}

export function insertAwaiting(a: HudAwaiting): void {
  getDb()
    .prepare(
      `INSERT INTO hud_awaiting (direction, who, tag, resolved, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .run(a.direction, a.who, a.tag ?? null, new Date().toISOString());
}

export function upsertFront(
  key: string,
  fields: { name?: string; pct?: number; meta?: string; stalled?: boolean },
): void {
  // On insert, fall back to sensible defaults. On conflict, only overwrite a
  // field when the caller actually provided it (the `*OrNull` params stay
  // null otherwise, so COALESCE preserves the existing value).
  getDb()
    .prepare(
      `INSERT INTO hud_fronts (key, name, pct, meta, stalled, updated_at)
       VALUES (@key, @name, @pct, @meta, @stalled, @now)
       ON CONFLICT(key) DO UPDATE SET
         name = COALESCE(@nameOrNull, name),
         pct = COALESCE(@pctOrNull, pct),
         meta = COALESCE(@metaOrNull, meta),
         stalled = @stalled,
         updated_at = @now`,
    )
    .run({
      key,
      name: fields.name ?? key,
      pct: fields.pct ?? 0,
      meta: fields.meta ?? null,
      stalled: fields.stalled ? 1 : 0,
      now: new Date().toISOString(),
      nameOrNull: fields.name ?? null,
      pctOrNull: fields.pct ?? null,
      metaOrNull: fields.meta ?? null,
    });
}

export function appendLog(role: HudLogRole, text: string): void {
  getDb()
    .prepare(`INSERT INTO hud_log (ts, role, text) VALUES (?, ?, ?)`)
    .run(new Date().toISOString(), role, text);
  // Trim to the most recent 200 lines to keep the table bounded.
  getDb().exec(
    `DELETE FROM hud_log WHERE id NOT IN (SELECT id FROM hud_log ORDER BY id DESC LIMIT 200)`,
  );
}
