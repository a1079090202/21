/**
 * CLI 参数严格校验：错误输入必须退出码 2 且不产生任何副作用。
 *
 * 通过 spawn 编译后的 cli.js 做黑盒测试（npm test 会先跑 tsc），
 * 每个用例使用独立临时库文件，MONITOR_DB 指过去。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { listCheckRuns, listGroups, listItems, listSilenceWindows } from '../src/repo.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'expiry-cli-args-'));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let seq = 0;
function runCli(args: string[]): CliResult {
  const dbPath = join(ROOT, `case-${seq++}.db`);
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, MONITOR_DB: dbPath },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** 以独立库执行一组命令，返回最后一条命令的结果与库内状态句柄 */
function setup(commands: string[][]): string {
  const dbPath = join(ROOT, `case-${seq++}.db`);
  for (const args of commands) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, MONITOR_DB: dbPath },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `前置命令失败：${args.join(' ')}\n${r.stderr}`);
  }
  return dbPath;
}

function expectUsageError(r: CliResult, messageHint?: RegExp | string): void {
  assert.equal(r.code, 2, `期望退出码 2，实际 ${r.code}；stdout=${r.stdout}`);
  assert.match(r.stderr, /^参数错误：/);
  if (messageHint) {
    typeof messageHint === 'string'
      ? assert.ok(r.stderr.includes(messageHint), `stderr 应包含 "${messageHint}"，实际：${r.stderr}`)
      : assert.match(r.stderr, messageHint);
  }
  assert.equal(r.stdout, '');
}

test('无参数：只打印用法，退出码 0', () => {
  const r = runCli([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^用法：/);
});

test('未知命令：退出码 1 且不创建数据库文件', () => {
  const dbPath = join(ROOT, `case-${seq++}.db`);
  const r = spawnSync(process.execPath, [CLI, 'frobnicate'], {
    env: { ...process.env, MONITOR_DB: dbPath },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^用法：/);
  assert.ok(!existsSync(dbPath), '未知命令不应打开/创建数据库');
});

test('只给一级动词（check / group / item / alert / silence）：退出码 1', () => {
  for (const verb of ['check', 'group', 'item', 'alert', 'silence']) {
    assert.equal(runCli([verb]).code, 1, verb);
  }
});

test('未知 flag 被拒绝：item add --force 退出码 2 且不写入监控项', () => {
  const r = runCli([
    'item', 'add', '--kind', 'domain', '--name', 'a.cn',
    '--registrar', '阿里云', '--expires', '2026-10-01', '--force',
  ]);
  expectUsageError(r, /未知参数 --force/);

  const dbPath = join(ROOT, `case-${seq - 1}.db`);
  const db = openDb(dbPath);
  try {
    assert.equal(listItems(db).length, 0);
  } finally {
    db.close();
  }
});

test('flag 拼写错误（--expir）不再被静默忽略：缺 --expires 退出码 2', () => {
  const r = runCli([
    'item', 'add', '--kind', 'domain', '--name', 'a.cn',
    '--registrar', '阿里云', '--expir', '2026-10-01',
  ]);
  expectUsageError(r, /未知参数 --expir/);
});

test('值参数后面跟另一个 flag：报缺少值，不会把 flag 名吞成值', () => {
  const r = runCli([
    'item', 'add', '--kind', 'domain', '--name', 'a.cn',
    '--registrar', '--expires', '2026-10-01',
  ]);
  expectUsageError(r, /--registrar 缺少值/);
});

test('值参数位于结尾缺值：退出码 2', () => {
  expectUsageError(runCli(['item', 'renew', '1', '--expires']), /--expires 缺少值/);
  expectUsageError(runCli(['report', 'csv', '--group', 'finance', '--out']), /--out 缺少值/);
});

test('开关参数不接受值：--ungrouped=true 退出码 2', () => {
  expectUsageError(runCli(['item', 'list', '--ungrouped=true']), /--ungrouped 是开关参数/);
});

test('同一 flag 重复出现：退出码 2', () => {
  const r = runCli([
    'item', 'add', '--kind', 'domain', '--kind', 'cert',
    '--name', 'a.cn', '--expires', '2026-10-01',
  ]);
  expectUsageError(r, /--kind 重复出现/);
});

test('多余位置参数：group add finance extra 退出码 2 且不建组', () => {
  const r = runCli(['group', 'add', 'finance', 'extra']);
  expectUsageError(r, /多余的位置参数/);
  const dbPath = join(ROOT, `case-${seq - 1}.db`);
  const db = openDb(dbPath);
  try {
    assert.equal(listGroups(db).length, 0);
  } finally {
    db.close();
  }
});

test('缺少位置参数：group add / item renew 无 id 退出码 2', () => {
  expectUsageError(runCli(['group', 'add']), /缺少位置参数/);
  expectUsageError(runCli(['item', 'renew', '--expires', '2027-01-01']), /缺少位置参数/);
  expectUsageError(runCli(['alert', 'ack', '--handler', '张三', '--note', 'x']), /缺少位置参数/);
});

test('不允许位置参数的命令带了位置参数：check run now 退出码 2 且不落检查记录', () => {
  const r = runCli(['check', 'run', 'now']);
  expectUsageError(r, /多余的位置参数/);
  const dbPath = join(ROOT, `case-${seq - 1}.db`);
  const db = openDb(dbPath);
  try {
    assert.equal(listCheckRuns(db).length, 0);
  } finally {
    db.close();
  }
});

test('互斥参数同传：item list --group + --ungrouped、silence add --item + --group 退出码 2', () => {
  const dbPath = setup([['group', 'add', 'finance']]);
  const runWithDb = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, MONITOR_DB: dbPath },
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };
  expectUsageError(runWithDb(['item', 'list', '--group', 'finance', '--ungrouped']), /不能同时使用/);
  expectUsageError(runWithDb(['silence', 'add', '--item', '1', '--group', 'finance', '--hours', '8']), /不能同时使用/);
  expectUsageError(runWithDb(['silence', 'list', '--item', '1', '--group', 'finance']), /不能同时使用/);
});

test('silence add 两个目标都不给 / 单项静默缺 --hours：退出码 2', () => {
  expectUsageError(runCli(['silence', 'add', '--reason', '休假']), /必须且只能指定一个目标/);
  const dbPath = setup([
    ['group', 'add', 'finance'],
    ['item', 'add', '--kind', 'domain', '--name', 'a.cn', '--registrar', '阿里云', '--expires', '2026-10-01'],
  ]);
  const r = spawnSync(process.execPath, [CLI, 'silence', 'add', '--item', '1'], {
    env: { ...process.env, MONITOR_DB: dbPath },
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /缺少参数 --hours/);
  const db = openDb(dbPath);
  try {
    assert.equal(listSilenceWindows(db).length, 0);
  } finally {
    db.close();
  }
});

test('--hours 非法数字（0x10 / 12h / 25 / 0）：退出码 2 且不写静默窗口', () => {
  const dbPath = setup([
    ['item', 'add', '--kind', 'domain', '--name', 'a.cn', '--registrar', '阿里云', '--expires', '2026-10-01'],
  ]);
  for (const bad of ['0x10', '12h', '1e2', '25', '0', '-1', 'abc']) {
    const r = spawnSync(process.execPath, [CLI, 'silence', 'add', '--item', '1', '--hours', bad], {
      env: { ...process.env, MONITOR_DB: dbPath },
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, `--hours ${bad} 应被拒绝`);
  }
  const db = openDb(dbPath);
  try {
    assert.equal(listSilenceWindows(db).length, 0);
  } finally {
    db.close();
  }
});

test('ID 必须是正整数：小数/十六进制/字母退出码 2', () => {
  expectUsageError(runCli(['item', 'renew', '1.5', '--expires', '2027-01-01']), /必须是正整数/);
  expectUsageError(runCli(['item', 'group', '0x1', '--clear']), /必须是正整数/);
  expectUsageError(runCli(['check', 'history', '--run', 'abc']), /必须是正整数/);
  expectUsageError(runCli(['alert', 'list', '--level', '15']), /30、14 或 7/);
});

test('非法日期：退出码 2（含 2 月 30 日这类不存在的日期）', () => {
  expectUsageError(
    runCli(['item', 'add', '--kind', 'domain', '--name', 'a.cn', '--registrar', '阿里云', '--expires', '2026-02-30']),
    /必须是真实日期/,
  );
  expectUsageError(
    runCli(['item', 'renew', '1', '--expires', '2026/10/01']),
    /必须是真实日期/,
  );
});

test('--k=v 形式与正常命令链路不受严格解析影响（建组→录入→检查→组静默）', () => {
  const dbPath = join(ROOT, `case-${seq++}.db`);
  const run = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, MONITOR_DB: dbPath },
      encoding: 'utf8',
    });

  let r = run(['group', 'add', 'finance', '--description=财务']);
  assert.equal(r.status, 0, r.stderr);
  r = run([
    'item', 'add', '--kind=domain', '--name=a.cn',
    '--registrar=阿里云', '--expires=2026-10-01', '--group=finance',
  ]);
  assert.equal(r.status, 0, r.stderr);
  r = run(['check', 'run']);
  assert.equal(r.status, 0, r.stderr);
  // 组静默可省略 --hours（默认 24）
  r = run(['silence', 'add', '--group', 'finance', '--reason', '休假']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['report', 'csv', '--group', 'finance']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /a\.cn/);
});

test('report csv --out 指向文件时正常落盘；缺值时不创建任何文件', () => {
  const dbPath = setup([
    ['group', 'add', 'finance'],
    ['item', 'add', '--kind', 'domain', '--name', 'a.cn', '--registrar', '阿里云', '--expires', '2026-10-01', '--group', 'finance'],
  ]);
  const outFile = join(ROOT, `report-${seq}.csv`);
  let r = spawnSync(process.execPath, [CLI, 'report', 'csv', '--group', 'finance', '--out', outFile], {
    env: { ...process.env, MONITOR_DB: dbPath },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(outFile), 'CSV 应写入 --out 指定文件');

  const missingOut = join(ROOT, `report-missing-${seq}.csv`);
  r = spawnSync(process.execPath, [CLI, 'report', 'csv', '--group', 'finance', '--out'], {
    env: { ...process.env, MONITOR_DB: dbPath },
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(missingOut));
});

test('report csv 对以 = + - @ 或制表符开头的名称前置单引号，防止表格软件按公式执行', () => {
  // 名称无字符校验，恶意名称可原样入库；导出时必须中和，而非仅做 RFC 4180 转义
  const malicious = [
    '=1+1',
    '+1+1',
    '-1+1',
    '@SUM(1+1)',
    '\t=HYPERLINK("http://evil.example","x")',
  ];
  const cmds: string[][] = [['group', 'add', 'finance']];
  malicious.forEach((name, i) => {
    cmds.push([
      'item', 'add', '--kind', 'cert', '--name', name, '--issued-to', 'x',
      '--expires', `2026-10-0${i + 1}`, '--group', 'finance',
    ]);
  });
  const dbPath = setup(cmds);
  const r = spawnSync(process.execPath, [CLI, 'report', 'csv', '--group', 'finance'], {
    env: { ...process.env, MONITOR_DB: dbPath },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  // 去掉 BOM 后逐行检查：剥掉 RFC 4180 双引号包裹，每个数据单元格都不得以公式字符开头
  const out = r.stdout.charCodeAt(0) === 0xfeff ? r.stdout.slice(1) : r.stdout;
  const lines = out.trim().split('\r\n');
  assert.equal(lines[0], '域名,到期日,档位,处理状态');
  assert.equal(lines.length, malicious.length + 1);
  for (const line of lines.slice(1)) {
    for (const cell of line.split(',')) {
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      assert.doesNotMatch(unquoted, /^[=+@\t\r-]/, `未中和公式注入的单元格：${cell}`);
    }
  }
  assert.match(r.stdout, /'=1\+1/);
  assert.match(r.stdout, /'\t=/);
  // 普通名称不应被加单引号
  const normal = setup([
    ['group', 'add', 'ops'],
    ['item', 'add', '--kind', 'domain', '--name', 'a.cn', '--registrar', '阿里云', '--expires', '2026-10-01', '--group', 'ops'],
  ]);
  const r2 = spawnSync(process.execPath, [CLI, 'report', 'csv', '--group', 'ops'], {
    env: { ...process.env, MONITOR_DB: normal },
    encoding: 'utf8',
  });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /\r?\na\.cn,2026-10-01/);
});

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
