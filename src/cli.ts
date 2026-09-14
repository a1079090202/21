/**
 * CLI：所有运维操作入口。
 *
 *   group add    <name> [--description ...]            新建分组（如 finance、web）
 *   group list                                         分组列表（含各组监控项数）
 *   item add      --kind domain --name <域名> --registrar <注册商> --expires <YYYY-MM-DD> [--group <组>] [--note ...]
 *   item add      --kind cert   --name <名称> --issued-to <签发对象> --expires <YYYY-MM-DD> [--group <组>] [--note ...]
 *   item list     [--group <组> | --ungrouped]         监控项列表，可按组筛选
 *   item group    <id> (--name <组> | --clear)         把监控项移入/移出分组
 *   item renew    <id> --expires <YYYY-MM-DD>          续期后更新到期日（同时自动确认该项未处理告警，结束上一告警周期）
 *   check run                                          手动触发一次检查
 *   check history [--run <id>]                         查看检查历史/某次详情
 *   alert list    [--level 30|14|7] [--status open|acknowledged] [--group <组>]
 *   alert ack     <id> --handler <处理人> --note <备注>
 *   silence add   (--item <id> | --group <组>) [--hours <1..24>，默认 24] [--reason ...]
 *   silence list  [--item <id> | --group <组>]
 *   report        [--group <组>]                       未来30天到期项 + 未处理告警
 *   report csv    --group <组> [--out <文件>]          按组导出三档到期项 CSV（域名,到期日,档位,处理状态）
 */

import { openDb } from './db.js';
import { runCheck } from './checker.js';
import {
  ackAlert,
  addGroup,
  addGroupSilenceWindow,
  addItem,
  addSilenceWindow,
  getAlert,
  getGroup,
  getItem,
  groupExpiryReport,
  isUniqueConstraint,
  itemsExpiringBetween,
  listAlerts,
  listCheckResults,
  listCheckRuns,
  listGroupSilenceWindows,
  listGroups,
  listItems,
  listSilenceWindows,
  isValidGroupName,
  renewItem,
  setItemGroup,
  type AlertStatus,
  type ItemKind,
  type ReportAlertStatus,
} from './repo.js';
import { TIERS, tierForDaysLeft, type Tier } from './expiry.js';
import {
  addDays,
  daysBetween,
  formatShanghai,
  isValidDate,
  shanghaiDate,
} from './time.js';
import { writeFileSync } from 'node:fs';

class UsageError extends Error {}

interface ArgSpec {
  /** 允许且必须带值的 flag，如 --name */
  valueFlags?: readonly string[];
  /** 允许且不带值的开关 flag，如 --ungrouped、--clear */
  boolFlags?: readonly string[];
  /** 互斥组：同组内的 flag 至多出现一个 */
  conflicts?: ReadonlyArray<readonly string[]>;
  /** 精确的位置参数个数；undefined 表示不校验 */
  positional?: number;
  /** 位置参数叫法，用于报错文案 */
  positionalName?: string;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

/**
 * 按命令声明的规格严格解析参数。下列情况一律抛 UsageError：
 * 未知 flag、值参数尾部缺值（或后面跟了另一个 flag）、开关参数被赋值、
 * 同一 flag 重复出现、互斥参数同传、位置参数多了或少了。
 * 必须在打开数据库和执行业务之前调用——错误输入不得产生任何副作用。
 * 同时支持 `--key value` 和 `--key=value` 两种写法。
 */
function parseCommandArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const boolFlags = new Set(spec.boolFlags ?? []);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyPositional || !a.startsWith('--') || a === '--') {
      if (a === '--' && !onlyPositional) {
        onlyPositional = true; // 标准约定：-- 之后一律按位置参数
      } else {
        positional.push(a);
      }
      continue;
    }
    let key: string;
    let inlineValue: string | undefined;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      key = a.slice(2, eq);
      inlineValue = a.slice(eq + 1);
    } else {
      key = a.slice(2);
    }
    if (key === '' || key.startsWith('-')) throw new UsageError(`无法识别的参数：${a}`);
    if (flags[key] !== undefined) throw new UsageError(`参数 --${key} 重复出现，请只写一次`);

    if (boolFlags.has(key)) {
      if (inlineValue !== undefined) throw new UsageError(`--${key} 是开关参数，不接受值：${a}`);
      flags[key] = 'true';
    } else if (valueFlags.has(key)) {
      if (inlineValue !== undefined) {
        if (inlineValue === '') throw new UsageError(`参数 --${key} 缺少值`);
        flags[key] = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new UsageError(`参数 --${key} 缺少值`);
        }
        flags[key] = next;
        i++;
      }
    } else {
      throw new UsageError(`未知参数 --${key}（该命令不支持此参数）`);
    }
  }

  for (const group of spec.conflicts ?? []) {
    const present = group.filter((k) => flags[k] !== undefined);
    if (present.length > 1) {
      throw new UsageError(`参数 ${present.map((k) => `--${k}`).join(' 和 ')} 不能同时使用`);
    }
  }

  if (spec.positional !== undefined && positional.length !== spec.positional) {
    const what = spec.positionalName ? ` ${spec.positionalName}` : '';
    if (positional.length < spec.positional) {
      throw new UsageError(`缺少位置参数${what}：需要 ${spec.positional} 个，收到 ${positional.length} 个`);
    }
    throw new UsageError(
      `多余的位置参数：${positional.slice(spec.positional).join(' ')}（该命令只接受 ${spec.positional} 个位置参数${what}）`,
    );
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
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new UsageError(`${what} 必须是正整数，收到：${value ?? '空'}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new UsageError(`${what} 必须是正整数，收到：${value}`);
  }
  return n;
}

/** --hours 严格解析：只接受十进制数字（拒绝 0x10、1e2、12h 等 Number() 能吞下的写法），范围 (0, 24] */
function parseHours(raw: string): number {
  if (!/^(?:\d+|\d*\.\d+)$/.test(raw)) {
    throw new UsageError(`--hours 必须是 (0, 24] 之间的数字，收到：${raw}`);
  }
  const hours = Number(raw);
  if (!(hours > 0 && hours <= 24)) {
    throw new UsageError('--hours 必须在 (0, 24] 之间，静默窗口最长 24 小时');
  }
  return hours;
}

function pad(s: string, w: number): string {
  // 中文按 2 列宽计算
  const width = [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(1, w - width));
}

function tierLabel(tier: Tier | null): string {
  return tier === null ? '-' : `${tier}天档`;
}

/**
 * RFC 4180 转义 + CSV 公式注入防御：
 * 表格软件（Excel/WPS/Numbers）会把以 = + - @ 或制表符开头的单元格当公式执行，
 * 可被 HYPERLINK/DDE 等利用；双引号包裹拦不住（解析后内容仍以 = 开头），
 * 必须前置单引号强制按文本解析，再做 RFC 4180 的引号包裹与双写。
 */
function csvCell(s: string): string {
  const safe = /^[=+@\t\r-]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const KIND_LABEL: Record<ItemKind, string> = { domain: '域名', cert: '证书' };

const GROUP_COL = 14;

/** 校验分组标签格式；要求存在时再校验存在性 */
function resolveGroupName(db: ReturnType<typeof openDb>, raw: string | undefined): string {
  if (raw === undefined) throw new UsageError('缺少参数 --group');
  if (!isValidGroupName(raw)) {
    throw new UsageError(`组名只能用小写字母、数字、中划线、下划线（1~32 字符），收到：${raw}`);
  }
  if (!getGroup(db, raw)) throw new UsageError(`分组 ${raw} 不存在，先用 group add ${raw} 建组`);
  return raw;
}

function tierStatusLabel(s: ReportAlertStatus): string {
  return s === 'open' ? '未处理' : s === 'acknowledged' ? '已确认' : '未告警';
}

/**
 * 各命令的参数规格；未列入此表的命令一律视为未知命令（只打印用法、退出码 1，不打开数据库）。
 * valueFlags 必须带值，boolFlags 必须不带值，conflicts 为互斥组，positional 为精确位置参数个数。
 */
const COMMAND_SPECS: Record<string, ArgSpec> = {
  'group add': { valueFlags: ['description'], positional: 1, positionalName: '<name>' },
  'group list': { positional: 0 },
  'item add': {
    valueFlags: ['kind', 'name', 'registrar', 'issued-to', 'expires', 'group', 'note'],
    positional: 0,
  },
  'item list': {
    valueFlags: ['group'],
    boolFlags: ['ungrouped'],
    conflicts: [['group', 'ungrouped']],
    positional: 0,
  },
  'item group': {
    valueFlags: ['name'],
    boolFlags: ['clear'],
    conflicts: [['name', 'clear']],
    positional: 1,
    positionalName: '<id>',
  },
  'item renew': { valueFlags: ['expires'], positional: 1, positionalName: '<id>' },
  'check run': { positional: 0 },
  'check history': { valueFlags: ['run'], positional: 0 },
  'alert list': { valueFlags: ['level', 'status', 'group'], positional: 0 },
  'alert ack': { valueFlags: ['handler', 'note'], positional: 1, positionalName: '<id>' },
  'silence add': {
    valueFlags: ['item', 'group', 'hours', 'reason'],
    conflicts: [['item', 'group']],
    positional: 0,
  },
  'silence list': {
    valueFlags: ['item', 'group'],
    conflicts: [['item', 'group']],
    positional: 0,
  },
  report: { valueFlags: ['group'], positional: 0 },
  'report csv': { valueFlags: ['group', 'out'], positional: 0 },
};

function printUsage(): void {
  console.log(
    [
      '用法：node dist/src/cli.js <命令>',
      '',
      '  group add <name> [--description ...]',
      '  group list',
      '  item add --kind domain --name <域名> --registrar <注册商> --expires <YYYY-MM-DD> [--group <组>] [--note ...]',
      '  item add --kind cert --name <名称> --issued-to <签发对象> --expires <YYYY-MM-DD> [--group <组>] [--note ...]',
      '  item list [--group <组> | --ungrouped]',
      '  item group <id> (--name <组> | --clear)',
      '  item renew <id> --expires <YYYY-MM-DD>   续期：更新到期日并自动确认该项未处理告警（结束上一告警周期）',
      '  check run',
      '  check history [--run <id>]',
      '  alert list [--level 30|14|7] [--status open|acknowledged] [--group <组>]',
      '  alert ack <id> --handler <处理人> --note <备注>',
      '  silence add --item <id> --hours <1..24> [--reason ...]',
      '  silence add --group <组> [--hours <1..24>，默认24] [--reason ...]   整组一键静默，期间新入组项同样生效，到点自动恢复',
      '  silence list [--item <id> | --group <组>]',
      '  report [--group <组>]',
      '  report csv --group <组> [--out <文件>]   三档到期项：域名,到期日,档位,处理状态（不传 --out 输出到标准输出）',
    ].join('\n'),
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd: string | undefined = argv[0];
  let sub: string | undefined = argv[1];
  let rest = argv.slice(2);
  // 允许一级命令直接带 flag（如 report --group finance）：第二段若是 flag 则归位
  if (sub !== undefined && sub.startsWith('--')) {
    rest = [sub, ...rest];
    sub = undefined;
  }
  const command = `${cmd ?? ''} ${sub ?? ''}`.trim();
  const spec = COMMAND_SPECS[command];

  // 未知命令 / 无参数：只打印用法，不打开数据库、不产生任何副作用
  if (!spec) {
    printUsage();
    if (cmd) process.exitCode = 1;
    return;
  }

  // 参数严格解析先于一切业务逻辑：解析失败直接退出码 2，保证错误输入绝不会被执行
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs(rest, spec);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`参数错误：${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const { positional, flags } = parsed;

  const db = openDb();
  const now = Date.now();

  try {
    switch (command) {
      case 'group add': {
        const name = positional[0];
        if (!isValidGroupName(name)) {
          throw new UsageError('组名只能用小写字母、数字、中划线、下划线（1~32 字符）');
        }
        try {
          addGroup(db, { name, description: flags['description'] ?? null, createdAt: now });
        } catch (err) {
          if (isUniqueConstraint(err)) throw new UsageError(`分组 ${name} 已存在`);
          throw err;
        }
        console.log(`已建组 ${name}`);
        break;
      }

      case 'group list': {
        const groups = listGroups(db);
        if (groups.length === 0) {
          console.log('（暂无分组，用 group add <name> 新建）');
          break;
        }
        console.log(pad('组名', GROUP_COL) + pad('监控项数', 9) + '说明');
        for (const g of groups) {
          console.log(pad(g.name, GROUP_COL) + pad(String(g.item_count), 9) + (g.description ?? ''));
        }
        break;
      }

      case 'item add': {
        const kind = required(flags, 'kind');
        if (kind !== 'domain' && kind !== 'cert') throw new UsageError('--kind 只能是 domain 或 cert');
        const name = required(flags, 'name');
        const expiresOn = requireDate(flags, 'expires');
        const registrar = kind === 'domain' ? required(flags, 'registrar') : null;
        const issuedTo = kind === 'cert' ? required(flags, 'issued-to') : null;
        const groupName = flags['group'] !== undefined ? resolveGroupName(db, flags['group']) : null;
        const id = addItem(db, {
          kind: kind as ItemKind,
          name,
          registrar,
          issuedTo,
          expiresOn,
          note: flags['note'] ?? null,
          groupName,
          createdAt: now,
        });
        console.log(
          `已录入监控项 #${id}（${KIND_LABEL[kind as ItemKind]} ${name}，到期 ${expiresOn}${groupName ? `，分组 ${groupName}` : ''}）`,
        );
        break;
      }

      case 'item list': {
        let items;
        let scopeLabel = '';
        if (flags['group'] !== undefined) {
          const groupName = resolveGroupName(db, flags['group']);
          items = listItems(db, { groupName });
          scopeLabel = `（分组 ${groupName}）`;
        } else if (flags['ungrouped'] !== undefined) {
          items = listItems(db, { groupName: null });
          scopeLabel = '（未分组）';
        } else {
          items = listItems(db);
        }
        if (items.length === 0) {
          console.log(`（暂无监控项${scopeLabel}）`);
          break;
        }
        console.log(pad('ID', 5) + pad('类型', 7) + pad('名称', 28) + pad('注册商/签发对象', 22) + pad('到期日', 13) + pad('分组', GROUP_COL) + '剩余天数');
        const today = shanghaiDate(now);
        for (const it of items) {
          const extra = it.kind === 'domain' ? it.registrar ?? '-' : it.issued_to ?? '-';
          console.log(
            pad(String(it.id), 5) +
              pad(KIND_LABEL[it.kind], 7) +
              pad(it.name, 28) +
              pad(extra, 22) +
              pad(it.expires_on, 13) +
              pad(it.group_name ?? '-', GROUP_COL) +
              daysBetween(today, it.expires_on),
          );
        }
        break;
      }

      case 'item group': {
        const id = requireId(positional[0], '监控项 ID');
        const item = getItem(db, id);
        if (!item) throw new UsageError(`监控项 #${id} 不存在`);
        // 规格已排除 --name/--clear 同传；这里只兜底"两个都没给"
        if (flags['clear'] === undefined && flags['name'] === undefined) {
          throw new UsageError('必须指定 --name <组> 或 --clear 之一');
        }
        if (flags['clear'] !== undefined) {
          setItemGroup(db, id, null);
          console.log(`监控项 #${id}（${item.name}）已移出分组（原分组 ${item.group_name ?? '-'}）`);
        } else {
          const groupName = resolveGroupName(db, flags['name']);
          setItemGroup(db, id, groupName);
          console.log(`监控项 #${id}（${item.name}）已归入分组 ${groupName}`);
        }
        break;
      }

      case 'item renew': {
        const id = requireId(positional[0], '监控项 ID');
        const expiresOn = requireDate(flags, 'expires');
        // 续期即结束当前告警周期：同事务更新到期日 + 自动确认该项未处理告警，
        // 否则上一周期的 open 告警会把新一轮同档位告警永久拦截
        const { renewed, closedAlerts } = renewItem(db, id, expiresOn, now);
        if (!renewed) throw new UsageError(`监控项 #${id} 不存在`);
        console.log(
          `监控项 #${id} 到期日已更新为 ${expiresOn}` +
            (closedAlerts > 0 ? `，已自动确认 ${closedAlerts} 条上一周期告警` : ''),
        );
        break;
      }

      case 'check run': {
        const s = runCheck(db, now);
        console.log(`检查完成：run#${s.runId} 日期=${s.runDate} 监控项=${s.itemCount} 新增告警=${s.alertsCreated}`);
        for (const o of s.outcomes) {
          const marks: string[] = [];
          if (o.silenced) marks.push(o.silenceKind === 'group' ? '组静默中' : '静默中');
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
          console.log(pad('监控项', 6) + pad('检查日期', 13) + pad('剩余天数', 9) + pad('档位', 7) + pad('静默', 8) + '新增告警');
          for (const r of rows) {
            const silenceLabel = r.silence_kind === 'group' ? '组' : r.silence_kind === 'item' ? '单项' : '否';
            console.log(
              pad('#' + r.item_id, 6) +
                pad(r.check_date, 13) +
                pad(String(r.days_left), 9) +
                pad(tierLabel(r.tier), 7) +
                pad(silenceLabel, 8) +
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
        const filter: { tier?: Tier; status?: AlertStatus; groupName?: string | null } = {};
        if (flags['level'] !== undefined) {
          const t = requireId(flags['level'], '--level');
          if (!(TIERS as readonly number[]).includes(t)) throw new UsageError('--level 只能是 30、14 或 7');
          filter.tier = t as Tier;
        }
        if (flags['status'] !== undefined) {
          if (flags['status'] !== 'open' && flags['status'] !== 'acknowledged') {
            throw new UsageError('--status 只能是 open 或 acknowledged');
          }
          filter.status = flags['status'];
        }
        if (flags['group'] !== undefined) filter.groupName = resolveGroupName(db, flags['group']);
        const alerts = listAlerts(db, filter);
        if (alerts.length === 0) {
          console.log('（没有符合条件的告警）');
          break;
        }
        console.log(
          pad('ID', 5) + pad('档位', 7) + pad('监控项', 26) + pad('分组', GROUP_COL) + pad('首次告警日', 13) + pad('状态', 10) + pad('处理人', 10) + '备注',
        );
        for (const a of alerts) {
          console.log(
            pad(String(a.id), 5) +
              pad(tierLabel(a.tier), 7) +
              pad(`${a.item_name}(${KIND_LABEL[a.item_kind]})`, 26) +
              pad(a.item_group ?? '-', GROUP_COL) +
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
        const targetItem = flags['item'] !== undefined;
        const targetGroup = flags['group'] !== undefined;
        if (targetItem === targetGroup) {
          throw new UsageError('silence add 必须且只能指定一个目标：--item <id> 或 --group <组>');
        }
        // 组静默默认一键 24 小时；单项静默沿用旧用法，仍需显式 --hours
        let hours: number;
        if (flags['hours'] !== undefined) {
          hours = parseHours(flags['hours']);
        } else if (targetGroup) {
          hours = 24;
        } else {
          throw new UsageError('缺少参数 --hours（单项静默需显式指定 1~24 小时）');
        }
        const endsAt = now + Math.round(hours * 3600 * 1000);
        const reason = flags['reason'] ?? null;

        if (targetGroup) {
          const groupName = resolveGroupName(db, flags['group']);
          const members = listItems(db, { groupName });
          if (members.length === 0) throw new UsageError(`分组 ${groupName} 内没有监控项`);
          const id = addGroupSilenceWindow(db, {
            groupName,
            startsAt: now,
            endsAt,
            reason,
            createdAt: now,
          });
          console.log(
            `已设置组静默 #${id}：分组 ${groupName}（${members.length} 项，含期间新入组项）` +
              `${formatShanghai(now)} ~ ${formatShanghai(endsAt)}，到点自动恢复`,
          );
        } else {
          const itemId = requireId(flags['item'], '监控项 ID');
          const item = getItem(db, itemId);
          if (!item) throw new UsageError(`监控项 #${itemId} 不存在`);
          const id = addSilenceWindow(db, {
            itemId,
            startsAt: now,
            endsAt,
            reason,
            createdAt: now,
          });
          console.log(
            `已设置静默窗口 #${id}：监控项 #${itemId}（${item.name}）${formatShanghai(now)} ~ ${formatShanghai(endsAt)}`,
          );
        }
        break;
      }

      case 'silence list': {
        console.log(pad('ID', 5) + pad('对象', 18) + pad('开始', 22) + pad('结束', 22) + pad('状态', 8) + '原因');
        let empty = true;

        const itemRows = flags['group'] === undefined
          ? listSilenceWindows(db, flags['item'] !== undefined ? requireId(flags['item'], '监控项 ID') : undefined)
          : [];
        for (const w of itemRows) {
          empty = false;
          const active = w.starts_at <= now && w.ends_at > now;
          const item = getItem(db, w.item_id);
          console.log(
            pad(String(w.id), 5) +
              pad(`项#${w.item_id} ${item ? item.name : ''}`.slice(0, 16), 18) +
              pad(formatShanghai(w.starts_at), 22) +
              pad(formatShanghai(w.ends_at), 22) +
              pad(active ? '生效中' : '已结束', 8) +
              (w.reason ?? ''),
          );
        }

        const groupRows = flags['item'] === undefined
          ? listGroupSilenceWindows(db, flags['group'] !== undefined ? resolveGroupName(db, flags['group']) : undefined)
          : [];
        for (const w of groupRows) {
          empty = false;
          const active = w.starts_at <= now && w.ends_at > now;
          console.log(
            pad(String(w.id), 5) +
              pad(`组 ${w.group_name}`, 18) +
              pad(formatShanghai(w.starts_at), 22) +
              pad(formatShanghai(w.ends_at), 22) +
              pad(active ? '生效中' : '已结束', 8) +
              (w.reason ?? ''),
          );
        }

        if (empty) console.log('（没有静默窗口）');
        break;
      }

      case 'report': {
        const today = shanghaiDate(now);
        const horizon = addDays(today, 30);
        const groupName = flags['group'] !== undefined ? resolveGroupName(db, flags['group']) : undefined;
        const expiring = itemsExpiringBetween(db, today, horizon, groupName);
        const openAlerts = listAlerts(db, {
          status: 'open',
          ...(groupName !== undefined ? { groupName } : {}),
        });
        const scope = groupName ? `（分组 ${groupName}）` : '';

        console.log(`== 未来 30 天内到期的监控项${scope}（${today} ~ ${horizon}，Asia/Shanghai）==`);
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
        console.log(`== 未处理告警${scope} ==`);
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

      case 'report csv': {
        const groupName = resolveGroupName(db, flags['group']);
        const today = shanghaiDate(now);
        // 三档窗口：今天起 30 天内到期（含已过期），档位由剩余天数按 30/14/7 归并
        const horizon = addDays(today, 30);
        const rows = groupExpiryReport(
          db,
          groupName,
          horizon,
          (expiresOn) => daysBetween(today, expiresOn),
          tierForDaysLeft,
        );
        const header = ['域名', '到期日', '档位', '处理状态'];
        const lines = [header, ...rows.map((r) => [r.name, r.expires_on, `${r.tier}天档`, tierStatusLabel(r.alert_status)])]
          .map((cols) => cols.map(csvCell).join(','))
          .join('\r\n');
        // UTF-8 BOM 让 Excel 直接双击打开不乱码；CRLF 为 RFC 4180 行分隔
        const csv = '\uFEFF' + lines + '\r\n';
        const out = flags['out'];
        if (out !== undefined) {
          writeFileSync(out, csv, 'utf8');
          console.log(`已导出分组 ${groupName} 的到期报表：${rows.length} 行 → ${out}`);
        } else {
          process.stdout.write(csv);
        }
        break;
      }
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
