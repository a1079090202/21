/** 跨月/跨年边界 + Asia/Shanghai 日期判定 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runCheck } from '../src/checker.js';
import { addItem, listAlerts, listCheckResults } from '../src/repo.js';
import { addDays, daysBetween, shanghaiDate } from '../src/time.js';

function shanghaiNoon(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 4, 0, 0);
}

test('"哪一天"按 Asia/Shanghai 判定，不用 UTC', () => {
  // 2026-09-30 15:59 UTC = 上海 9/30 23:59 → 仍是 9/30
  assert.equal(shanghaiDate(Date.UTC(2026, 8, 30, 15, 59, 59)), '2026-09-30');
  // 2026-09-30 16:00 UTC = 上海 10/1 00:00 → 已经是 10/1
  assert.equal(shanghaiDate(Date.UTC(2026, 8, 30, 16, 0, 0)), '2026-10-01');
});

test('天数差跨月/跨年/跨闰年计算正确', () => {
  assert.equal(daysBetween('2026-01-31', '2026-02-05'), 5); // 1 月 31 天
  assert.equal(daysBetween('2026-02-28', '2026-03-02'), 2); // 2026 非闰年
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2); // 2024 闰年，2/29 存在
  assert.equal(daysBetween('2026-12-30', '2027-01-05'), 6); // 跨年
  assert.equal(daysBetween('2026-09-13', '2026-09-13'), 0);
  assert.equal(daysBetween('2026-09-13', '2026-09-10'), -3); // 已过期为负
  assert.equal(addDays('2026-09-28', 5), '2026-10-03');
});

test('跨月检查：9 月底跑出的剩余天数和档位正确', () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-28');
  addItem(db, {
    kind: 'domain',
    name: 'cross-month.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-10-05', // 距 9/28 正好 7 天 → 7 天档
    createdAt: t0,
  });
  addItem(db, {
    kind: 'cert',
    name: 'cross-month-tls',
    issuedTo: 'cms.example.cn',
    expiresOn: '2026-10-12', // 距 9/28 正好 14 天 → 14 天档
    createdAt: t0,
  });

  const r = runCheck(db, t0);
  assert.equal(r.runDate, '2026-09-28');
  assert.equal(r.alertsCreated, 2);

  const results = listCheckResults(db, r.runId);
  assert.deepEqual(
    results.map((x) => [x.days_left, x.tier]),
    [
      [7, 7],
      [14, 14],
    ],
  );
  assert.deepEqual(listAlerts(db).map((a) => a.tier).sort((a, b) => a - b), [7, 14]);
  db.close();
});

test('跨月当天边界：上海时间 10/1 凌晨检查，9/30 到期的项按已过期算', () => {
  const db = openDb(':memory:');
  // 上海 2026-10-01 00:30 = UTC 2026-09-30 16:30
  const now = Date.UTC(2026, 8, 30, 16, 30, 0);
  addItem(db, {
    kind: 'domain',
    name: 'expired.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-30',
    createdAt: now,
  });

  const r = runCheck(db, now);
  assert.equal(r.runDate, '2026-10-01'); // 按上海日期记
  const results = listCheckResults(db, r.runId);
  assert.equal(results[0].days_left, -1); // 已过期 1 天
  assert.equal(results[0].tier, 7);
  db.close();
});
