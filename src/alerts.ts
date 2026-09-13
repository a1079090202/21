/**
 * 告警判定（纯函数，不碰数据库）。
 *
 * 规则：
 *  - 不在任何档位内 → 不告警；
 *  - 监控项处于静默窗口内 → 不新增告警（检查结果照常记录）；
 *  - 同一监控项、同一档位已有未确认（open）告警 → 不重复记录；
 *  - 其余情况 → 记一条新告警。
 * 已确认（acknowledged）的告警不拦截后续告警：确认后再次命中同档会重新记一条。
 */

import { tierForDaysLeft, type Tier } from './expiry.js';

export type AlertReason = 'create' | 'none' | 'silenced' | 'duplicate';

export interface AlertDecision {
  /** 当前命中的档位；不在档内为 null */
  tier: Tier | null;
  /** 是否应插入一条新告警 */
  shouldCreate: boolean;
  reason: AlertReason;
}

export function decideAlert(
  daysLeft: number,
  openTiers: readonly Tier[],
  silenced: boolean,
): AlertDecision {
  const tier = tierForDaysLeft(daysLeft);
  if (tier === null) return { tier: null, shouldCreate: false, reason: 'none' };
  if (silenced) return { tier, shouldCreate: false, reason: 'silenced' };
  if (openTiers.includes(tier)) return { tier, shouldCreate: false, reason: 'duplicate' };
  return { tier, shouldCreate: true, reason: 'create' };
}
