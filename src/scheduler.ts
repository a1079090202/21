/**
 * 服务入口：只做调度。
 *
 * 每天 08:00（Asia/Shanghai）准点跑一次；此外有两层兜底，保证短暂故障不会造成全天漏检：
 *  1. 启动补跑：进程启动时若当天还没有成功检查，立即补一次（关机只补今天，不补历史）；
 *  2. 每小时巡检：第 7 分钟看一眼，当天没有成功记录就补跑。
 * 检查本身失败时由 daily.ts / retry.ts 按 1m/5m/15m 间隔自动重试（共 4 次尝试）。
 * 判定逻辑在 checker/expiry/alerts 模块，本文件不碰业务。
 * 手动触发检查请用 CLI：node dist/src/cli.js check run
 */

import cron from 'node-cron';
import { openDb, DEFAULT_DB_PATH } from './db.js';
import { createDailyGate } from './daily.js';
import { SHANGHAI_TZ } from './time.js';

const db = openDb();

const gate = createDailyGate(db, {
  retry: {
    onFailure: ({ attempt, error, nextDelayMs }) => {
      const wait = nextDelayMs === null ? '' : `，${Math.round(nextDelayMs / 1000)} 秒后重试`;
      console.error(`[monitor] 第 ${attempt} 次检查尝试失败${wait}`, error);
    },
  },
});

type TriggerSource = '启动补跑' | '定时检查' | '巡检补跑';

/** 三个触发源的统一入口；任何异常都在这里消化，绝不冒泡到 node-cron */
async function trigger(source: TriggerSource): Promise<void> {
  try {
    const r = await gate.ensure();
    if (r.status === 'busy') {
      console.log('[monitor] 上一次检查仍在进行（含重试等待），本次触发跳过');
      return;
    }
    if (r.status === 'skipped') {
      console.log(`[monitor] ${source}：${r.date} 已有成功检查，跳过`);
      return;
    }
    if (r.status === 'failed') {
      console.error(`[monitor] ${source}：${r.date} 检查在 ${r.attempts} 次尝试后仍失败，等待下次触发兜底`, r.error);
      return;
    }
    console.log(
      `[monitor] ${source}完成：run#${r.summary.runId} 日期=${r.date} 尝试=${r.attempts} ` +
        `监控项=${r.summary.itemCount} 新增告警=${r.summary.alertsCreated}`,
    );
  } catch (err) {
    console.error('[monitor] 每日检查发生未知异常', err);
  }
}

// 先同步注册 cron，再触发启动补跑：注册不能被最长 21 分钟的异步重试拖延。
// node-cron v3 不 await 回调的 Promise，回调统一用零参同步外壳 + 内部 void。
cron.schedule('0 8 * * *', () => {
  void trigger('定时检查');
}, { timezone: SHANGHAI_TZ });
cron.schedule('7 * * * *', () => {
  void trigger('巡检补跑');
}, { timezone: SHANGHAI_TZ });
void trigger('启动补跑');

console.log(
  `[monitor] 服务已启动，数据库 ${DEFAULT_DB_PATH}；` +
    `每天 08:00 (${SHANGHAI_TZ}) 准点检查，启动时补跑当天，每小时第 7 分钟巡检，失败按 1/5/15 分钟重试`,
);

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[monitor] 收到 ${signal}，退出`);
  // 同步 runCheck 执行中收到信号会排队到事务终态后才投递，不会有半截写入；
  // 重试睡眠中则随进程退出一并结束，下次启动由启动补跑愈合。
  try {
    db.close();
  } catch (err) {
    console.error('[monitor] 关闭数据库时出错', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
