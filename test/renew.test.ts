/** 续期与告警周期：续期自动确认上一周期 open 告警，新一轮到期各档位重新告警 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runCheck } from '../src/checker.js';
import { addItem, listAlerts, renewItem } from '../src/repo.js';

/** dateStr 当天上海时间正午对应的 epoch 毫秒（上海 = UTC+8） */
function shanghaiNoon(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 4, 0, 0);
}

test('续期结束上一告警周期：旧 open 告警自动确认，新一轮到期重新告警', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  const itemId = addItem(db, {
    kind: 'domain',
    name: 'finance.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-18', // 5 天后 → 7 天档
    createdAt: t0,
  });

  // 第一周期：记 1 条 7 天档 open 告警；用户不 ack，直接在注册商续费
  assert.equal(runCheck(db, t0).alertsCreated, 1);
  assert.equal(listAlerts(db, { status: 'open' }).length, 1);

  // 续期到一年后：到期日更新，旧告警同事务自动确认
  const tRenew = shanghaiNoon('2026-09-14');
  const { renewed, closedAlerts } = renewItem(db, itemId, '2027-09-13', tRenew);
  assert.ok(renewed);
  assert.equal(closedAlerts, 1);
  const oldAlert = listAlerts(db)[0];
  assert.equal(oldAlert.status, 'acknowledged');
  assert.equal(oldAlert.handler, '（续期）');
  assert.equal(oldAlert.handled_at, tRenew);
  assert.equal(listAlerts(db, { status: 'open' }).length, 0);

  // 新一轮到期（2027-09-13 前 5 天）：7 天档重新记一条，不被上一周期旧告警拦截
  const r2 = runCheck(db, shanghaiNoon('2027-09-08'));
  assert.equal(r2.alertsCreated, 1);
  const all = listAlerts(db);
  assert.equal(all.length, 2);
  const newAlert = all.find((a) => a.status === 'open');
  assert.ok(newAlert);
  assert.equal(newAlert.tier, 7);
  assert.equal(newAlert.raised_date, '2027-09-08');

  // 新周期内去重照常：第二天再跑不重复记
  assert.equal(runCheck(db, shanghaiNoon('2027-09-09')).alertsCreated, 0);
  db.close();
});

test('续期时无 open 告警 / 监控项不存在', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-13');
  const itemId = addItem(db, {
    kind: 'domain',
    name: 'a.example.cn',
    registrar: '阿里云',
    expiresOn: '2027-09-01', // 不在任何档位内，无告警
    createdAt: t0,
  });

  // 无 open 告警：正常续期，closedAlerts=0
  assert.deepEqual(renewItem(db, itemId, '2028-09-01', t0), { renewed: true, closedAlerts: 0 });
  // 不存在的 id：renewed=false，不写任何数据
  assert.deepEqual(renewItem(db, 999, '2028-09-01', t0), { renewed: false, closedAlerts: 0 });
  db.close();
});
