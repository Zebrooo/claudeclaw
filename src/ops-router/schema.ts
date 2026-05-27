/**
 * ops-router — HUD data schema.
 *
 * These tables are registered additively via the extension `dbSchema` hook and
 * live in the same store/messages.db. They back the four ARIA HUD panels:
 *   - hud_events    → DAY TIMELINE (timed blocks captured from messages)
 *   - hud_fronts    → ACTIVE FRONTS (projects with progress/stall state)
 *   - hud_awaiting  → AWAITING RESPONSE (what I owe / what I wait for)
 *   - hud_log       → command-console log (inbound/outbound lines)
 *
 * Nothing here touches existing core tables — it is purely additive.
 */
export const HUD_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS hud_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    project TEXT,
    start_ts TEXT NOT NULL,
    end_ts TEXT,
    protected INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hud_events_start ON hud_events(start_ts)`,

  `CREATE TABLE IF NOT EXISTS hud_fronts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pct INTEGER NOT NULL DEFAULT 0,
    meta TEXT,
    stalled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS hud_awaiting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL DEFAULT 'out',
    who TEXT NOT NULL,
    tag TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hud_awaiting_open ON hud_awaiting(resolved, created_at)`,

  `CREATE TABLE IF NOT EXISTS hud_works (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    hints TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    screen TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL
  )`,
  // NOTE: the extension-schema runner has no per-statement try/catch, so a
  // non-idempotent ALTER would crash startup once the column exists. Existing
  // DBs are migrated out-of-band (one-off node script); fresh DBs get `screen`
  // from the CREATE above.
  // Default work areas — extend by inserting rows (see hud/add-work.mjs).
  // `screen` groups areas into swipeable HUD screens (main / family / projects / …).
  `INSERT OR IGNORE INTO hud_works (key, label, hints, sort_order, screen, created_at) VALUES
     ('yandex', 'YANDEX', 'yandex,яндекс', 1, 'main', datetime('now')),
     ('enspire', 'ENSPIRE', 'enspire,ensol,azure,.net,core,энспайр', 2, 'main', datetime('now')),
     ('family', 'СЕМЬЯ', 'семья,дом,family,дети,жена,быт', 10, 'family', datetime('now')),
     ('projects', 'ПРОЕКТЫ', 'проект,сайд,side,pet,стартап,startup,личн', 20, 'projects', datetime('now'))`,

  `CREATE TABLE IF NOT EXISTS hud_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    project TEXT,
    kind TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hud_tasks_open ON hud_tasks(done, work, created_at)`,

  `CREATE TABLE IF NOT EXISTS hud_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hud_log_ts ON hud_log(id)`,
];
