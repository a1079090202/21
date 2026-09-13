/**
 * CLI：所有运维操作入口。
 *
 *   item add      --kind domain --name <域名> --registrar <注册商> --expires <YYYY-MM-DD> [--note ...]
 *   item add      --kind cert   --name <名称> --issued-to <签发对象> --expires <YYYY-MM-DD> [--note ...]
 *   item list
 *   item renew    <id> --expires <YYYY-MM-DD>          续期后更新到期日
 *   check run                                          手动触发一次检查
 *   check history [--run <id>]                         查看检查历史/某次详情
 *   alert list    [--level 30|14|7] [--status open|acknowledged]
 *   alert ack     <id> --handler <处理人> --note <备注>
 *   silence add   --item <id> --hours <1..24> [--reason ...]
 *   silence list  [--item <id>]
 *   report                                             未来30天到期项 + 未处理告警
 */

import { openDb } from './db.js';
import { runCheck } from './checker.js';
import {
  ackAlert,
  addItem,
  addSilenceWindow,
  getAlert,
  getItem,
  itemsExpiringBetween,
  listAlerts,
  listCheckResults,
  listCheckRuns,
  listItems,
  listSilenceWindows,
  updateExpiresOn,
  type AlertStatus,
  type ItemKind,
} from './repo.js';
import { TIERS, tierForDaysLeft, type Tier } from './expiry.js';
import {
  addDays,
  daysBetween,
  formatShanghai,
  isValidDate,
  shanghaiDate,
} from './time.js';

class UsageError extends Error {}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function required(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (v === undefined || v === 'true' || v === '') {
    throw new UsageError(`缺少参数 --${key}`);
  }
  return v;
}

function requireDate(flags: Record<string, string>, key: string): string {
  const v = required(flags, key);
  if (!isValidDate(v)) throw new UsageError(`--${key} 必须是真实日期，格式 YYYY-MM-DD，收到：${v}`);
  return v;
}

function requireId(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n <= 0) throw new UsageError(`${what} 必须是正整数，收到：${value ?? '空'}`);
  return n;
}

function pad(s: string, w: number): string {
  // 中文按 2 列宽计算
  const width = [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(1, w - width));
}

function tierLabel(tier: Tier | null): string {
  return tier === null ? '-' : `${tier}天档`;
}

const KIND_LABEL: Record<ItemKind, string> = { domain: '域名', cert: '证书' };

function main(): void {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const db = openDb();
  const now = Date.now();

  try {
    switch (`${cmd ?? ''} ${sub ?? ''}`.trim()) {
      case 'item add': {
        const kind = required(flags, 'kind');
        if (kind !== 'domain' && kind !== 'cert') throw new UsageError('--kind 只能是 domain 或 cert');
        const name = required(flags, 'name');
        const expiresOn = requireDate(flags, 'expires');
        const registrar = kind === 'domain' ? required(flags, 'registrar') : null;
        const issuedTo = kind === 'cert' ? required(flags, 'issued-to') : null;
        const id = addItem(db, {
          kind: kind as ItemKind,
          name,
          registrar,
          issuedTo,
          expiresOn,
          note: flags['note'] ?? null,
          createdAt: now,
        });
        console.log(`已录入监控项 #${id}（${KIND_LABEL[kind as ItemKind]} ${name}，到期 ${expiresOn}）`);
        break;
      }

      case 'item list': {
        const items = listItems(db);
        if (items.length === 0) {
          console.log('（暂无监控项，用 item add 录入，或 npm run seed 写入样例数据）');
          break;
        }
        const today = shanghaiDate(now);
        console.log(pad('ID', 5) + pad('类型', 7) + pad('名称', 28) + pad('注册商/签发对象', 22) + pad('到期日', 13) + '剩余天数');
        for (const it of items) {
          const extra = it.kind === 'domain' ? it.registrar ?? '-' : it.issued_to ?? '-';
          console.log(
            pad(String(it.id), 5) +
              pad(KIND_LABEL[it.kind], 7) +
              pad(it.name, 28) +
              pad(extra, 22) +
              pad(it.expires_on, 13) +
              daysBetween(today, it.expires_on),
          );
        }
        break;
      }

      case 'item renew': {
        const id = requireId(positional[0], '监控项 ID');
        const expiresOn = requireDate(flags, 'expires');
        if (!updateExpiresOn(db, id, expiresOn)) throw new UsageError(`监控项 #${id} 不存在`);
        console.log(`监控项 #${id} 到期日已更新为 ${expiresOn}`);
        break;
      }

      case 'check run': {
        const s = runCheck(db, now);
        console.log(`检查完成：run#${s.runId} 日期=${s.runDate} 监控项=${s.itemCount} 新增告警=${s.alertsCreated}`);
        for (const o of s.outcomes) {
          const marks: string[] = [];
          if (o.silenced) marks.push('静默中');
          if (o.alertCreated) marks.push(`新增${o.tier}天档告警`);
          console.log(
            `  ${pad('#' + o.itemId, 5)} ${pad(o.itemName, 28)} 剩余${pad(String(o.daysLeft), 5)}天 档位=${pad(tierLabel(o.tier), 6)} ${marks.join(' ')}`,
          );
        }
        break;
      }

      case 'check history': {
        if (flags['run'] !== undefined) {
          const runId = requireId(flags['run'], 'run ID');
          const rows = listCheckResults(db, runId);
          if (rows.length === 0) throw new UsageError(`没有 run#${runId} 的检查结果`);
          console.log(pad('监控项', 6) + pad('检查日期', 13) + pad('剩余天数', 9) + pad('档位', 7) + pad('静默', 5) + '新增告警');
          for (const r of rows) {
            console.log(
              pad('#' + r.item_id, 6) +
                pad(r.check_date, 13) +
                pad(String(r.days_left), 9) +
                pad(tierLabel(r.tier), 7) +
                pad(r.silenced ? '是' : '否', 5) +
                (r.alert_created ? '是' : '否'),
            );
          }
        } else {
          const runs = listCheckRuns(db);
          if (runs.length === 0) {
            console.log('（还没有跑过检查）');
            break;
          }
          console.log(pad('run', 6) + pad('日期', 13) + pad('开始时间', 22) + pad('监控项数', 9) + '新增告警');
          for (const r of runs) {
            console.log(
              pad('#' + r.id, 6) +
                pad(r.run_date, 13) +
                pad(formatShanghai(r.started_at), 22) +
                pad(String(r.item_count), 9) +
                r.alerts_created,
            );
          }
        }
        break;
      }

      case 'alert list': {
        const filter: { tier?: Tier; status?: AlertStatus } = {};
        if (flags['level'] !== undefined) {
          const t = Number(flags['level']);
          if (!(TIERS as readonly number[]).includes(t)) throw new UsageError('--level 只能是 30、14 或 7');
          filter.tier = t as Tier;
        }
        if (flags['status'] !== undefined) {
          if (flags['status'] !== 'open' && flags['status'] !== 'acknowledged') {
            throw new UsageError('--status 只能是 open 或 acknowledged');
          }
          filter.status = flags['status'];
        }
        const alerts = listAlerts(db, filter);
        if (alerts.length === 0) {
          console.log('（没有符合条件的告警）');
          break;
        }
        console.log(
          pad('ID', 5) + pad('档位', 7) + pad('监控项', 28) + pad('首次告警日', 13) + pad('状态', 10) + pad('处理人', 10) + '备注',
        );
        for (const a of alerts) {
          console.log(
            pad(String(a.id), 5) +
              pad(tierLabel(a.tier), 7) +
              pad(`${a.item_name}(${KIND_LABEL[a.item_kind]})`, 28) +
              pad(a.raised_date, 13) +
              pad(a.status === 'open' ? '未处理' : '已确认', 10) +
              pad(a.handler ?? '-', 10) +
              (a.handle_note ?? ''),
          );
        }
        break;
      }

      case 'alert ack': {
        const id = requireId(positional[0], '告警 ID');
        const handler = required(flags, 'handler');
        const note = required(flags, 'note');
        if (!getAlert(db, id)) throw new UsageError(`告警 #${id} 不存在`);
        if (!ackAlert(db, id, handler, note, now)) throw new UsageError(`告警 #${id} 已是确认状态`);
        console.log(`告警 #${id} 已确认（处理人：${handler}）`);
        break;
      }

      case 'silence add': {
        const itemId = requireId(flags['item'], '监控项 ID');
        const item = getItem(db, itemId);
        if (!item) throw new UsageError(`监控项 #${itemId} 不存在`);
        const hours = Number(required(flags, 'hours'));
        if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
          throw new UsageError('--hours 必须在 (0, 24] 之间，静默窗口最长 24 小时');
        }
        const endsAt = now + Math.round(hours * 3600 * 1000);
        const id = addSilenceWindow(db, {
          itemId,
          startsAt: now,
          endsAt,
          reason: flags['reason'] ?? null,
          createdAt: now,
        });
        console.log(
          `已设置静默窗口 #${id}：监控项 #${itemId}（${item.name}）${formatShanghai(now)} ~ ${formatShanghai(endsAt)}`,
        );
        break;
      }

      case 'silence list': {
        const itemId = flags['item'] !== undefined ? requireId(flags['item'], '监控项 ID') : undefined;
        const rows = listSilenceWindows(db, itemId);
        if (rows.length === 0) {
          console.log('（没有静默窗口）');
          break;
        }
        console.log(pad('ID', 5) + pad('监控项', 8) + pad('开始', 22) + pad('结束', 22) + pad('状态', 8) + '原因');
        for (const w of rows) {
          const active = w.starts_at <= now && w.ends_at > now;
          console.log(
            pad(String(w.id), 5) +
              pad('#' + w.item_id, 8) +
              pad(formatShanghai(w.starts_at), 22) +
              pad(formatShanghai(w.ends_at), 22) +
              pad(active ? '生效中' : '已结束', 8) +
              (w.reason ?? ''),
          );
        }
        break;
      }

      case 'report': {
        const today = shanghaiDate(now);
        const horizon = addDays(today, 30);
        const expiring = itemsExpiringBetween(db, today, horizon);
        const openAlerts = listAlerts(db, { status: 'open' });

        console.log(`== 未来 30 天内到期的监控项（${today} ~ ${horizon}，Asia/Shanghai）==`);
        if (expiring.length === 0) {
          console.log('（无）');
        } else {
          console.log(pad('ID', 5) + pad('类型', 7) + pad('名称', 28) + pad('到期日', 13) + pad('剩余天数', 9) + '档位');
          for (const it of expiring) {
            const left = daysBetween(today, it.expires_on);
            console.log(
              pad(String(it.id), 5) +
                pad(KIND_LABEL[it.kind], 7) +
                pad(it.name, 28) +
                pad(it.expires_on, 13) +
                pad(String(left), 9) +
                tierLabel(tierForDaysLeft(left)),
            );
          }
        }

        console.log('');
        console.log('== 未处理告警 ==');
        if (openAlerts.length === 0) {
          console.log('（无）');
        } else {
          console.log(pad('ID', 5) + pad('档位', 7) + pad('监控项', 28) + '首次告警日');
          for (const a of openAlerts) {
            console.log(
              pad(String(a.id), 5) +
                pad(tierLabel(a.tier), 7) +
                pad(`${a.item_name}(${KIND_LABEL[a.item_kind]})`, 28) +
                a.raised_date,
            );
          }
        }
        break;
      }

      default:
        console.log(
          [
            '用法：node dist/src/cli.js <命令>',
            '',
            '  item add --kind domain --name <域名> --registrar <注册商> --expires <YYYY-MM-DD> [--note ...]',
            '  item add --kind cert --name <名称> --issued-to <签发对象> --expires <YYYY-MM-DD> [--note ...]',
            '  item list',
            '  item renew <id> --expires <YYYY-MM-DD>',
            '  check run',
            '  check history [--run <id>]',
            '  alert list [--level 30|14|7] [--status open|acknowledged]',
            '  alert ack <id> --handler <处理人> --note <备注>',
            '  silence add --item <id> --hours <1..24> [--reason ...]',
            '  silence list [--item <id>]',
            '  report',
          ].join('\n'),
        );
        if (cmd) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`参数错误：${err.message}`);
      process.exitCode = 2;
    } else {
      throw err;
    }
  } finally {
    db.close();
  }
}

main();
