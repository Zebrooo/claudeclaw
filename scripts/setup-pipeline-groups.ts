#!/usr/bin/env node
/**
 * One-time script to register all pipeline agent groups in the claudeclaw DB.
 * Run: npx tsx scripts/setup-pipeline-groups.ts
 *
 * Required env vars (set before running):
 *   MARNERO_DIR              — absolute path to the marnero project
 *   COFFEESHOP_DIR           — absolute path to the coffeeshop project
 *   CLASSIFIEDS_DIR          — absolute path to the classifieds project
 *   NAILS_DIR                — absolute path to the nails project
 *   AGENT_KEYS_DIR           — absolute path to your agent-keys directory
 *   SUPERPOWERS_SKILLS_PATH  — absolute path to superpowers skills directory
 *
 * IMPORTANT: You must first create each Telegram group, add the bot,
 * and run /chatid in each group to get the JID, then fill in CHAT_IDS below.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import path from 'path'

// ── FILL THESE IN after running /chatid in each Telegram group ────────────────
const CHAT_IDS: Record<string, string> = {
  pipeline_orchestrator: 'tg:REPLACE_ME',
  pipeline_pm:           'tg:REPLACE_ME',
  pipeline_architect:    'tg:REPLACE_ME',
  pipeline_designer:     'tg:REPLACE_ME',
  pipeline_developer:    'tg:REPLACE_ME',
  pipeline_tester:       'tg:REPLACE_ME',
  pipeline_security:     'tg:REPLACE_ME',
  pipeline_analyst:      'tg:REPLACE_ME',
  pipeline_deployer:     'tg:REPLACE_ME',
  pipeline_discovery:    'tg:REPLACE_ME',
}
// ─────────────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return v
}

const DB_PATH = path.join(process.cwd(), 'store/messages.db')
if (!existsSync(DB_PATH)) {
  console.error(`DB not found at ${DB_PATH}. Start claudeclaw once first to initialize the schema.`)
  process.exit(1)
}

const db = new Database(DB_PATH)

const containerConfig = JSON.stringify({
  additionalMounts: [
    { hostPath: requireEnv('MARNERO_DIR'),            containerPath: 'marnero',    readonly: false },
    { hostPath: requireEnv('COFFEESHOP_DIR'),          containerPath: 'coffeeshop', readonly: false },
    { hostPath: requireEnv('CLASSIFIEDS_DIR'),         containerPath: 'classifieds',readonly: false },
    { hostPath: requireEnv('NAILS_DIR'),               containerPath: 'nails',      readonly: false },
    { hostPath: requireEnv('AGENT_KEYS_DIR'),          containerPath: 'agent-keys', readonly: true  },
    { hostPath: requireEnv('SUPERPOWERS_SKILLS_PATH'), containerPath: 'skills',     readonly: true  },
  ],
})

const agentConfig = JSON.stringify({
  model: 'sonnet',
  maxTurns: 60,
})

const groups = [
  { folder: 'pipeline_orchestrator', name: 'Pipeline Orchestrator', isMain: 1 },
  { folder: 'pipeline_pm',           name: 'Pipeline PM',           isMain: 0 },
  { folder: 'pipeline_architect',    name: 'Pipeline Architect',    isMain: 0 },
  { folder: 'pipeline_designer',     name: 'Pipeline Designer',     isMain: 0 },
  { folder: 'pipeline_developer',    name: 'Pipeline Developer',    isMain: 0 },
  { folder: 'pipeline_tester',       name: 'Pipeline Tester',       isMain: 0 },
  { folder: 'pipeline_security',     name: 'Pipeline Security',     isMain: 0 },
  { folder: 'pipeline_analyst',      name: 'Pipeline Analyst',      isMain: 0 },
  { folder: 'pipeline_deployer',     name: 'Pipeline Deployer',     isMain: 0 },
  { folder: 'pipeline_discovery',    name: 'Pipeline Discovery',    isMain: 0 },
]

const insert = db.prepare(`
  INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, agent_config, runtime)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

try {
  for (const group of groups) {
    const jid = CHAT_IDS[group.folder]
    if (jid === 'tg:REPLACE_ME') {
      console.warn(`⚠️  Skipping ${group.folder} — JID not set`)
      continue
    }
    insert.run(jid, group.name, group.folder, '@eremin_claude_bot',
      new Date().toISOString(), containerConfig, 0, group.isMain, agentConfig, null)
    console.log(`✅ Registered ${group.folder} → ${jid}`)
  }
  console.log('\nDone. Restart claudeclaw to pick up new groups.')
} finally {
  db.close()
}
