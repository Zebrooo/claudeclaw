#!/usr/bin/env node
/**
 * ARIA board CLI — lets the agent write tasks/events to the HUD board.
 *
 * The agent runs inside its container with the repo mounted rw, so it calls:
 *   node /workspace/extra/claudeclaw/hud/board.mjs task  --work yandex --title "…"
 *   node /workspace/extra/claudeclaw/hud/board.mjs event --title "…" --start <ISO> --end <ISO>
 *   node /workspace/extra/claudeclaw/hud/board.mjs list
 *   node /workspace/extra/claudeclaw/hud/board.mjs done  --id <id>
 *
 * Writes go to store/messages.db (hud_tasks / hud_events); the HUD polls and
 * shows them within ~3s. This is the single source of truth for board writes —
 * ARIA records here instead of just claiming it did.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(ROOT, 'store', 'messages.db'));
db.pragma('busy_timeout = 5000'); // tolerate the bot/HUD holding the db briefly
const now = new Date().toISOString();

function out(obj) { console.log(JSON.stringify(obj)); }
function die(msg) { console.error(msg); process.exit(1); }

if (cmd === 'task') {
  const title = flag('title');
  if (!title) die('--title required');
  // Enforce the "ask for the time first" rule deterministically: a task must
  // carry a --due (when it's due) OR be explicitly marked --no-deadline. This
  // makes it impossible to record a task without first clarifying the time.
  const due = flag('due');
  const noDeadline = args.includes('--no-deadline');
  if (!due && !noDeadline) {
    die('refusing to record without a time: pass --due "<когда>" (спроси у пользователя) or --no-deadline if he said there is none');
  }
  const reqWork = flag('work') || 'other';
  const valid = db.prepare('SELECT key FROM hud_works WHERE key = ?').get(reqWork);
  const work = valid ? reqWork : 'other';
  const kind = ['task', 'promise', 'awaiting'].includes(flag('kind')) ? flag('kind') : 'task';
  const info = db
    .prepare(`INSERT INTO hud_tasks (work, title, project, kind, due, done, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`)
    .run(work, title, flag('project') || null, kind, noDeadline ? null : due, now);
  out({ ok: true, added: 'task', id: info.lastInsertRowid, work, title, kind, due: noDeadline ? null : due });
} else if (cmd === 'event') {
  const title = flag('title');
  const start = flag('start');
  if (!title) die('--title required');
  if (!start) die('--start (ISO datetime) required');
  const info = db
    .prepare(`INSERT INTO hud_events (title, project, start_ts, end_ts, protected, source, created_at) VALUES (?, ?, ?, ?, 0, 'aria', ?)`)
    .run(title, flag('project') || null, start, flag('end') || null, now);
  out({ ok: true, added: 'event', id: info.lastInsertRowid, title, start, end: flag('end') || null });
} else if (cmd === 'list') {
  out({
    works: db.prepare('SELECT key, label, screen FROM hud_works ORDER BY sort_order, id').all(),
    tasks: db.prepare('SELECT id, work, title, kind FROM hud_tasks WHERE done = 0 ORDER BY id DESC').all(),
  });
} else if (cmd === 'done') {
  const id = flag('id');
  if (!id) die('--id required');
  db.prepare('UPDATE hud_tasks SET done = 1 WHERE id = ?').run(id);
  out({ ok: true, done: Number(id) });
} else {
  console.log(
    'usage:\n' +
    '  node hud/board.mjs task  --work <key> --title "..." (--due "<когда>" | --no-deadline) [--project "..."] [--kind task|promise|awaiting]\n' +
    '  node hud/board.mjs event --title "..." --start <ISO> [--end <ISO>] [--project "..."]\n' +
    '  node hud/board.mjs list\n' +
    '  node hud/board.mjs done  --id <id>\n' +
    'work keys: yandex, enspire, family, projects, other\n' +
    'note: task REQUIRES --due "<время/срок>" or --no-deadline — ask the user for the time first.',
  );
}
db.close();
