/**
 * 每日检查可靠性：启动/巡检补跑、失败重试、进程内防重入、跨午夜。
 *
 * 全部用显式注入的 nowMs / 假 sleep（记录参数后立即 resolve），不用真实定时器。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runCheck, type RunSummary } from '../src/checker.js';
import { ensureDailyCheck, createDailyGate } from '../src/daily.js';
import { withRetry } from '../src/retry.js';
import {
  addItem,
  hasCheckRunOnDate,
  listCheckResults,
  listCheckRuns,
} from '../src/repo.js';
import { shanghaiDate } from '../src/time.js';

/** dateStr 当天上海时间正午对应的 epoch 毫秒（上海 = UTC+8） */
function shanghaiNoon(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 4, 0, 0);
}

/** 记录每次睡眠毫秒后立即放行的假 sleep */
function fakeSleep(): { sleep: (ms: number) => void; calls: number[] } {
  const calls: number[] = [];
  return { sleep: (ms: number) => void calls.push(ms), calls };
}

test('补跑：当天无成功记录 → 立即跑一次，恰好落 1 条 run 且每一项 1 条 result', async () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-14');
  addItem(db, {
    kind: 'domain',
    name: 'a.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-19', // 5 天后 → 7 天档
    createdAt: t0,
  });

  const r = await ensureDailyCheck(db, t0);
  assert.equal(r.status, 'ran');
  if (r.status !== 'ran') throw new Error('类型收窄');
  assert.equal(r.attempts, 1);
  assert.equal(r.date, '2026-09-14');
  assert.equal(r.summary.runId, 1);

  const runs = listCheckRuns(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_date, '2026-09-14');
  assert.equal(listCheckResults(db, runs[0].id).length, 1);
  db.close();
});

test('跳过：当天已有成功记录 → skipped，注入的 runCheck 零调用、行数不增', async () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-14');
  runCheck(db, t0);

  let calls = 0;
  const r = await ensureDailyCheck(db, t0, { runCheck: () => (calls++, runCheck(db, t0)) });
  assert.equal(r.status, 'skipped');
  if (r.status !== 'skipped') throw new Error('类型收窄');
  assert.equal(r.attempts, 1);
  assert.equal(calls, 0);
  assert.equal(listCheckRuns(db).length, 1);
  db.close();
});

test('手动 check run 落的行同样算作"今日已检"（EXISTS 不区分来源）', async () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-14');
  // 模拟运维用 CLI 手动跑了一次，守护进程默认依赖（真 runCheck）也不应再跑
  runCheck(db, t0);
  assert.ok(hasCheckRunOnDate(db, '2026-09-14'));

  const r = await ensureDailyCheck(db, t0);
  assert.equal(r.status, 'skipped');
  assert.equal(listCheckRuns(db).length, 1);
  db.close();
});

test('隔天：昨天的记录不顶今天，补跑落 run_date=今天', async () => {
  const db = openDb(':memory:');
  runCheck(db, shanghaiNoon('2026-09-13'));
  const today = shanghaiNoon('2026-09-14');

  const r = await ensureDailyCheck(db, today);
  assert.equal(r.status, 'ran');
  if (r.status !== 'ran') throw new Error('类型收窄');
  assert.equal(r.date, '2026-09-14');
  const runs = listCheckRuns(db);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].run_date, '2026-09-14'); // ORDER BY id DESC
  db.close();
});

test('失败重试：前两次抛错第三次成功 → attempts=3、sleep 参数 [10,20]、只落 1 条 run', async () => {
  const db = openDb(':memory:');
  addItem(db, {
    kind: 'domain',
    name: 'a.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-19',
    createdAt: 0,
  });
  const t0 = shanghaiNoon('2026-09-14');
  const waiter = fakeSleep();
  let calls = 0;
  const r = await ensureDailyCheck(db, t0, {
    runCheck: (ms) => {
      calls++;
      if (calls < 3) throw new Error(`transient ${calls}`);
      return runCheck(db, ms); // 事务原子性：前两次抛错零写入
    },
    retry: { delaysMs: [10, 20], sleep: waiter.sleep },
  });
  assert.equal(r.status, 'ran');
  if (r.status !== 'ran') throw new Error('类型收窄');
  assert.equal(r.attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(waiter.calls, [10, 20]);
  assert.equal(listCheckRuns(db).length, 1);
  assert.equal(listCheckResults(db, r.summary.runId).length, 1);
  db.close();
});

test('重试耗尽：恒失败 → failed、原样返回最后一个错误、零写入；下一轮换成功后正常 ran', async () => {
  const db = openDb(':memory:');
  addItem(db, {
    kind: 'domain',
    name: 'a.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-19',
    createdAt: 0,
  });
  const t0 = shanghaiNoon('2026-09-14');
  const waiter = fakeSleep();
  const failures: Array<{ attempt: number; nextDelayMs: number | null }> = [];
  const lastError = new Error('disk gone');

  const r = await ensureDailyCheck(db, t0, {
    runCheck: () => {
      throw lastError;
    },
    retry: {
      delaysMs: [10, 20, 30],
      sleep: waiter.sleep,
      onFailure: (info) => failures.push({ attempt: info.attempt, nextDelayMs: info.nextDelayMs }),
    },
  });
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') throw new Error('类型收窄');
  assert.equal(r.attempts, 4);
  assert.equal(r.error, lastError); // 原样抛出，不包自定义错误
  assert.deepEqual(waiter.calls, [10, 20, 30]);
  assert.deepEqual(failures, [
    { attempt: 1, nextDelayMs: 10 },
    { attempt: 2, nextDelayMs: 20 },
    { attempt: 3, nextDelayMs: 30 },
    { attempt: 4, nextDelayMs: null },
  ]);
  // 单事务回滚：失败不留任何检查记录
  assert.equal(listCheckRuns(db).length, 0);

  // 故障恢复后（如下一次整点巡检）全新预算再跑
  const r2 = await ensureDailyCheck(db, t0, { retry: { delaysMs: [10], sleep: waiter.sleep } });
  assert.equal(r2.status, 'ran');
  assert.equal(listCheckRuns(db).length, 1);
  db.close();
});

test('防重入：第一个检查在途时，第二次 ensure 立即 busy 且不再调用 runCheck', async () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-14');

  let calls = 0;
  let release: (s: RunSummary) => void = () => {};
  // 在途期间台账始终为"没跑过"，保证 fake runCheck 真的被调起并挂住
  let alreadyRan = false;
  const gate = createDailyGate(db, {
    hasRun: () => alreadyRan,
    runCheck: () => {
      calls++;
      return new Promise<RunSummary>((resolve) => {
        release = resolve;
      });
    },
  });

  const p1 = gate.ensure(t0);
  await new Promise((resolve) => setImmediate(resolve)); // 让在途 fn 实际启动
  assert.equal(gate.inFlight, true);

  const busy = await gate.ensure(t0 + 999_999);
  assert.deepEqual(busy, { status: 'busy' });
  assert.equal(calls, 1);

  // 释放前检查真正落库（模拟该次在途成功），再让在途 Promise 结束
  const summary: RunSummary = runCheck(db, t0);
  alreadyRan = true;
  release(summary);
  const r1 = await p1;
  assert.equal(r1.status, 'ran');
  assert.equal(gate.inFlight, false);

  // 在途结束后再来：当天已有记录 → skipped，fake runCheck 仍只被调过 1 次
  const r3 = await gate.ensure(t0);
  assert.equal(r3.status, 'skipped');
  assert.equal(calls, 1);
  db.close();
});

test('重试睡眠期间被外部（CLI 手动 check run）补齐 → 下次尝试直接 skipped，不再跑 runCheck', async () => {
  const db = openDb(':memory:');
  addItem(db, {
    kind: 'domain',
    name: 'a.example.cn',
    registrar: '阿里云',
    expiresOn: '2026-09-19',
    createdAt: 0,
  });
  const t0 = shanghaiNoon('2026-09-14');
  let calls = 0;
  const sleeps: number[] = [];
  const r = await ensureDailyCheck(db, t0, {
    runCheck: () => {
      calls++;
      throw new Error('transient');
    },
    retry: {
      delaysMs: [10, 20],
      // 第一次睡眠期间，运维手动补齐了当天检查
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) runCheck(db, t0 + 60_000);
      },
    },
  });
  assert.equal(r.status, 'skipped');
  if (r.status !== 'skipped') throw new Error('类型收窄');
  assert.equal(r.attempts, 2);
  assert.equal(calls, 1); // 第二次尝试闭包重检命中，未再调用 runCheck
  assert.deepEqual(sleeps, [10]);
  assert.equal(listCheckRuns(db).length, 1);
  db.close();
});

test('跨上海午夜：23:59 失败、00:20 重试成功 → 为次日落一条 run', async () => {
  const db = openDb(':memory:');
  // 上海 2026-09-14 23:59 = UTC 15:59；上海 2026-09-15 00:20 = UTC 16:20
  const night = Date.UTC(2026, 8, 14, 15, 59, 0);
  const nextMorning = Date.UTC(2026, 8, 14, 16, 20, 0);
  assert.equal(shanghaiDate(night), '2026-09-14');
  assert.equal(shanghaiDate(nextMorning), '2026-09-15');

  const waiter = fakeSleep();
  const r = await ensureDailyCheck(db, night, {
    now: () => nextMorning,
    runCheck: (ms) => {
      if (ms === night) throw new Error('transient');
      return runCheck(db, ms);
    },
    retry: { delaysMs: [10], sleep: waiter.sleep },
  });
  assert.equal(r.status, 'ran');
  if (r.status !== 'ran') throw new Error('类型收窄');
  assert.equal(r.date, '2026-09-15');
  assert.equal(listCheckRuns(db)[0].run_date, '2026-09-15');
  db.close();
});

test('withRetry 纯单测：成功不睡；失败按序睡眠；耗尽时抛最后错误且末轮 nextDelayMs=null', async () => {
  // 一次成功：不睡眠
  const okSleep = fakeSleep();
  let okCalls = 0;
  const v = await withRetry(
    () => (okCalls++, 'done'),
    { delaysMs: [10, 20], sleep: okSleep.sleep },
  );
  assert.equal(v, 'done');
  assert.equal(okCalls, 1);
  assert.deepEqual(okSleep.calls, []);

  // 第三次成功：睡两次，参数即间隔序列
  const retrySleep = fakeSleep();
  let failCalls = 0;
  const v2 = await withRetry(
    () => {
      failCalls++;
      if (failCalls < 3) throw new Error(`e${failCalls}`);
      return 42;
    },
    { delaysMs: [10, 20], sleep: retrySleep.sleep },
  );
  assert.equal(v2, 42);
  assert.equal(failCalls, 3);
  assert.deepEqual(retrySleep.calls, [10, 20]);

  // 全部失败：原样抛最后一个错误，onFailure 最后一次 nextDelayMs 为 null
  const dieSleep = fakeSleep();
  const infos: Array<{ attempt: number; nextDelayMs: number | null }> = [];
  const last = new Error('permanent');
  await assert.rejects(
    withRetry(() => {
      throw last;
    }, {
      delaysMs: [10],
      sleep: dieSleep.sleep,
      onFailure: (i) => infos.push({ attempt: i.attempt, nextDelayMs: i.nextDelayMs }),
    }),
    (err: unknown) => err === last,
  );
  assert.deepEqual(infos, [
    { attempt: 1, nextDelayMs: 10 },
    { attempt: 2, nextDelayMs: null },
  ]);
});

test('ensureDailyCheck 永不 reject：runCheck 恒失败时正常 resolve 为 failed', async () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-14');
  await assert.doesNotReject(
    ensureDailyCheck(db, t0, {
      runCheck: () => {
        throw new Error('boom');
      },
      retry: { delaysMs: [], sleep: () => {} },
    }),
  );
  const r = await ensureDailyCheck(db, t0, {
    runCheck: () => {
      throw new Error('boom');
    },
    retry: { delaysMs: [], sleep: () => {} },
  });
  assert.equal(r.status, 'failed');
  db.close();
});

test('默认依赖接线：真库 + 默认 runCheck/hasRun，ran 一次后第二次 skipped', async () => {
  const db = openDb(':memory:');
  const t0 = shanghaiNoon('2026-09-14');
  // 只固定时钟；runCheck 与 hasRun 都走默认绑定，retry 不可能触发但给零成本睡眠
  const deps = { now: () => t0, retry: { delaysMs: [] as number[], sleep: () => {} } };

  const r1 = await ensureDailyCheck(db, t0, deps);
  assert.equal(r1.status, 'ran');
  const r2 = await ensureDailyCheck(db, t0, deps);
  assert.equal(r2.status, 'skipped');
  assert.equal(listCheckRuns(db).length, 1);
  db.close();
});
