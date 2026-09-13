/** 静默窗口：静默期照常检查但不新增告警；窗口最长 24 小时 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runCheck } from '../src/checker.js';
import {
  activeSilenceWindow,
  addItem,
  addSilenceWindow,
  listAlerts,
  listCheckResults,
} from '../src/repo.js';

function shanghaiNoon(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 4, 0, 0);
}

const HOUR = 3600 * 1000;

test('静默窗口最长 24 小时', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  const itemId = addItem(db, {
    kind: 'domain',
    name: 'a.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-10-01',
    createdAt: t0,
  });

  // 恰好 24 小时：允许
  assert.ok(addSilenceWindow(db, { itemId, startsAt: t0, endsAt: t0 + 24 * HOUR, createdAt: t0 }));
  // 超过 24 小时：拒绝
  assert.throws(
    () => addSilenceWindow(db, { itemId, startsAt: t0, endsAt: t0 + 24 * HOUR + 1, createdAt: t0 }),
    /最长 24 小时/,
  );
  // 结束早于开始：拒绝
  assert.throws(
    () => addSilenceWindow(db, { itemId, startsAt: t0, endsAt: t0, createdAt: t0 }),
    /结束时间必须晚于开始时间/,
  );
  db.close();
});

test('静默期照常检查但不新增告警，窗口结束后恢复告警', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  const itemId = addItem(db, {
    kind: 'domain',
    name: 'finance.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-18', // 5 天后 → 7 天档
    createdAt: t0,
  });
  addSilenceWindow(db, {
    itemId,
    startsAt: t0,
    endsAt: t0 + 2 * HOUR,
    reason: '休假',
    createdAt: t0,
  });

  // 静默期内跑检查：无告警，但检查结果照常落库，且标记 silenced
  assert.ok(activeSilenceWindow(db, itemId, t0 + HOUR));
  const r1 = runCheck(db, t0 + HOUR);
  assert.equal(r1.alertsCreated, 0);
  assert.equal(listAlerts(db).length, 0);
  const results = listCheckResults(db, r1.runId);
  assert.equal(results.length, 1);
  assert.equal(results[0].silenced, 1);
  assert.equal(results[0].alert_created, 0);
  assert.equal(results[0].tier, 7); // 档位照常计算，只是不记告警

  // 窗口结束后重跑：正常记告警
  const r2 = runCheck(db, t0 + 3 * HOUR);
  assert.equal(r2.alertsCreated, 1);
  assert.equal(listAlerts(db).length, 1);
  db.close();
});

test('静默只作用于对应监控项，不影响其他项', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  const a = addItem(db, { kind: 'domain', name: 'a.example.cn', registrar: '阿里云', expiresOn: '2026-09-18', createdAt: t0 });
  addItem(db, { kind: 'domain', name: 'b.example.cn', registrar: '腾讯云', expiresOn: '2026-09-18', createdAt: t0 });
  addSilenceWindow(db, { itemId: a, startsAt: t0, endsAt: t0 + 2 * HOUR, createdAt: t0 });

  const r = runCheck(db, t0 + HOUR);
  assert.equal(r.alertsCreated, 1); // 只有 b 记了告警
  assert.equal(listAlerts(db).length, 1);
  db.close();
});
