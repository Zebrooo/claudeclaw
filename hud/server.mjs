/**
 * ARIA HUD — standalone web server.
 *
 * A tiny, dependency-light process (Node http + better-sqlite3, both already
 * present in claudeclaw). It is fully decoupled from the bot:
 *   - reads store/messages.db READ-ONLY to render the HUD panels
 *   - forwards console commands to the EXISTING claudeclaw webhook, signed with
 *     WEBHOOK_SECRET, so "typing in the web == messaging the bot"
 *
 * If this process dies, the bot is unaffected. It never writes to the DB.
 *
 * Config (from claudeclaw .env): HUD_PORT, HUD_TOKEN, WEBHOOK_PORT,
 * WEBHOOK_SECRET, HUD_GROUP_FOLDER.
 */
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---------- config ---------- */
function readEnv() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...out, ...process.env };
}
const env = readEnv();
const HUD_PORT = parseInt(env.HUD_PORT || '3200', 10);
const HUD_TOKEN = env.HUD_TOKEN || '';
const WEBHOOK_PORT = parseInt(env.WEBHOOK_PORT || '3100', 10);
const WEBHOOK_SECRET = env.WEBHOOK_SECRET || '';
const GROUP = env.HUD_GROUP_FOLDER || 'telegram_main';

const DB_PATH = path.join(ROOT, 'store', 'messages.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

/* ---------- helpers ---------- */
function safeEqual(a, b) {
  const ba = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function authorized(req) {
  if (!HUD_TOKEN) return true; // no token configured → open (localhost dev)
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('hud_token='));
  const fromCookie = cookie ? decodeURIComponent(cookie.slice('hud_token='.length)) : '';
  const fromHeader = req.headers['x-hud-token'] || '';
  return safeEqual(fromCookie, HUD_TOKEN) || safeEqual(fromHeader, HUD_TOKEN);
}

function ageDays(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function hourOf(iso) {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
}

function sameLocalDay(iso) {
  const d = new Date(iso);
  const n = new Date();
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}

/* ---------- state assembly ---------- */
function buildEvents() {
  const events = [];

  // Captured timed events for today
  const rows = db
    .prepare(`SELECT title, project, start_ts, end_ts, protected FROM hud_events ORDER BY start_ts`)
    .all();
  for (const r of rows) {
    if (!sameLocalDay(r.start_ts)) continue;
    const start = hourOf(r.start_ts);
    const end = r.end_ts ? hourOf(r.end_ts) : Math.min(23.5, start + 0.75);
    events.push({
      title: r.title,
      project: r.project,
      start,
      end,
      protected: !!r.protected,
    });
  }

  // Active scheduled tasks whose next run is today → schedule blocks
  try {
    const tasks = db
      .prepare(
        `SELECT prompt, next_run FROM scheduled_tasks WHERE status = 'active' AND next_run IS NOT NULL`,
      )
      .all();
    for (const t of tasks) {
      if (!sameLocalDay(t.next_run)) continue;
      const start = hourOf(t.next_run);
      events.push({
        title: (t.prompt || 'SCHEDULED').slice(0, 40),
        project: 'CRON',
        start,
        end: Math.min(23.5, start + 0.5),
        protected: false,
      });
    }
  } catch {
    /* scheduled_tasks shape may vary; ignore */
  }

  return events.sort((a, b) => a.start - b.start);
}

function buildFronts() {
  const rows = db
    .prepare(`SELECT name, pct, meta, stalled FROM hud_fronts ORDER BY stalled DESC, pct DESC`)
    .all();
  return rows.map((r) => ({
    name: r.name,
    pct: r.pct,
    meta: r.meta || '',
    stall: !!r.stalled,
  }));
}

function buildAwaiting() {
  const rows = db
    .prepare(
      `SELECT direction, who, tag, created_at FROM hud_awaiting WHERE resolved = 0 ORDER BY created_at ASC`,
    )
    .all();
  return rows.map((r) => {
    const days = ageDays(r.created_at);
    return {
      dir: r.direction === 'in' ? 'IN←' : 'OUT→',
      who: r.who,
      tag: r.tag || '',
      age: `${days}d`,
      old: days >= 5,
    };
  });
}

function buildLog() {
  const rows = db
    .prepare(`SELECT ts, role, text FROM hud_log ORDER BY id DESC LIMIT 30`)
    .all();
  return rows.reverse().map((r) => ({ ts: r.ts, role: r.role, text: r.text }));
}

function buildState() {
  const fronts = buildFronts();
  const awaiting = buildAwaiting();
  const events = buildEvents();
  return {
    now: new Date().toISOString(),
    events,
    fronts,
    awaiting,
    log: buildLog(),
    status: {
      frontsOpen: fronts.length,
      stalled: fronts.filter((f) => f.stall).length,
      awaitingOpen: awaiting.length,
      awaitingOld: awaiting.filter((a) => a.old).length,
      blocks: events.length,
      protected: events.filter((e) => e.protected).length,
    },
  };
}

/* ---------- command forwarding ---------- */
function forwardCommand(text) {
  return new Promise((resolve) => {
    if (!WEBHOOK_SECRET) {
      resolve({ status: 502, body: { error: 'WEBHOOK_SECRET not configured' } });
      return;
    }
    const payload = JSON.stringify({ prompt: text });
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: WEBHOOK_PORT,
        path: `/webhook/${encodeURIComponent(GROUP)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Signature': signature,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = { raw: body };
          }
          resolve({ status: res.statusCode || 200, body: parsed });
        });
      },
    );
    req.on('error', (err) => resolve({ status: 502, body: { error: err.message } }));
    req.write(payload);
    req.end();
  });
}

/* ---------- http ---------- */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${HUD_PORT}`);

  // Static HUD page (token-gated)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const key = url.searchParams.get('key');
    if (HUD_TOKEN && key && safeEqual(key, HUD_TOKEN)) {
      res.setHeader(
        'Set-Cookie',
        `hud_token=${encodeURIComponent(HUD_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
      );
    } else if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ARIA // access denied — open with ?key=<HUD_TOKEN>');
      return;
    }
    const html = readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    try {
      sendJson(res, 200, buildState());
    } catch (err) {
      sendJson(res, 500, { error: String(err && err.message) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/command') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let text = '';
      try {
        text = (JSON.parse(body).text || '').toString().trim();
      } catch {
        text = body.trim();
      }
      if (!text) return sendJson(res, 400, { error: 'empty command' });
      const result = await forwardCommand(text);
      sendJson(res, result.status, result.body);
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(HUD_PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`ARIA HUD listening on http://127.0.0.1:${HUD_PORT} (group: ${GROUP})`);
});
