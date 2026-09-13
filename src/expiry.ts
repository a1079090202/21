/**
 * 到期分档（纯函数，不碰数据库）。
 *
 * 三档告警：剩余 ≤30 天、≤14 天、≤7 天。
 * 一个监控项在某一时刻只属于"最紧"的那一档：
 * 剩 5 天只算 7 天档，不会再补 30/14 天档。
 */

export const TIERS = [30, 14, 7] as const;
export type Tier = (typeof TIERS)[number];

/** 按剩余天数给出告警档位；超过 30 天返回 null（不告警） */
export function tierForDaysLeft(daysLeft: number): Tier | null {
  if (daysLeft <= 7) return 7;
  if (daysLeft <= 14) return 14;
  if (daysLeft <= 30) return 30;
  return null;
}
