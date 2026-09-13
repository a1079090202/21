# expiry-monitor 域名/证书到期监控

跑在内网小主机上的到期监控服务，纯后端 + CLI，无页面。解决域名/证书到期时间散落在注册商后台和 Excel 里、没人盯的问题。

## 功能

- **监控项录入**：域名记注册商和到期日；证书记签发对象和有效期止
- **每日检查**：每天早上 08:00（Asia/Shanghai）自动跑一轮，也可手动触发
- **三档告警**：距到期 ≤30 天、≤14 天、≤7 天各记一条告警；同一监控项同一档位的告警未确认前不重复记录（确认后再次命中会重新记）
- **告警处理**：告警列表按级别/状态筛选；处理后登记处理人和备注
- **静默窗口**：休假时给单个监控项设静默窗口（最长 24 小时），静默期照常检查、照常留检查记录，只是不新增告警
- **只追加的检查历史**：每次检查记 1 条 `check_runs` + 每项 1 条 `check_results`，只 INSERT 不修改，哪天跑了、跑出什么都能回查
- **CLI 报表**：一条命令列出未来 30 天内到期项和未处理告警

## 技术栈

TypeScript + Node.js（≥18），运行时依赖仅 `better-sqlite3` 和 `node-cron`，测试用 Node 内置 `node:test`，无其他依赖。

## 快速开始

```bash
npm install
npm run build        # 编译到 dist/
npm run seed         # 写入 5 条样例数据（可重复执行，同名自动跳过）
npm start            # 启动守护进程：每天 08:00 (Asia/Shanghai) 自动检查
```

数据库文件默认在 `./data/monitor.db`（首次启动自动建库建表），可用环境变量 `MONITOR_DB` 改路径。

## CLI 用法

所有命令形如 `node dist/src/cli.js <命令>`（也可用 `npm run cli -- <命令>`）。

```bash
# 录入监控项
node dist/src/cli.js item add --kind domain --name example.cn --registrar 阿里云 --expires 2026-10-13
node dist/src/cli.js item add --kind cert --name api-tls --issued-to api.example.cn --expires 2026-11-01
node dist/src/cli.js item list
node dist/src/cli.js item renew 3 --expires 2027-09-13   # 续期后更新到期日

# 检查
node dist/src/cli.js check run                 # 手动触发一次检查
node dist/src/cli.js check history             # 历次检查概览
node dist/src/cli.js check history --run 2     # 某次检查的逐项结果

# 告警
node dist/src/cli.js alert list                            # 全部告警
node dist/src/cli.js alert list --level 7 --status open    # 按级别+状态筛
node dist/src/cli.js alert ack 2 --handler 张三 --note 已续费

# 静默窗口（最长 24 小时）
node dist/src/cli.js silence add --item 6 --hours 8 --reason 休假
node dist/src/cli.js silence list

# 报表：未来 30 天到期项 + 未处理告警
node dist/src/cli.js report
```

## 验收流程（对应需求约定）

```bash
npm install && npm run build && npm run seed
node dist/src/cli.js item add --kind domain --name test.example.cn --registrar 阿里云 --expires $(date -d "+5 days" +%F)
node dist/src/cli.js check run        # 能看到该域名命中 7 天档，新增告警
node dist/src/cli.js report           # "未处理告警"里有这条 7 天档告警
node dist/src/cli.js silence add --item <id> --hours 8 --reason 休假
node dist/src/cli.js check run        # 新增告警=0，该项标记"静默中"
node dist/src/cli.js check history --run <runId>   # 检查结果仍在，silenced=是
```

## 规则说明

- **分档**：剩余天数 ≤7 → 7 天档；≤14 → 14 天档；≤30 → 30 天档；>30 不告警。一个项某一时刻只属最紧的一档（剩 5 天只记 7 天档）。已过期（剩余为负）按 7 天档持续告警。
- **去重**：同一监控项、同一档位，已存在"未处理"告警时不再重复记录；确认（ack）后再次命中该档会重新记一条，保证续期拖延能被再次提醒。
- **静默**：窗口最长 24 小时（数据库 CHECK 约束 + 代码双重校验），只作用于指定监控项；静默期检查照常跑、检查记录照常写（标记 silenced=1），只是不产生新告警。
- **日期**："哪一天"一律按 Asia/Shanghai 判定（调度、分档、告警日期、报表口径都是），与主机系统时区无关。

## 备份与恢复

数据库是单个 SQLite 文件，未开 WAL，任何非写入时刻直接拷贝即是一致备份：

```bash
systemctl stop expiry-monitor        # 或确认不在整点检查窗口
cp data/monitor.db /backup/monitor-$(date +%F).db
# 恢复：把备份文件放回原路径即可
```

所有状态（监控项、告警确认状态、静默窗口、检查历史）都在这个文件里，程序重启不丢。

## 测试

```bash
npm test    # 编译并运行 node:test 测试（18 个用例）
```

覆盖：到期分档边界（30/14/7 及档外、已过期）、重复告警拦截（未确认不重复、确认后重新记、档位升级各记一条）、静默窗口（24 小时上限、静默期不新增但留检查记录、只作用于指定项）、跨月/跨年/闰年边界与上海时区日期判定。

## 目录结构

```
src/
  time.ts       时区与日期工具（Asia/Shanghai 口径）
  expiry.ts     到期分档（纯函数）
  alerts.ts     告警判定：分档/去重/静默（纯函数）
  db.ts         SQLite 打开与建表
  repo.ts       数据访问层（全部 SQL）
  checker.ts    检查编排：判定 → 落库（单事务，只追加）
  scheduler.ts  服务入口：node-cron 每天 08:00 调度
  cli.ts        CLI 全部命令
  seed.ts       5 条样例数据
test/           node:test 测试
```
