/**
 * 数据访问层：所有 SQL 都收在这里。
 */

import type { DB } from './db.js';
import type { Tier } from './expiry.js';

export type ItemKind = 'domain' | 'cert';
export type AlertStatus = 'open' | 'acknowledged';

export interface MonitorItem {
  id: number;
  kind: ItemKind;
  name: string;
  registrar: string | null;
  issued_to: string | null;
  expires_on: string;
  note: string | null;
  created_at: number;
}

export interface Alert {
  id: number;
  item_id: number;
  tier: Tier;
  raised_date: string;
  raised_at: number;
  status: AlertStatus;
  handler: string | null;
  handle_note: string | null;
  handled_at: number | null;
}

export interface CheckRun {
  id: number;
  run_date: string;
  started_at: number;
  item_count: number;
  alerts_created: number;
}

export interface CheckResult {
  id: number;
  run_id: number;
  item_id: number;
  check_date: string;
  days_left: number;
  tier: Tier | null;
  silenced: number;
  alert_created: number;
}

export interface SilenceWindow {
  id: number;
  item_id: number;
  starts_at: number;
  ends_at: number;
  reason: string | null;
  created_at: number;
}

export const MAX_SILENCE_MS = 24 * 3600 * 1000;

// ---------- 监控项 ----------

export function addItem(
  db: DB,
  item: {
    kind: ItemKind;
    name: string;
    registrar?: string | null;
    issuedTo?: string | null;
    expiresOn: string;
    note?: string | null;
    createdAt: number;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO monitor_items (kind, name, registrar, issued_to, expires_on, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.kind,
      item.name,
      item.registrar ?? null,
      item.issuedTo ?? null,
      item.expiresOn,
      item.note ?? null,
      item.createdAt,
    );
  return Number(r.lastInsertRowid);
}

export function listItems(db: DB): MonitorItem[] {
  return db
    .prepare('SELECT * FROM monitor_items ORDER BY expires_on, id')
    .all() as MonitorItem[];
}

export function getItem(db: DB, id: number): MonitorItem | undefined {
  return db.prepare('SELECT * FROM monitor_items WHERE id = ?').get(id) as
    | MonitorItem
    | undefined;
}

export function updateExpiresOn(db: DB, id: number, expiresOn: string): boolean {
  const r = db
    .prepare('UPDATE monitor_items SET expires_on = ? WHERE id = ?')
    .run(expiresOn, id);
  return r.changes > 0;
}

// ---------- 检查历史（只追加） ----------

export function insertCheckRun(
  db: DB,
  run: { runDate: string; startedAt: number; itemCount: number; alertsCreated: number },
): number {
  const r = db
    .prepare(
      `INSERT INTO check_runs (run_date, started_at, item_count, alerts_created)
       VALUES (?, ?, ?, ?)`,
    )
    .run(run.runDate, run.startedAt, run.itemCount, run.alertsCreated);
  return Number(r.lastInsertRowid);
}

export function insertCheckResult(
  db: DB,
  row: {
    runId: number;
    itemId: number;
    checkDate: string;
    daysLeft: number;
    tier: Tier | null;
    silenced: boolean;
    alertCreated: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO check_results (run_id, item_id, check_date, days_left, tier, silenced, alert_created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.runId,
    row.itemId,
    row.checkDate,
    row.daysLeft,
    row.tier,
    row.silenced ? 1 : 0,
    row.alertCreated ? 1 : 0,
  );
}

export function listCheckRuns(db: DB, limit = 20): CheckRun[] {
  return db
    .prepare('SELECT * FROM check_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as CheckRun[];
}

export function listCheckResults(db: DB, runId: number): CheckResult[] {
  return db
    .prepare('SELECT * FROM check_results WHERE run_id = ? ORDER BY id')
    .all(runId) as CheckResult[];
}

// ---------- 告警 ----------

/** 某监控项当前处于 open 状态的告警档位 */
export function openAlertTiers(db: DB, itemId: number): Tier[] {
  const rows = db
    .prepare("SELECT tier FROM alerts WHERE item_id = ? AND status = 'open'")
    .all(itemId) as Array<{ tier: Tier }>;
  return rows.map((r) => r.tier);
}

export function insertAlert(
  db: DB,
  alert: { itemId: number; tier: Tier; raisedDate: string; raisedAt: number },
): number {
  const r = db
    .prepare(
      `INSERT INTO alerts (item_id, tier, raised_date, raised_at) VALUES (?, ?, ?, ?)`,
    )
    .run(alert.itemId, alert.tier, alert.raisedDate, alert.raisedAt);
  return Number(r.lastInsertRowid);
}

export function listAlerts(
  db: DB,
  filter: { tier?: Tier; status?: AlertStatus } = {},
): Array<Alert & { item_name: string; item_kind: ItemKind }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.tier !== undefined) {
    where.push('a.tier = ?');
    params.push(filter.tier);
  }
  if (filter.status !== undefined) {
    where.push('a.status = ?');
    params.push(filter.status);
  }
  const sql = `
    SELECT a.*, i.name AS item_name, i.kind AS item_kind
    FROM alerts a JOIN monitor_items i ON i.id = a.item_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.status = 'acknowledged', a.tier, a.raised_date, a.id`;
  return db.prepare(sql).all(...params) as Array<
    Alert & { item_name: string; item_kind: ItemKind }
  >;
}

export function getAlert(db: DB, id: number): Alert | undefined {
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as
    | Alert
    | undefined;
}

export function ackAlert(
  db: DB,
  id: number,
  handler: string,
  note: string,
  handledAt: number,
): boolean {
  const r = db
    .prepare(
      `UPDATE alerts
       SET status = 'acknowledged', handler = ?, handle_note = ?, handled_at = ?
       WHERE id = ? AND status = 'open'`,
    )
    .run(handler, note, handledAt, id);
  return r.changes > 0;
}

// ---------- 静默窗口 ----------

export function addSilenceWindow(
  db: DB,
  w: { itemId: number; startsAt: number; endsAt: number; reason?: string | null; createdAt: number },
): number {
  const span = w.endsAt - w.startsAt;
  if (span <= 0) throw new Error('静默窗口结束时间必须晚于开始时间');
  if (span > MAX_SILENCE_MS) throw new Error('静默窗口最长 24 小时');
  const r = db
    .prepare(
      `INSERT INTO silence_windows (item_id, starts_at, ends_at, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(w.itemId, w.startsAt, w.endsAt, w.reason ?? null, w.createdAt);
  return Number(r.lastInsertRowid);
}

/** 该时刻覆盖此监控项的静默窗口（没有则为 undefined） */
export function activeSilenceWindow(
  db: DB,
  itemId: number,
  nowMs: number,
): SilenceWindow | undefined {
  return db
    .prepare(
      `SELECT * FROM silence_windows
       WHERE item_id = ? AND starts_at <= ? AND ends_at > ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(itemId, nowMs, nowMs) as SilenceWindow | undefined;
}

export function listSilenceWindows(db: DB, itemId?: number): SilenceWindow[] {
  if (itemId !== undefined) {
    return db
      .prepare('SELECT * FROM silence_windows WHERE item_id = ? ORDER BY id DESC')
      .all(itemId) as SilenceWindow[];
  }
  return db
    .prepare('SELECT * FROM silence_windows ORDER BY id DESC')
    .all() as SilenceWindow[];
}

// ---------- 报表 ----------

/** 到期日落在 [fromDate, toDate] 内的监控项 */
export function itemsExpiringBetween(
  db: DB,
  fromDate: string,
  toDate: string,
): MonitorItem[] {
  return db
    .prepare(
      `SELECT * FROM monitor_items
       WHERE expires_on >= ? AND expires_on <= ?
       ORDER BY expires_on, id`,
    )
    .all(fromDate, toDate) as MonitorItem[];
}
