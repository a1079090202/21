/**
 * 通用异步重试（不依赖业务）。
 *
 * 首次立即执行；fn 抛错才按 delaysMs 间隔重试；全部失败时原样抛出最后一个错误
 * （不包自定义错误类型，避免内网排障丢失原始 message/stack）。
 *
 * 每日检查的 runCheck 是 better-sqlite3 单事务，失败整体回滚、零写入，
 * 因此重试天然安全——不存在"跑了半截"的状态需要回补。
 */

/** 默认重试间隔：1 分钟、5 分钟、15 分钟（即首次 + 共 4 次尝试，最坏 21 分钟） */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000];

export interface RetryFailureInfo {
  /** 第几次尝试（从 1 开始） */
  attempt: number;
  error: unknown;
  /** 下一次尝试前的等待；null 表示重试预算已耗尽、即将放弃 */
  nextDelayMs: number | null;
}

export interface RetryOptions {
  /** 第 i 次尝试失败后、第 i+1 次尝试前的等待；长度 = 重试次数（不含首次）。默认 DEFAULT_RETRY_DELAYS_MS */
  delaysMs?: readonly number[];
  /** 睡眠实现；生产用 setTimeout，测试注入记录参数后立即 resolve 的假实现 */
  sleep?: (ms: number) => Promise<void> | void;
  /** 每次失败后回调（含最后一次，此时 nextDelayMs 为 null），供打日志 */
  onFailure?: (info: RetryFailureInfo) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 执行 fn，失败时按递增间隔重试。
 * fn 允许同步或异步：生产传入的 runCheck 是同步的，测试可用返回 Promise 的假实现模拟"在途"。
 */
export async function withRetry<T>(fn: () => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delaysMs = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const onFailure = options.onFailure ?? (() => {});

  let attempt = 0;
  // 尝试总次数 = 首次 + 间隔数；只有失败后还有间隔时才睡了再来
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (error) {
      const nextDelayMs = attempt <= delaysMs.length ? delaysMs[attempt - 1] : null;
      onFailure({ attempt, error, nextDelayMs });
      if (nextDelayMs === null) throw error;
      await sleep(nextDelayMs);
    }
  }
}
