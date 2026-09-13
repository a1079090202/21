/** 重复告警拦截（集成：内存库跑完整检查流程） */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runCheck } from '../src/checker.js';
import { ackAlert, addItem, listAlerts, listCheckResults, listCheckRuns } from '../src/repo.js';

/** dateStr 当天上海时间正午对应的 epoch 毫秒（上海 = UTC+8） */
function shanghaiNoon(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 4, 0, 0);
}

const HOUR = 3600 * 1000;

test('同一条告警未确认前不重复记录；确认后再次命中会重新记', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  addItem(db, {
    kind: 'domain',
    name: 'finance.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-18', // 5 天后 → 7 天档
    createdAt: t0,
  });

  // 第一次检查：记 1 条 7 天档告警
  const r1 = runCheck(db, t0);
  assert.equal(r1.alertsCreated, 1);
  assert.equal(listAlerts(db).length, 1);
  assert.equal(listAlerts(db)[0].tier, 7);

  // 当天再跑、第二天再跑：都不重复记
  assert.equal(runCheck(db, t0 + HOUR).alertsCreated, 0);
  assert.equal(runCheck(db, shanghaiNoon('2026-09-14')).alertsCreated, 0);
  assert.equal(listAlerts(db).length, 1);

  // 确认后再次命中同档：重新记一条
  assert.ok(ackAlert(db, 1, '张三', '已续费', t0 + 2 * HOUR));
  const r4 = runCheck(db, shanghaiNoon('2026-09-15'));
  assert.equal(r4.alertsCreated, 1);
  const all = listAlerts(db);
  assert.equal(all.length, 2);
  assert.equal(listAlerts(db, { status: 'open' }).length, 1);
  assert.equal(listAlerts(db, { status: 'acknowledged' }).length, 1);

  // 检查历史只追加：4 次检查 = 4 条 run、每条 1 条 result
  assert.equal(listCheckRuns(db).length, 4);
  for (const run of listCheckRuns(db)) {
    assert.equal(listCheckResults(db, run.id).length, 1);
  }
  db.close();
});

test('临近到期档位升级：14 天档和 7 天档各记一条', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-01');
  addItem(db, {
    kind: 'cert',
    name: 'api-tls',
    issuedTo: 'api.example.cn',
    expiresOn: '2026-09-14',
    createdAt: t0,
  });

  // 9/1：剩 13 天 → 14 天档
  assert.equal(runCheck(db, t0).alertsCreated, 1);
  // 9/8：剩 6 天 → 升级为 7 天档，再记一条
  assert.equal(runCheck(db, shanghaiNoon('2026-09-08')).alertsCreated, 1);
  // 9/9：仍是 7 天档且未确认 → 不重复
  assert.equal(runCheck(db, shanghaiNoon('2026-09-09')).alertsCreated, 0);

  const tiers = listAlerts(db).map((a) => a.tier).sort((a, b) => a - b);
  assert.deepEqual(tiers, [7, 14]);
  db.close();
});
