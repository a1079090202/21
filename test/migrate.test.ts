/** 旧库迁移：补列 + 历史 silenced=1 记录的 silence_kind 回填 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { listCheckResults } from '../src/repo.js';

/** 旧版建表语句：monitor_items 无 group_name，check_results 无 silence_kind */
const OLD_SCHEMA = `
CREATE TABLE monitor_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('domain', 'cert')),
  name        TEXT NOT NULL,
  registrar   TEXT,
  issued_to   TEXT,
  expires_on  TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (kind, name)
);
CREATE TABLE check_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date       TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  item_count     INTEGER NOT NULL,
  alerts_created INTEGER NOT NULL
);
CREATE TABLE check_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES check_runs(id),
  item_id       INTEGER NOT NULL REFERENCES monitor_items(id),
  check_date    TEXT NOT NULL,
  days_left     INTEGER NOT NULL,
  tier          INTEGER,
  silenced      INTEGER NOT NULL DEFAULT 0,
  alert_created INTEGER NOT NULL DEFAULT 0
);
`;

function withOldDb(
  extraDdl: string,
  rows: Array<{ silenced: number }>,
  assertRows: (silenceKinds: Array<string | null>) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'expiry-monitor-'));
  try {
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(OLD_SCHEMA + extraDdl);
    old.prepare(`INSERT INTO monitor_items (kind, name, expires_on, created_at) VALUES ('domain', 'a.example.cn', '2026-10-01', 0)`).run();
    old.prepare(`INSERT INTO check_runs (run_date, started_at, item_count, alerts_created) VALUES ('2026-09-01', 0, 1, 0)`).run();
    for (const [i, r] of rows.entries()) {
      old.prepare(
        `INSERT INTO check_results (run_id, item_id, check_date, days_left, tier, silenced, alert_created)
         VALUES (1, 1, '2026-09-0${i + 1}', 30, 30, ${r.silenced}, 0)`,
      ).run();
    }
    old.close();

    const db = openDb(path);
    assertRows(listCheckResults(db, 1).map((r) => r.silence_kind));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('旧库升级：历史 silenced=1 记录回填 silence_kind=item，未静默记录不受影响', () => {
  withOldDb('', [{ silenced: 1 }, { silenced: 0 }], (kinds) => {
    assert.deepEqual(kinds, ['item', null]);
  });
});

test('旧库升级：已被旧版迁移补过列但留下 NULL 的库，再次打开也能回填', () => {
  // 模拟上一版迁移已执行过：silence_kind 列已存在但历史行全是 NULL
  withOldDb(`ALTER TABLE check_results ADD COLUMN silence_kind TEXT;`, [{ silenced: 1 }], (kinds) => {
    assert.deepEqual(kinds, ['item']);
  });
});
