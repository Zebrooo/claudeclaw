import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from '../orchestrator/db.js';
import { HUD_SCHEMA } from './schema.js';
import { detectWork, heuristicClassify } from './classifier.js';
import { appendLog, getWorks, insertEvent, insertTask } from './store.js';

function initHudDb(): void {
  _initTestDatabase();
  for (const sql of HUD_SCHEMA) getDb().exec(sql);
}

const WORKS = [
  { key: 'yandex', label: 'YANDEX', hints: ['yandex', 'яндекс'] },
  { key: 'enspire', label: 'ENSPIRE', hints: ['enspire', 'azure', '.net'] },
];

describe('detectWork', () => {
  it('matches a configured area by hint', () => {
    expect(detectWork('задача по яндекс маркету', WORKS)).toBe('yandex');
    expect(detectWork('починить .NET сервис', WORKS)).toBe('enspire');
  });
  it('falls back to other', () => {
    expect(detectWork('купить кофе', WORKS)).toBe('other');
  });
  it('is empty-safe', () => {
    expect(detectWork('что угодно', [])).toBe('other');
  });
});

describe('heuristicClassify', () => {
  it('detects timed events', () => {
    expect(heuristicClassify('встреча завтра в 15:30').kind).toBe('event');
  });
  it('tags work area when provided', () => {
    const c = heuristicClassify('напомни про релиз в яндексе', WORKS);
    expect(c.kind).toBe('task');
    expect(c.work).toBe('yandex');
  });
  it('defaults work to other', () => {
    expect(heuristicClassify('напомни купить кофе').work).toBe('other');
  });
  it('falls back to chatter', () => {
    expect(heuristicClassify('привет, как дела').kind).toBe('chatter');
  });
});

describe('store round-trip', () => {
  beforeEach(initHudDb);

  it('seeds default work areas', () => {
    const works = getWorks();
    expect(works.map((w) => w.key)).toEqual(['yandex', 'enspire']);
    expect(works[0].hints).toContain('яндекс');
  });

  it('inserts and groups tasks by work', () => {
    insertTask({ work: 'yandex', title: 'billing API', project: 'YA', kind: 'task' });
    insertTask({ work: 'other', title: 'афиши', kind: 'task' });
    const rows = getDb()
      .prepare('SELECT work, title FROM hud_tasks WHERE done = 0 ORDER BY id')
      .all() as Array<{ work: string; title: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].work).toBe('yandex');
  });

  it('inserts and reads events', () => {
    insertEvent({ title: 'STANDUP', project: 'YA', start_ts: '2026-05-27T09:30:00+03:00' });
    const row = getDb().prepare('SELECT title FROM hud_events').get() as { title: string };
    expect(row.title).toBe('STANDUP');
  });

  it('caps the log at 200 rows', () => {
    for (let i = 0; i < 210; i++) appendLog('sys', `line ${i}`);
    const count = getDb().prepare('SELECT COUNT(*) c FROM hud_log').get() as { c: number };
    expect(count.c).toBe(200);
  });
});
