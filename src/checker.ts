/**
 * 检查编排：跑一次完整检查。
 *
 * 分档与告警判定全部委托给纯函数模块（expiry.ts / alerts.ts），
 * 这里只负责取数、调用判定、把结果落库。
 * 一次检查 = 1 条 check_runs + N 条 check_results + 若干条 alerts，
 * 全部在一个事务里插入，只追加不修改。
 */

import type { DB } from './db.js';
import { decideAlert } from './alerts.js';
import type { Tier } from './expiry.js';
import { daysBetween, shanghaiDate } from './time.js';
import {
  activeSilenceWindow,
  insertAlert,
  insertCheckResult,
  insertCheckRun,
  listItems,
  openAlertTiers,
} from './repo.js';

export interface ItemCheckOutcome {
  itemId: number;
  itemName: string;
  kind: string;
  expiresOn: string;
  daysLeft: number;
  tier: Tier | null;
  silenced: boolean;
  alertCreated: boolean;
  reason: string;
}

export interface RunSummary {
  runId: number;
  runDate: string;
  itemCount: number;
  alertsCreated: number;
  outcomes: ItemCheckOutcome[];
}

export function runCheck(db: DB, nowMs: number): RunSummary {
  const today = shanghaiDate(nowMs);
  const items = listItems(db);

  const tx = db.transaction((): RunSummary => {
    // 先算完所有判定，再统一落库，保证 check_runs 一次插入即为终态
    const planned = items.map((item) => {
      const daysLeft = daysBetween(today, item.expires_on);
      const silenced = activeSilenceWindow(db, item.id, nowMs) !== undefined;
      const openTiers = openAlertTiers(db, item.id);
      const decision = decideAlert(daysLeft, openTiers, silenced);
      return { item, daysLeft, silenced, decision };
    });

    const alertsCreated = planned.filter((p) => p.decision.shouldCreate).length;
    const runId = insertCheckRun(db, {
      runDate: today,
      startedAt: nowMs,
      itemCount: items.length,
      alertsCreated,
    });

    const outcomes: ItemCheckOutcome[] = [];
    for (const { item, daysLeft, silenced, decision } of planned) {
      insertCheckResult(db, {
        runId,
        itemId: item.id,
        checkDate: today,
        daysLeft,
        tier: decision.tier,
        silenced,
        alertCreated: decision.shouldCreate,
      });
      if (decision.shouldCreate && decision.tier !== null) {
        insertAlert(db, {
          itemId: item.id,
          tier: decision.tier,
          raisedDate: today,
          raisedAt: nowMs,
        });
      }
      outcomes.push({
        itemId: item.id,
        itemName: item.name,
        kind: item.kind,
        expiresOn: item.expires_on,
        daysLeft,
        tier: decision.tier,
        silenced,
        alertCreated: decision.shouldCreate,
        reason: decision.reason,
      });
    }

    return { runId, runDate: today, itemCount: items.length, alertsCreated, outcomes };
  });

  return tx();
}
