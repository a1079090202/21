/**
 * 分组功能：分组标签与按组筛选、组静默（含期间新入组项、到点自动恢复、24h 上限）、
 * 按组到期报表（档位 + 处理状态）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runCheck } from '../src/checker.js';
import {
  ackAlert,
  addGroup,
  addGroupSilenceWindow,
  addItem,
  addSilenceWindow,
  getGroup,
  groupExpiryReport,
  listAlerts,
  listCheckResults,
  listGroupSilenceWindows,
  listItems,
  setItemGroup,
} from '../src/repo.js';
import { daysBetween, shanghaiDate } from '../src/time.js';
import { tierForDaysLeft } from '../src/expiry.js';

/** dateStr 当天上海时间正午对应的 epoch 毫秒（上海 = UTC+8） */
function shanghaiNoon(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 4, 0, 0);
}

const HOUR = 3600 * 1000;

test('分组：建组、录入时打组、列表按组筛选、改派分组', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addGroup(db, { name: 'finance', description: '财务系统', createdAt: t0 });
  assert.ok(getGroup(db, 'finance'));

  const f1 = addItem(db, {
    kind: 'domain',
    name: 'fin1.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-18',
    groupName: 'finance',
    createdAt: t0,
  });
  const web = addItem(db, {
    kind: 'domain',
    name: 'www.example.cn',
    registrar: '腾讯云',
    expiresOn: '2026-09-18',
    createdAt: t0,
  });

  assert.equal(listItems(db, { groupName: 'finance' }).length, 1);
  assert.equal(listItems(db, { groupName: 'web' }).length, 0);
  assert.equal(listItems(db, { groupName: null }).length, 1); // 只有未分组的 www
  assert.equal(listItems(db).length, 2);

  // 把未分组项移入 finance，再移出
  setItemGroup(db, web, 'finance');
  assert.equal(listItems(db, { groupName: 'finance' }).length, 2);
  setItemGroup(db, web, null);
  assert.equal(listItems(db, { groupName: null }).length, 1);
  assert.equal(getItemGroupName(db, f1), 'finance');
  db.close();
});

test('告警列表可按组筛选', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addGroup(db, { name: 'finance', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'fin.example.cn', registrar: '阿里云', expiresOn: '2026-09-18', groupName: 'finance', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'www.example.cn', registrar: '腾讯云', expiresOn: '2026-09-18', createdAt: t0 });
  runCheck(db, t0);

  assert.equal(listAlerts(db).length, 2);
  assert.equal(listAlerts(db, { groupName: 'finance' }).length, 1);
  assert.equal(listAlerts(db, { groupName: null }).length, 1);
  db.close();
});

test('组静默最长 24 小时', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addGroup(db, { name: 'finance', createdAt: t0 });

  assert.ok(addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0 + 24 * HOUR, createdAt: t0 }));
  assert.throws(
    () => addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0 + 24 * HOUR + 1, createdAt: t0 }),
    /最长 24 小时/,
  );
  assert.throws(
    () => addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0, createdAt: t0 }),
    /结束时间必须晚于开始时间/,
  );
  db.close();
});

test('组静默：组内存量项不新增告警但照常留检查记录（标记 group 静默），其他组不受影响', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addGroup(db, { name: 'finance', createdAt: t0 });
  addGroup(db, { name: 'web', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'fin.example.cn', registrar: '阿里云', expiresOn: '2026-09-18', groupName: 'finance', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'www.example.cn', registrar: '腾讯云', expiresOn: '2026-09-18', groupName: 'web', createdAt: t0 });

  addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0 + 24 * HOUR, reason: '财务集体休假', createdAt: t0 });

  const r = runCheck(db, t0 + HOUR);
  assert.equal(r.alertsCreated, 1); // 只有 web 组的项记告警
  const fin = r.outcomes.find((o) => o.itemName === 'fin.example.cn')!;
  assert.equal(fin.silenced, true);
  assert.equal(fin.silenceKind, 'group');
  assert.equal(fin.tier, 7); // 档位照常算
  const www = r.outcomes.find((o) => o.itemName === 'www.example.cn')!;
  assert.equal(www.silenced, false);
  assert.equal(www.alertCreated, true);

  const results = listCheckResults(db, r.runId);
  const finResult = results.find((x) => x.item_id === 1)!;
  assert.equal(finResult.silenced, 1);
  assert.equal(finResult.silence_kind, 'group');
  assert.equal(listAlerts(db, { groupName: 'finance' }).length, 0);
  assert.equal(listGroupSilenceWindows(db, 'finance').length, 1);
  db.close();
});

test('组静默期间新入组的项同样被罩住；退组后立即脱离', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addGroup(db, { name: 'finance', createdAt: t0 });
  // 静默开始时该项还未入组
  const newcomer = addItem(db, {
    kind: 'domain',
    name: 'late.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-18',
    createdAt: t0,
  });
  addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0 + 24 * HOUR, createdAt: t0 });

  // 静默开始 2 小时后才入组
  setItemGroup(db, newcomer, 'finance');
  const r1 = runCheck(db, t0 + 3 * HOUR);
  assert.equal(r1.alertsCreated, 0);
  assert.equal(listAlerts(db).length, 0);

  // 退组后同一次窗口内检查：不再被组静默罩住，正常记告警
  setItemGroup(db, newcomer, null);
  const r2 = runCheck(db, t0 + 4 * HOUR);
  assert.equal(r2.alertsCreated, 1);
  db.close();
});

test('组静默到点自动恢复：窗口结束后下一次检查正常记告警', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addGroup(db, { name: 'finance', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'fin.example.cn', registrar: '阿里云', expiresOn: '2026-09-18', groupName: 'finance', createdAt: t0 });
  addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0 + 24 * HOUR, createdAt: t0 });

  // 窗口最后一刻：仍静默（ends_at 为排他边界，< 判定）
  assert.equal(runCheck(db, t0 + 24 * HOUR - 1).alertsCreated, 0);
  // 到点之后：自动恢复，记告警
  assert.equal(runCheck(db, t0 + 24 * HOUR).alertsCreated, 1);
  assert.equal(listAlerts(db).length, 1);
  db.close();
});

test('单项静默与组静默同时存在时，检查记录标记为 item（单项优先）', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addGroup(db, { name: 'finance', createdAt: t0 });
  const itemId = addItem(db, { kind: 'domain', name: 'fin.example.cn', registrar: '阿里云', expiresOn: '2026-09-18', groupName: 'finance', createdAt: t0 });
  addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0 + 24 * HOUR, createdAt: t0 });
  addSilenceWindow(db, { itemId, startsAt: t0, endsAt: t0 + 2 * HOUR, createdAt: t0 });

  const r = runCheck(db, t0 + HOUR);
  assert.equal(r.alertsCreated, 0);
  assert.equal(listCheckResults(db, r.runId)[0].silence_kind, 'item');
  db.close();
});

test('按组到期报表：档位归并与处理状态（未处理/已确认/未告警）', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  const today = shanghaiDate(t0);
  addGroup(db, { name: 'finance', createdAt: t0 });
  // 5 天 → 7 天档；12 天 → 14 天档；25 天 → 30 天档；40 天 → 档外，不进报表
  addItem(db, { kind: 'domain', name: 'd7.example.cn', registrar: '阿里云', expiresOn: '2026-09-18', groupName: 'finance', createdAt: t0 });
  const d14 = addItem(db, { kind: 'domain', name: 'd14.example.cn', registrar: '阿里云', expiresOn: '2026-09-25', groupName: 'finance', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'd30.example.cn', registrar: '阿里云', expiresOn: '2026-10-08', groupName: 'finance', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'd40.example.cn', registrar: '阿里云', expiresOn: '2026-10-23', groupName: 'finance', createdAt: t0 });
  // 别组的项不混进来
  addGroup(db, { name: 'web', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'www.example.cn', registrar: '腾讯云', expiresOn: '2026-09-18', groupName: 'web', createdAt: t0 });

  // 先给 d14 所在项确认告警的场景：先不静默全量检查产生 open 告警
  runCheck(db, t0);
  // 把 d14 的 14 天档告警确认掉
  const d14Alert = listAlerts(db, { groupName: 'finance' }).find((a) => a.item_id === d14 && a.tier === 14)!;
  assert.ok(d14Alert);
  ackAlert(db, d14Alert.id, '张三', '已安排续费', t0 + HOUR);

  const rows = groupExpiryReport(
    db,
    'finance',
    '2026-10-13', // today+30
    (expiresOn) => daysBetween(today, expiresOn),
    tierForDaysLeft,
  );
  // 档外的 d40 不在；web 组的 www 不在
  assert.deepEqual(rows.map((x) => x.name), ['d7.example.cn', 'd14.example.cn', 'd30.example.cn']);
  const byName = new Map(rows.map((x) => [x.name, x]));
  assert.equal(byName.get('d7.example.cn')!.tier, 7);
  assert.equal(byName.get('d7.example.cn')!.alert_status, 'open');
  assert.equal(byName.get('d14.example.cn')!.tier, 14);
  assert.equal(byName.get('d14.example.cn')!.alert_status, 'acknowledged');
  assert.equal(byName.get('d30.example.cn')!.tier, 30);
  assert.equal(byName.get('d30.example.cn')!.alert_status, 'open');

  // 静默组内新增的项从未产生告警 → 状态 none
  addGroupSilenceWindow(db, { groupName: 'finance', startsAt: t0, endsAt: t0 + 24 * HOUR, createdAt: t0 });
  const silentItem = addItem(db, { kind: 'domain', name: 'muted.example.cn', registrar: '华为云', expiresOn: '2026-09-19', groupName: 'finance', createdAt: t0 });
  runCheck(db, t0 + 2 * HOUR);
  const rows2 = groupExpiryReport(db, 'finance', '2026-10-13', (e) => daysBetween(today, e), tierForDaysLeft);
  assert.equal(rows2.find((x) => x.id === silentItem)!.alert_status, 'none');
  db.close();
});

function getItemGroupName(db: ReturnType<typeof openDb>, id: number): string | null {
  return listItems(db).find((i) => i.id === id)?.group_name ?? null;
}
