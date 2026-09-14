/**
 * 每日检查编排：保证"当天（Asia/Shanghai）有过一次成功检查"。
 *
 * 三个触发源（启动补跑、08:00 定时、每小时巡检）都只调这里：
 *  - 当天已有成功记录（check_runs 有行）→ 跳过；
 *  - 否则跑 runCheck，失败交给 withRetry 按递增间隔重试；
 *  - 全部失败 → 返回 failed（不 throw），不写任何记录，下次触发再来。
 *
 * 不重入：createDailyGate 用进程内布尔保证同一时刻只有一个每日检查在途
 * （含其重试睡眠期）。跨进程双守护为非目标，由部署侧（systemd 单实例）约束。
 */

import type { DB } from './db.js';
import { runCheck, type RunSummary } from './checker.js';
import { hasCheckRunOnDate } from './repo.js';
import { shanghaiDate } from './time.js';
import { withRetry, type RetryOptions } from './retry.js';

export type EnsureStatus = 'ran' | 'skipped' | 'failed';

export type EnsureResult =
  | { status: 'ran'; date: string; attempts: number; summary: RunSummary }
  | { status: 'skipped'; date: string; attempts: number }
  | { status: 'failed'; date: string; attempts: number; error: unknown };

export interface EnsureDeps {
  /** 当前时刻；默认 Date.now。每次尝试都重新调用——重试跨度最长 21 分钟，要覆盖跨午夜 */
  now?: () => number;
  /** 当天是否已成功跑过；默认查 check_runs */
  hasRun?: (date: string) => boolean;
  /** 检查函数；默认绑定本 db 的 runCheck */
  runCheck?: (nowMs: number) => RunSummary | Promise<RunSummary>;
  /** 重试选项（间隔/睡眠/失败回调） */
  retry?: RetryOptions;
}

type AttemptOutcome =
  | { skipped: true; date: string }
  | { skipped: false; date: string; summary: RunSummary };

/**
 * 保证当天有过一次成功检查。永不 throw：重试耗尽时返回 failed 结果。
 * （node-cron 不 await 回调的 Promise，throw 会变成 uncaughtException。）
 */
export async function ensureDailyCheck(db: DB, nowMs: number, deps: EnsureDeps = {}): Promise<EnsureResult> {
  const now = deps.now ?? (() => Date.now());
  const hasRun = deps.hasRun ?? ((date: string) => hasCheckRunOnDate(db, date));
  const runCheckFn = deps.runCheck ?? ((ms: number) => runCheck(db, ms));

  let attempts = 0;
  // 入口先给一个日期兜底：极端情况下 withRetry 自身（非 fn）抛错时 failed 结果也有 date
  let lastDate = shanghaiDate(nowMs);

  try {
    const outcome = await withRetry(async (): Promise<AttemptOutcome> => {
      attempts++;
      // 首次尝试用入口时刻（测试可显式注入），之后重取 now()：
      //  - 睡眠期间被 CLI check run 手动补齐 → 直接 skipped，不再消耗 runCheck；
      //  - 跨上海午夜（23:59 失败、00:14 重试）→ 自然转为次日补一条。
      const ts = attempts === 1 ? nowMs : now();
      const date = shanghaiDate(ts);
      lastDate = date;
      if (hasRun(date)) return { skipped: true, date };
      const summary = await runCheckFn(ts);
      return { skipped: false, date, summary };
    }, deps.retry);

    if (outcome.skipped) return { status: 'skipped', date: outcome.date, attempts };
    return { status: 'ran', date: outcome.date, attempts, summary: outcome.summary };
  } catch (error) {
    return { status: 'failed', date: lastDate, attempts, error };
  }
}

export interface DailyGate {
  /** 当前是否有每日检查在途（含重试睡眠期） */
  readonly inFlight: boolean;
  /** 在途时立即返回 busy（不排队）；否则执行一次 ensureDailyCheck */
  ensure(nowMs?: number): Promise<EnsureResult | { status: 'busy' }>;
}

/**
 * 进程内防重入包装。
 * 选择"跳过"而非"排队/复用 Promise"：三个触发源互为幂等兜底，任何一个在途
 * 都已代表今天会被搞定（或本轮重试很快耗尽、下一次巡检再兜），排队没有价值。
 */
export function createDailyGate(db: DB, deps: EnsureDeps = {}): DailyGate {
  let inFlight = false;
  const now = deps.now ?? (() => Date.now());

  return {
    get inFlight() {
      return inFlight;
    },
    async ensure(nowMs?: number) {
      if (inFlight) return { status: 'busy' };
      inFlight = true;
      try {
        return await ensureDailyCheck(db, nowMs ?? now(), deps);
      } finally {
        inFlight = false;
      }
    },
  };
}
