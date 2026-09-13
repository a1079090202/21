/**
 * SQLite 打开与建表。
 *
 * 单文件库（默认 ./data/monitor.db，可用环境变量 MONITOR_DB 覆盖），
 * 不开 WAL：任何非写入时刻整个 .db 文件直接拷走就是一致备份。
 * 检查历史（check_runs / check_results）只 INSERT，不 UPDATE/DELETE。
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_DB_PATH = process.env.MONITOR_DB ?? './data/monitor.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monitor_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('domain', 'cert')),
  name        TEXT NOT NULL,
  registrar   TEXT,                -- 域名：注册商
  issued_to   TEXT,                -- 证书：签发对象
  expires_on  TEXT NOT NULL,       -- 到期日 'YYYY-MM-DD'（证书为有效期止）
  note        TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE IF NOT EXISTS check_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date       TEXT NOT NULL,    -- 本次检查对应的上海日期
  started_at     INTEGER NOT NULL, -- epoch 毫秒
  item_count     INTEGER NOT NULL,
  alerts_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS check_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES check_runs(id),
  item_id       INTEGER NOT NULL REFERENCES monitor_items(id),
  check_date    TEXT NOT NULL,
  days_left     INTEGER NOT NULL,
  tier          INTEGER,           -- 命中档位 30/14/7，未命中为 NULL
  silenced      INTEGER NOT NULL DEFAULT 0,
  alert_created INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES monitor_items(id),
  tier        INTEGER NOT NULL CHECK (tier IN (30, 14, 7)),
  raised_date TEXT NOT NULL,       -- 首次记录告警的上海日期
  raised_at   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged')),
  handler     TEXT,
  handle_note TEXT,
  handled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_item_status ON alerts(item_id, tier, status);

CREATE TABLE IF NOT EXISTS silence_windows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES monitor_items(id),
  starts_at  INTEGER NOT NULL,     -- epoch 毫秒
  ends_at    INTEGER NOT NULL,     -- epoch 毫秒
  reason     TEXT,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= 86400000)  -- 静默窗口最长 24 小时
);
CREATE INDEX IF NOT EXISTS idx_silence_item ON silence_windows(item_id, starts_at, ends_at);
`;

export type DB = Database.Database;

export function openDb(path: string = DEFAULT_DB_PATH): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
