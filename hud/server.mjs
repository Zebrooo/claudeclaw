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
 * All clock math is Europe/Moscow (the user's timezone), independent of the
 * host's process timezone.
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
import { synthesize, SPEAKKIT_VOICES } from './yandex-tts.mjs';
import { synthesizePiper, listPiperVoices } from './piper-tts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TZ = 'Europe/Moscow';

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
// Console commands go to the dedicated ARIA group (local hud: channel), so
// they never echo into Telegram. The board still reads telegram_main data.
const GROUP = env.HUD_CONSOLE_FOLDER || 'aria';
// Yandex SpeechKit (neural TTS) — optional. When the key is present the HUD
// speaks via Yandex; otherwise it falls back to the browser's built-in voice.
const YA_TTS_KEY = env.YANDEX_SPEECHKIT_API_KEY || '';
const YA_TTS_VOICE = env.YANDEX_SPEECHKIT_VOICE || 'alena';
const YA_TTS_EMOTION = env.YANDEX_SPEECHKIT_EMOTION || 'good';
const YA_TTS_FOLDER = env.YANDEX_SPEECHKIT_FOLDER_ID || '';
// Piper — local neural TTS (no key, no cloud). Used when Yandex isn't set.
const PIPER_BIN = env.PIPER_BIN || '';
const PIPER_VOICES_DIR = env.PIPER_VOICES_DIR || '';
const PIPER_LIB_DIR = env.PIPER_LIB_DIR || (PIPER_BIN ? path.dirname(PIPER_BIN) : '');
const PIPER_VOICE = env.PIPER_VOICE || '';
const piperVoices = PIPER_BIN && PIPER_VOICES_DIR ? listPiperVoices(PIPER_VOICES_DIR) : [];
const piperEnabled = !!(PIPER_BIN && existsSync(PIPER_BIN) && piperVoices.length);

// Provider priority: Yandex (cloud, if key) → Piper (local) → browser fallback.
function ttsInfo() {
  if (YA_TTS_KEY) return { provider: 'yandex', voices: SPEAKKIT_VOICES, voice: YA_TTS_VOICE };
  if (piperEnabled) return { provider: 'piper', voices: piperVoices, voice: PIPER_VOICE || piperVoices[0] };
  return { provider: 'browser', voices: [], voice: '' };
}

const DB_PATH = path.join(ROOT, 'store', 'messages.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

/* ---------- Moscow-time helpers ---------- */
const mskFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
function mskParts(d) {
  const o = {};
  for (const p of mskFmt.formatToParts(d)) o[p.type] = p.value;
  return o;
}
function hourOf(iso) {
  const p = mskParts(new Date(iso));
  return Number(p.hour) + Number(p.minute) / 60;
}
function ymd(d) {
  const p = mskParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
function sameMskDay(iso) {
  return ymd(new Date(iso)) === ymd(new Date());
}
function ageDays(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/* ---------- auth ---------- */
function safeEqual(a, b) {
  const ba = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
function authorized(req) {
  if (!HUD_TOKEN) return true;
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('hud_token='));
  const fromCookie = cookie ? decodeURIComponent(cookie.slice('hud_token='.length)) : '';
  const fromHeader = req.headers['x-hud-token'] || '';
  return safeEqual(fromCookie, HUD_TOKEN) || safeEqual(fromHeader, HUD_TOKEN);
}

/* ---------- state assembly ---------- */
function buildEvents() {
  const events = [];
  const rows = db
    .prepare(`SELECT title, project, start_ts, end_ts, protected FROM hud_events ORDER BY start_ts`)
    .all();
  for (const r of rows) {
    if (!sameMskDay(r.start_ts)) continue;
    const start = hourOf(r.start_ts);
    const end = r.end_ts ? hourOf(r.end_ts) : Math.min(23.5, start + 0.75);
    events.push({ title: r.title, project: r.project, start, end, protected: !!r.protected });
  }
  try {
    const tasks = db
      .prepare(
        `SELECT prompt, next_run FROM scheduled_tasks WHERE status = 'active' AND next_run IS NOT NULL`,
      )
      .all();
    for (const t of tasks) {
      if (!sameMskDay(t.next_run)) continue;
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

function buildWorks() {
  try {
    return db
      .prepare(`SELECT key, label, screen FROM hud_works ORDER BY sort_order, id`)
      .all()
      .map((r) => ({ key: r.key, label: r.label, screen: r.screen || 'main' }));
  } catch {
    // Older DBs without the `screen` column — fall back gracefully.
    try {
      return db
        .prepare(`SELECT key, label FROM hud_works ORDER BY sort_order, id`)
        .all()
        .map((r) => ({ key: r.key, label: r.label, screen: 'main' }));
    } catch {
      return [];
    }
  }
}

function buildTasks(works) {
  const grouped = {};
  for (const w of works) grouped[w.key] = [];
  grouped.other = [];
  try {
    const rows = db
      .prepare(
        `SELECT work, title, project, kind, due, created_at FROM hud_tasks WHERE done = 0 ORDER BY id DESC`,
      )
      .all();
    for (const r of rows) {
      const bucket = grouped[r.work] ? r.work : 'other';
      if (grouped[bucket].length >= 12) continue;
      grouped[bucket].push({
        title: r.title,
        project: r.project || '',
        kind: r.kind || 'task',
        due: r.due || '',
        age: `${ageDays(r.created_at)}d`,
      });
    }
  } catch {
    /* table may not exist yet */
  }
  return grouped;
}

function buildLog() {
  try {
    return db
      .prepare(`SELECT ts, role, text FROM hud_log ORDER BY id DESC LIMIT 30`)
      .all()
      .reverse()
      .map((r) => ({ ts: r.ts, role: r.role, text: r.text }));
  } catch {
    return [];
  }
}

function buildState() {
  const works = buildWorks();
  const tasks = buildTasks(works);
  const events = buildEvents();
  const counts = {};
  for (const k of Object.keys(tasks)) counts[k] = tasks[k].length;
  return {
    now: new Date().toISOString(),
    tz: TZ,
    events,
    works, // [{key,label,screen}] ordered — right-column panels, grouped by screen
    tasks, // { <workKey>: [...], other: [...] }
    log: buildLog(),
    tts: ttsInfo(),
    status: {
      counts,
      blocks: events.length,
      protected: events.filter((e) => e.protected).length,
      openTasks: Object.values(counts).reduce((a, b) => a + b, 0),
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
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate',
    });
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

  // Neural TTS proxy — synthesize ARIA's reply via Yandex SpeechKit and stream
  // back OggOpus. The API key stays server-side. Cookie/header token-gated.
  if (req.method === 'GET' && url.pathname === '/api/tts') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const text = (url.searchParams.get('text') || '').slice(0, 4500);
    if (!text.trim()) return sendJson(res, 400, { error: 'empty text' });
    const reqVoice = url.searchParams.get('voice') || '';

    const stream = (mime, audio) => {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': audio.length,
        'Cache-Control': 'no-store',
      });
      res.end(audio);
    };
    const fail = (err) => sendJson(res, 502, { error: String(err && err.message) });

    if (YA_TTS_KEY) {
      synthesize(text, {
        apiKey: YA_TTS_KEY,
        voice: reqVoice || YA_TTS_VOICE,
        emotion: YA_TTS_EMOTION,
        folderId: YA_TTS_FOLDER || undefined,
      })
        .then((audio) => stream('audio/ogg', audio))
        .catch(fail);
      return;
    }
    if (piperEnabled) {
      const voice = piperVoices.includes(reqVoice) ? reqVoice : PIPER_VOICE || piperVoices[0];
      synthesizePiper(text, {
        bin: PIPER_BIN,
        voicesDir: PIPER_VOICES_DIR,
        libDir: PIPER_LIB_DIR,
        voice,
      })
        .then((audio) => stream('audio/wav', audio))
        .catch(fail);
      return;
    }
    return sendJson(res, 503, { error: 'tts not configured' });
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
  console.log(`ARIA HUD listening on http://127.0.0.1:${HUD_PORT} (group: ${GROUP}, tz: ${TZ})`);
});
