/**
 * 时区与日期工具。
 *
 * 系统里"哪一天"一律按 Asia/Shanghai 计算，不用 UTC 日期。
 * 日期用 'YYYY-MM-DD' 字符串表示；具体时刻用 epoch 毫秒（number）表示。
 */

export const SHANGHAI_TZ = 'Asia/Shanghai';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHANGHAI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const DAY_MS = 86_400_000;

/** 某个时刻在 Asia/Shanghai 是哪一天，返回 'YYYY-MM-DD' */
export function shanghaiDate(nowMs: number): string {
  return dateFmt.format(new Date(nowMs)); // en-CA 即 YYYY-MM-DD
}

/** 格式化为上海时区的 'YYYY-MM-DD HH:mm:ss'，用于展示 */
export function formatShanghai(ms: number): string {
  const parts = timeFmt.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** 'YYYY-MM-DD' 是否为真实存在的日期 */
export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return (
    dt.getUTCFullYear() === +y &&
    dt.getUTCMonth() === +mo - 1 &&
    dt.getUTCDate() === +d
  );
}

/** 日期串转"天数编号"，差值即相隔天数（天然跨月/跨年正确） */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 从 from 到 to 还差几天（to 早于 from 时为负数） */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** 日期串加 n 天，返回新的 'YYYY-MM-DD' */
export function addDays(date: string, n: number): string {
  const ms = dayNumber(date) * DAY_MS + n * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}
