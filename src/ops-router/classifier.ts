/**
 * ops-router — message classifier.
 *
 * Classifies an inbound message into one of the HUD buckets using a cheap
 * Haiku call via the Claude Agent SDK (the same SDK the agent runner uses).
 * The call runs in-process on the host, which is already authenticated for
 * the `claude` CLI, so no credential proxy is involved.
 *
 * Robustness: any SDK/auth/parse failure falls back to a deterministic
 * heuristic. Classification is best-effort telemetry for the HUD — it must
 * never throw into the ingestion path or affect the bot.
 */
import { logger } from '../orchestrator/logger.js';
import { resolveClaudeCli } from './claude-cli.js';

export type HudKind = 'event' | 'promise' | 'awaiting' | 'task' | 'chatter';

export interface Classification {
  kind: HudKind;
  /** Short HUD-facing title (uppercase-friendly, <= ~48 chars). */
  title: string;
  /** Project / front tag, e.g. "MARNERO", "AURUM". */
  project?: string;
  /** ISO datetime for timed events; null/omitted otherwise. */
  whenISO?: string | null;
  /** True for a protected focus block. */
  protectedBlock?: boolean;
  /** promise = I owe someone (out); awaiting = I wait for someone (in). */
  direction?: 'in' | 'out';
}

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Ты — классификатор входящих сообщений для персонального HUD-дашборда.
По одному сообщению верни СТРОГО один JSON-объект, без markdown, без пояснений.

Поля:
- "kind": одно из "event" | "promise" | "awaiting" | "task" | "chatter"
    event   — есть конкретное время/дата (встреча, дедлайн, блок в расписании)
    promise — я кому-то что-то обещал/должен отдать (исходящее обязательство)
    awaiting— я жду ответа/действия от кого-то (входящее ожидание)
    task    — задача без конкретного времени
    chatter — болтовня/вопрос/команда без сущности для дашборда
- "title": короткий заголовок для HUD (<= 48 символов), на языке сообщения
- "project": тег проекта одним словом ЗАГЛАВНЫМИ, если очевиден, иначе null
- "when": ISO-8601 datetime, если kind=event и время выводимо, иначе null
- "protected": true только если это защищённый блок фокуса
- "direction": "out" для promise, "in" для awaiting, иначе null

Относительное время ("через час", "завтра в 18", "в пятницу") разрешай относительно NOW из промпта.
Возвращай ТОЛЬКО JSON.`;

interface RawClassification {
  kind?: string;
  title?: string;
  project?: string | null;
  when?: string | null;
  protected?: boolean;
  direction?: string | null;
}

function coerce(raw: RawClassification, fallbackTitle: string): Classification {
  const kinds: HudKind[] = ['event', 'promise', 'awaiting', 'task', 'chatter'];
  const kind = kinds.includes(raw.kind as HudKind)
    ? (raw.kind as HudKind)
    : 'task';
  const direction =
    raw.direction === 'in' || raw.direction === 'out'
      ? (raw.direction as 'in' | 'out')
      : kind === 'promise'
        ? 'out'
        : kind === 'awaiting'
          ? 'in'
          : undefined;
  return {
    kind,
    title: (raw.title || fallbackTitle).slice(0, 80),
    project: raw.project ? String(raw.project).toUpperCase().slice(0, 24) : undefined,
    whenISO: raw.when || null,
    protectedBlock: !!raw.protected,
    direction,
  };
}

function extractJson(text: string): RawClassification | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as RawClassification;
  } catch {
    return null;
  }
}

/** Deterministic fallback so the HUD still populates if the LLM is unavailable. */
export function heuristicClassify(text: string): Classification {
  const s = text.toLowerCase();
  const has = (...xs: string[]): boolean => xs.some((x) => s.includes(x));
  const title = text.trim().replace(/\s+/g, ' ').slice(0, 80);

  const hasTime =
    /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(s) ||
    has('завтра', 'сегодня', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье', 'через час', 'через', 'дедлайн', 'встреч', 'созвон', 'митинг');

  if (hasTime) return { kind: 'event', title, whenISO: null };
  if (has('обещал', 'должен отдать', 'отправлю', 'пришлю', 'скину', 'сделаю к', 'надо отдать'))
    return { kind: 'promise', title, direction: 'out' };
  if (has('жду', 'ждём', 'ожидаю', 'когда ответят', 'не ответил', 'ждать ответ'))
    return { kind: 'awaiting', title, direction: 'in' };
  if (has('напомни', 'задача', 'нужно', 'надо', 'todo', 'сделать', 'добавь'))
    return { kind: 'task', title };
  return { kind: 'chatter', title };
}

export async function classifyMessage(text: string): Promise<Classification> {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'chatter', title: '' };

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const now = new Date().toISOString();
    let resultText = '';

    for await (const message of query({
      prompt: `NOW=${now}\n\nСООБЩЕНИЕ:\n${trimmed}`,
      options: {
        model: HAIKU_MODEL,
        maxTurns: 1,
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: [],
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: resolveClaudeCli(),
        env: process.env as Record<string, string>,
      },
    })) {
      if (message.type === 'result' && 'result' in message) {
        resultText = (message as { result?: string }).result || '';
      }
    }

    const raw = extractJson(resultText);
    if (raw) return coerce(raw, trimmed.slice(0, 80));
    logger.debug({ resultText: resultText.slice(0, 120) }, 'ops-router: classifier returned non-JSON, using heuristic');
  } catch (err) {
    logger.debug({ err }, 'ops-router: haiku classifier failed, using heuristic');
  }

  return heuristicClassify(trimmed);
}
