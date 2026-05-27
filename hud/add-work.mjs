#!/usr/bin/env node
/**
 * Add (or update) a HUD work area — a panel in the right column.
 *
 *   node hud/add-work.mjs <key> "<LABEL>" "<hint1,hint2,...>" [screen] [sortOrder]
 *
 * <screen> groups areas into swipeable HUD screens: main | family | projects | …
 * (defaults to "main"). Examples:
 *   node hud/add-work.mjs ozon "OZON" "ozon,озон"                 # main screen
 *   node hud/add-work.mjs dacha "ДАЧА" "дача,участок" family      # family screen
 *   node hud/add-work.mjs bot "TG-BOT" "бот,bot" projects 5       # projects, order 5
 *
 * The classifier (Haiku + heuristic) uses the hints to route tasks here; the
 * HUD renders a panel per area automatically on its screen. To remove one:
 *   node -e "new(require('better-sqlite3'))('store/messages.db').prepare('DELETE FROM hud_works WHERE key=?').run('<key>')"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const [key, label, hints = '', screen = 'main', sortRaw] = process.argv.slice(2);
if (!key || !label) {
  console.error(
    'usage: node hud/add-work.mjs <key> "<LABEL>" "<hints csv>" [screen=main] [sortOrder]',
  );
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(ROOT, 'store', 'messages.db'));

db.exec(`CREATE TABLE IF NOT EXISTS hud_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  hints TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  screen TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL
)`);

const nextSort =
  sortRaw != null
    ? Number(sortRaw)
    : (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM hud_works').get().n);

db.prepare(
  `INSERT INTO hud_works (key, label, hints, sort_order, screen, created_at)
   VALUES (?, ?, ?, ?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET label=excluded.label, hints=excluded.hints, sort_order=excluded.sort_order, screen=excluded.screen`,
).run(key, label, hints, nextSort, screen);

console.log(`work area saved: ${key} → "${label}" [screen: ${screen}] (hints: ${hints || '—'}, order ${nextSort})`);
for (const w of db.prepare('SELECT key,label,screen,sort_order FROM hud_works ORDER BY screen,sort_order,id').all())
  console.log(`  [${w.screen}] ${w.sort_order}. ${w.key} — ${w.label}`);
db.close();
