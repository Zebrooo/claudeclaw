# ARIA Command Center (HUD)

A dark, Jarvis-style HUD that is the "face" of the claudeclaw Telegram bot.
You throw tasks at the bot in Telegram; the dashboard shows your day timeline,
active fronts (projects) and the "awaiting / promised" list — live, from the
bot's real data — and lets you command the bot straight from the web console.

## How it fits together

```
Telegram ──▶ claudeclaw (message loop)
                  │
                  ├─ ops-router extension (in-process, additive)
                  │     postIngest: classify inbound (Haiku) → hud_* tables + log
                  │     postRoute : log the bot's replies
                  │
                  └─ store/messages.db  ◀── read-only ── ARIA HUD server (hud/server.mjs)
                                                              │  GET /api/state  → panels
ARIA web console ── POST /api/command ──▶ claudeclaw webhook ─┘  (HMAC-signed; web == Telegram)
```

Two additive, reversible pieces:

- **`src/ops-router/`** — a built-in claudeclaw extension (registered via one
  import in `src/service.ts`). It only *observes* the message flow:
  - classifies inbound `telegram_main` messages with a cheap Haiku call
    (Claude Agent SDK; deterministic heuristic fallback if it fails),
  - writes `hud_events` / `hud_awaiting` and a console `hud_log`,
  - logs the bot's outbound replies.
  It never drops or modifies messages — if it breaks, the bot is unaffected.

- **`hud/`** — a standalone Node server (no extra deps beyond what claudeclaw
  already has). It reads `store/messages.db` **read-only** for the panels and
  forwards console commands to the **existing** claudeclaw webhook, signed with
  `WEBHOOK_SECRET`. Typing in the web console is identical to messaging the bot;
  the bot's reply shows up in the HUD log within a few seconds.

## Data model (tables in `store/messages.db`)

| table          | panel               | key columns |
|----------------|---------------------|-------------|
| `hud_events`   | DAY TIMELINE        | `title, project, start_ts, end_ts, protected` |
| `hud_fronts`   | ACTIVE FRONTS       | `key, name, pct, meta, stalled` |
| `hud_awaiting` | AWAITING RESPONSE   | `direction (in/out), who, tag, created_at, resolved` |
| `hud_log`      | command console log | `ts, role (you/aria/sys/alert), text` |

`fronts` are seeded with your real active projects (edit pct/meta directly in
the table as projects progress). `events` and `awaiting` are populated live by
the classifier; the timeline also merges active `scheduled_tasks` (cron) whose
next run is today.

## Configuration (claudeclaw `.env`)

```
WEBHOOK_PORT=3105          # MUST be a free port — 3100 is used by another app here
WEBHOOK_SECRET=<random>     # enables the claudeclaw webhook + signs HUD commands
HUD_PORT=3200
HUD_TOKEN=<random>          # gate for the HUD page + API
HUD_GROUP_FOLDER=telegram_main
```

> The webhook bind is non-fatal: if `WEBHOOK_PORT` is occupied the bot logs a
> warning and keeps running (the web console just won't reach it). Pick a free
> port and restart.

## Run

```bash
# 1. build claudeclaw (compiles ops-router into dist/)
npm run build

# 2. restart the bot so it loads ops-router, creates the hud_* tables,
#    and starts the webhook (needs WEBHOOK_SECRET)
sudo systemctl restart claudeclaw

# 3. run the HUD server (foreground)
node hud/server.mjs
#    → http://127.0.0.1:3200   (open with ?key=<HUD_TOKEN>)
```

### As a service + public tunnel

```bash
sudo cp hud/deploy/aria-hud.service /etc/systemd/system/aria-hud.service
sudo systemctl daemon-reload && sudo systemctl enable --now aria-hud

# Cloudflare tunnel (see hud/deploy/aria.cloudflared.yml for the template)
cloudflared tunnel create aria
cloudflared tunnel route dns aria aria.eremin.site
cp hud/deploy/aria.cloudflared.yml ~/.cloudflared/aria.yml   # fill in <TUNNEL_ID>
cloudflared tunnel --config ~/.cloudflared/aria.yml run
```

Open: `https://aria.eremin.site/?key=<HUD_TOKEN>` (sets a cookie; later visits
don't need the key).

## Notes

- The Haiku classifier spawns the `claude` CLI per message (~15–20 s cold).
  It runs asynchronously, so the raw line appears in the console log instantly
  and the classified panel entry follows a few seconds later.
- The HUD server only ever **reads** the DB; all writes go through claudeclaw.
- Removing the feature: drop the `ops-router` import from `src/service.ts`,
  delete `src/ops-router/` and `hud/`. The `hud_*` tables are inert if unused.
```
