import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from '../orchestrator/db.js';
import { HUD_SCHEMA } from './schema.js';
import { heuristicClassify } from './classifier.js';
import { appendLog, insertAwaiting, insertEvent, upsertFront } from './store.js';

function initHudDb(): void {
  _initTestDatabase();
  for (const sql of HUD_SCHEMA) getDb().exec(sql);
}

describe('heuristicClassify', () => {
  it('detects timed events', () => {
    expect(heuristicClassify('встреча завтра в 15:30 по марнеро').kind).toBe('event');
  });

  it('detects outgoing promises', () => {
    expect(heuristicClassify('я обещал отдать инвойс студии').kind).toBe('promise');
  });

  it('detects incoming awaiting', () => {
    expect(heuristicClassify('жду ответа от юристов по контракту').kind).toBe('awaiting');
  });

  it('detects plain tasks', () => {
    const c = heuristicClassify('напомни купить кофе');
    expect(c.kind).toBe('task');
  });

  it('falls back to chatter', () => {
    expect(heuristicClassify('привет, как дела').kind).toBe('chatter');
  });

  it('truncates long titles', () => {
    const c = heuristicClassify('x'.repeat(200));
    expect(c.title.length).toBeLessThanOrEqual(80);
  });
});

describe('store round-trip', () => {
  beforeEach(initHudDb);

  it('inserts and reads events', () => {
    insertEvent({ title: 'STANDUP', project: 'JOBA', start_ts: '2026-05-27T09:30:00Z' });
    const rows = getDb().prepare('SELECT * FROM hud_events').all() as Array<{
      title: string;
      project: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('STANDUP');
    expect(rows[0].project).toBe('JOBA');
  });

  it('inserts awaiting with direction', () => {
    insertAwaiting({ direction: 'in', who: 'legal redlines', tag: 'JOBB' });
    const row = getDb().prepare('SELECT * FROM hud_awaiting').get() as {
      direction: string;
      resolved: number;
    };
    expect(row.direction).toBe('in');
    expect(row.resolved).toBe(0);
  });

  it('upserts fronts idempotently by key', () => {
    upsertFront('aurum', { name: 'AURUM', pct: 18 });
    upsertFront('aurum', { pct: 25, stalled: true });
    const rows = getDb().prepare('SELECT * FROM hud_fronts').all() as Array<{
      pct: number;
      stalled: number;
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].pct).toBe(25);
    expect(rows[0].stalled).toBe(1);
    expect(rows[0].name).toBe('AURUM');
  });

  it('caps the log at 200 rows', () => {
    for (let i = 0; i < 210; i++) appendLog('sys', `line ${i}`);
    const count = getDb().prepare('SELECT COUNT(*) c FROM hud_log').get() as { c: number };
    expect(count.c).toBe(200);
  });
});
