/**
 * 数据访问层：所有 SQL 都收在这里。
 */

import type { DB } from './db.js';
import type { Tier } from './expiry.js';

export type ItemKind = 'domain' | 'cert';
export type AlertStatus = 'open' | 'acknowledged';
export type SilenceKind = 'item' | 'group';

export interface Group {
  name: string;
  description: string | null;
  created_at: number;
}

export interface MonitorItem {
  id: number;
  kind: ItemKind;
  name: string;
  registrar: string | null;
  issued_to: string | null;
  expires_on: string;
  note: string | null;
  group_name: string | null;
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
  silence_kind: SilenceKind | null;
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

export interface GroupSilenceWindow {
  id: number;
  group_name: string;
  starts_at: number;
  ends_at: number;
  reason: string | null;
  created_at: number;
}

export const MAX_SILENCE_MS = 24 * 3600 * 1000;

/** better-sqlite3 的唯一约束冲突（组名重复等） */
export function isUniqueConstraint(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

// ---------- 分组 ----------

export function addGroup(db: DB, g: { name: string; description?: string | null; createdAt: number }): void {
  db.prepare('INSERT INTO groups (name, description, created_at) VALUES (?, ?, ?)').run(
    g.name,
    g.description ?? null,
    g.createdAt,
  );
}

export function getGroup(db: DB, name: string): Group | undefined {
  return db.prepare('SELECT * FROM groups WHERE name = ?').get(name) as Group | undefined;
}

export function listGroups(db: DB): Array<Group & { item_count: number }> {
  return db
    .prepare(
      `SELECT g.*, COUNT(i.id) AS item_count
       FROM groups g LEFT JOIN monitor_items i ON i.group_name = g.name
       GROUP BY g.name ORDER BY g.name`,
    )
    .all() as Array<Group & { item_count: number }>;
}

/** 组名规则：小写字母/数字/中划线/下划线，1~32 字符（CLI 参数友好） */
export function isValidGroupName(name: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(name);
}

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
    groupName?: string | null;
    createdAt: number;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO monitor_items (kind, name, registrar, issued_to, expires_on, note, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.kind,
      item.name,
      item.registrar ?? null,
      item.issuedTo ?? null,
      item.expiresOn,
      item.note ?? null,
      item.groupName ?? null,
      item.createdAt,
    );
  return Number(r.lastInsertRowid);
}

export function listItems(db: DB, filter: { groupName?: string | null } = {}): MonitorItem[] {
  if (filter.groupName !== undefined) {
    return db
      .prepare('SELECT * FROM monitor_items WHERE group_name IS ? ORDER BY expires_on, id')
      .all(filter.groupName) as MonitorItem[];
  }
  return db
    .prepare('SELECT * FROM monitor_items ORDER BY expires_on, id')
    .all() as MonitorItem[];
}

export function setItemGroup(db: DB, id: number, groupName: string | null): boolean {
  const r = db.prepare('UPDATE monitor_items SET group_name = ? WHERE id = ?').run(groupName, id);
  return r.changes > 0;
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
    silenceKind?: SilenceKind | null;
    alertCreated: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO check_results (run_id, item_id, check_date, days_left, tier, silenced, silence_kind, alert_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.runId,
    row.itemId,
    row.checkDate,
    row.daysLeft,
    row.tier,
    row.silenced ? 1 : 0,
    row.silenced ? (row.silenceKind ?? 'item') : null,
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
  filter: { tier?: Tier; status?: AlertStatus; groupName?: string | null } = {},
): Array<Alert & { item_name: string; item_kind: ItemKind; item_group: string | null }> {
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
  if (filter.groupName !== undefined) {
    where.push('i.group_name IS ?');
    params.push(filter.groupName);
  }
  const sql = `
    SELECT a.*, i.name AS item_name, i.kind AS item_kind, i.group_name AS item_group
    FROM alerts a JOIN monitor_items i ON i.id = a.item_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.status = 'acknowledged', a.tier, a.raised_date, a.id`;
  return db.prepare(sql).all(...params) as Array<
    Alert & { item_name: string; item_kind: ItemKind; item_group: string | null }
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

// ---------- 分组静默窗口 ----------

export function addGroupSilenceWindow(
  db: DB,
  w: { groupName: string; startsAt: number; endsAt: number; reason?: string | null; createdAt: number },
): number {
  const span = w.endsAt - w.startsAt;
  if (span <= 0) throw new Error('静默窗口结束时间必须晚于开始时间');
  if (span > MAX_SILENCE_MS) throw new Error('静默窗口最长 24 小时');
  const r = db
    .prepare(
      `INSERT INTO group_silence_windows (group_name, starts_at, ends_at, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(w.groupName, w.startsAt, w.endsAt, w.reason ?? null, w.createdAt);
  return Number(r.lastInsertRowid);
}

/** 该时刻覆盖此分组的静默窗口（没有则为 undefined） */
export function activeGroupSilenceWindow(
  db: DB,
  groupName: string,
  nowMs: number,
): GroupSilenceWindow | undefined {
  return db
    .prepare(
      `SELECT * FROM group_silence_windows
       WHERE group_name = ? AND starts_at <= ? AND ends_at > ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(groupName, nowMs, nowMs) as GroupSilenceWindow | undefined;
}

/**
 * 该时刻此监控项是否被"组静默"罩住。
 * 按当前 group_name 实时查——静默期间新入组的项同样命中，退组的项自动脱离。
 */
export function activeGroupSilenceForItem(
  db: DB,
  item: MonitorItem,
  nowMs: number,
): GroupSilenceWindow | undefined {
  if (!item.group_name) return undefined;
  return activeGroupSilenceWindow(db, item.group_name, nowMs);
}

export function listGroupSilenceWindows(db: DB, groupName?: string): GroupSilenceWindow[] {
  if (groupName !== undefined) {
    return db
      .prepare('SELECT * FROM group_silence_windows WHERE group_name = ? ORDER BY id DESC')
      .all(groupName) as GroupSilenceWindow[];
  }
  return db
    .prepare('SELECT * FROM group_silence_windows ORDER BY id DESC')
    .all() as GroupSilenceWindow[];
}

// ---------- 报表 ----------

/** 到期日落在 [fromDate, toDate] 内的监控项（可按组筛选） */
export function itemsExpiringBetween(
  db: DB,
  fromDate: string,
  toDate: string,
  groupName?: string,
): MonitorItem[] {
  if (groupName !== undefined) {
    return db
      .prepare(
        `SELECT * FROM monitor_items
         WHERE expires_on >= ? AND expires_on <= ? AND group_name IS ?
         ORDER BY expires_on, id`,
      )
      .all(fromDate, toDate, groupName) as MonitorItem[];
  }
  return db
    .prepare(
      `SELECT * FROM monitor_items
       WHERE expires_on >= ? AND expires_on <= ?
       ORDER BY expires_on, id`,
    )
    .all(fromDate, toDate) as MonitorItem[];
}

export type ReportAlertStatus = 'open' | 'acknowledged' | 'none';

export interface ExpiryReportRow {
  id: number;
  kind: ItemKind;
  name: string;
  expires_on: string;
  days_left: number;
  tier: Tier;
  /** 该档当前告警状态：未处理 / 已确认 / 未告警（如一直被静默或尚未检查过） */
  alert_status: ReportAlertStatus;
}

/**
 * 按组导出到期报表：到期日不晚于 horizonDate 的项（含已过期，按规则属 7 天档），
 * 每行带档位与"该档最新告警"的处理状态。tier 由 daysLeft 传入分档函数计算。
 */
export function groupExpiryReport(
  db: DB,
  groupName: string,
  horizonDate: string,
  daysLeftOf: (expiresOn: string) => number,
  tierOf: (daysLeft: number) => Tier | null,
): ExpiryReportRow[] {
  const items = db
    .prepare(
      `SELECT * FROM monitor_items
       WHERE group_name = ? AND expires_on <= ?
       ORDER BY expires_on, id`,
    )
    .all(groupName, horizonDate) as MonitorItem[];

  // 该组所有告警一次取回，按 项+档 汇总：有 open 即未处理，否则有 acknowledged 即已确认
  const alerts = db
    .prepare(
      `SELECT a.item_id AS item_id, a.tier AS tier, a.status AS status
       FROM alerts a JOIN monitor_items i ON i.id = a.item_id
       WHERE i.group_name = ?`,
    )
    .all(groupName) as Array<{ item_id: number; tier: Tier; status: AlertStatus }>;
  const statusMap = new Map<string, ReportAlertStatus>();
  for (const a of alerts) {
    const key = `${a.item_id}:${a.tier}`;
    if (a.status === 'open') statusMap.set(key, 'open');
    else if (!statusMap.has(key)) statusMap.set(key, 'acknowledged');
  }

  const rows: ExpiryReportRow[] = [];
  for (const it of items) {
    const daysLeft = daysLeftOf(it.expires_on);
    const tier = tierOf(daysLeft);
    if (tier === null) continue; // 理论上不会出现：expires_on <= 今天+30 ⇒ daysLeft <= 30
    rows.push({
      id: it.id,
      kind: it.kind,
      name: it.name,
      expires_on: it.expires_on,
      days_left: daysLeft,
      tier,
      alert_status: statusMap.get(`${it.id}:${tier}`) ?? 'none',
    });
  }
  return rows;
}
