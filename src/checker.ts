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
  activeGroupSilenceForItem,
  activeSilenceWindow,
  insertAlert,
  insertCheckResult,
  insertCheckRun,
  listItems,
  openAlertTiers,
  type SilenceKind,
} from './repo.js';

export interface ItemCheckOutcome {
  itemId: number;
  itemName: string;
  kind: string;
  expiresOn: string;
  daysLeft: number;
  tier: Tier | null;
  silenced: boolean;
  silenceKind: SilenceKind | null;
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
      // 静默来源：单项窗口优先；否则看所属分组当前是否有生效中的组静默窗口。
      // 组静默按 group_name 实时判定——窗口期间新入组的项同样被罩住。
      let silenceKind: SilenceKind | null = null;
      if (activeSilenceWindow(db, item.id, nowMs) !== undefined) {
        silenceKind = 'item';
      } else if (activeGroupSilenceForItem(db, item, nowMs) !== undefined) {
        silenceKind = 'group';
      }
      const silenced = silenceKind !== null;
      const openTiers = openAlertTiers(db, item.id);
      const decision = decideAlert(daysLeft, openTiers, silenced);
      return { item, daysLeft, silenceKind, decision };
    });

    const alertsCreated = planned.filter((p) => p.decision.shouldCreate).length;
    const runId = insertCheckRun(db, {
      runDate: today,
      startedAt: nowMs,
      itemCount: items.length,
      alertsCreated,
    });

    const outcomes: ItemCheckOutcome[] = [];
    for (const { item, daysLeft, silenceKind, decision } of planned) {
      insertCheckResult(db, {
        runId,
        itemId: item.id,
        checkDate: today,
        daysLeft,
        tier: decision.tier,
        silenced: silenceKind !== null,
        silenceKind,
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
        silenced: silenceKind !== null,
        silenceKind,
        alertCreated: decision.shouldCreate,
        reason: decision.reason,
      });
    }

    return { runId, runDate: today, itemCount: items.length, alertsCreated, outcomes };
  });

  return tx();
}
