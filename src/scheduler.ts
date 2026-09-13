/**
 * 服务入口：只做调度。
 * 每天早上 08:00（Asia/Shanghai）跑一次检查，判定逻辑在 checker/expiry/alerts 模块。
 * 手动触发检查请用 CLI：node dist/src/cli.js check run
 */

import cron from 'node-cron';
import { openDb, DEFAULT_DB_PATH } from './db.js';
import { runCheck } from './checker.js';
import { SHANGHAI_TZ } from './time.js';

const db = openDb();

function runOnce(): void {
  try {
    const s = runCheck(db, Date.now());
    console.log(
      `[monitor] 检查完成 run#${s.runId} 日期=${s.runDate} 监控项=${s.itemCount} 新增告警=${s.alertsCreated}`,
    );
  } catch (err) {
    console.error('[monitor] 检查失败', err);
  }
}

cron.schedule('0 8 * * *', runOnce, { timezone: SHANGHAI_TZ });
console.log(`[monitor] 服务已启动，数据库 ${DEFAULT_DB_PATH}，每天 08:00 (${SHANGHAI_TZ}) 执行检查`);

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
