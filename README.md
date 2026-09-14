# expiry-monitor 域名/证书到期监控

跑在内网小主机上的到期监控服务，纯后端 + CLI，无页面。解决域名/证书到期时间散落在注册商后台和 Excel 里、没人盯的问题。

## 功能

- **监控项录入**：域名记注册商和到期日；证书记签发对象和有效期止
- **分组标签**：监控项可打分组（如 `finance`、`web`），列表/告警/报表都能按组筛选；存量项可随时改派分组或移出
- **每日检查**：每天早上 08:00（Asia/Shanghai）自动跑一轮，也可手动触发
- **漏检自愈**：进程启动时若当天还没有成功检查会立即补跑（关机/重启只补今天）；另有每小时第 7 分钟的巡检兜底
- **失败重试**：检查撞上短暂故障（DB 不可用、IO 抖动、SQLITE_BUSY）时按 1/5/15 分钟间隔自动重试（共 4 次尝试）；检查是单事务，失败零写入、重试安全。一轮重试耗尽后下一次整点巡检以全新预算再兜，短暂故障不会造成全天漏检
- **三档告警**：距到期 ≤30 天、≤14 天、≤7 天各记一条告警；同一监控项同一档位的告警未确认前不重复记录（确认后再次命中会重新记）
- **告警处理**：告警列表按级别/状态/分组筛选；处理后登记处理人和备注
- **静默窗口**：
  - 单项静默：给单个监控项设静默窗口（最长 24 小时）
  - **整组静默**：一条命令给整个分组设 24 小时静默，组内所有项罩住，**静默期间新入组的项同样生效**，到点自动恢复
  - 静默期照常检查、照常留检查记录（标记静默来源：单项/组），只是不新增告警
- **只追加的检查历史**：每次检查记 1 条 `check_runs` + 每项 1 条 `check_results`，只 INSERT 不修改，哪天跑了、跑出什么都能回查
- **CLI 报表**：一条命令列出未来 30 天内到期项和未处理告警；三档到期项可按组导出 CSV（域名、到期日、档位、处理状态）

> 老版本数据库直接启动即可：首次打开会自动给旧表补 `group_name`、`silence_kind` 列，原有数据和检查记录不受影响。

## 技术栈

TypeScript + Node.js（≥18），运行时依赖仅 `better-sqlite3` 和 `node-cron`，测试用 Node 内置 `node:test`，无其他依赖。

## 快速开始

```bash
npm install
npm run build        # 编译到 dist/
npm run seed         # 写入 5 条样例数据（可重复执行，同名自动跳过）
npm start            # 启动守护进程：08:00 准点检查，启动即补跑当天，每小时巡检兜底
```

数据库文件默认在 `./data/monitor.db`（首次启动自动建库建表），可用环境变量 `MONITOR_DB` 改路径。

## CLI 用法

所有命令形如 `node dist/src/cli.js <命令>`（也可用 `npm run cli -- <命令>`）。

```bash
# 分组（组名：小写字母/数字/-/_，1~32 字符）
node dist/src/cli.js group add finance --description 财务系统
node dist/src/cli.js group list

# 录入监控项（可直接打组）
node dist/src/cli.js item add --kind domain --name example.cn --registrar 阿里云 --expires 2026-10-13
node dist/src/cli.js item add --kind cert --name api-tls --issued-to api.example.cn --expires 2026-11-01 --group finance
node dist/src/cli.js item list                       # 全部
node dist/src/cli.js item list --group finance       # 只看财务组
node dist/src/cli.js item list --ungrouped           # 只看未分组
node dist/src/cli.js item group 3 --name finance     # 存量项移入 finance 组
node dist/src/cli.js item group 3 --clear            # 移出分组
node dist/src/cli.js item renew 3 --expires 2027-09-13   # 续期后更新到期日（同时自动确认该项未处理告警，结束上一告警周期）

# 检查
node dist/src/cli.js check run                 # 手动触发一次检查
node dist/src/cli.js check history             # 历次检查概览
node dist/src/cli.js check history --run 2     # 某次检查的逐项结果（静默列：组/单项/否）

# 告警
node dist/src/cli.js alert list                            # 全部告警
node dist/src/cli.js alert list --level 7 --status open    # 按级别+状态筛
node dist/src/cli.js alert list --group finance            # 只看财务组
node dist/src/cli.js alert ack 2 --handler 张三 --note 已续费

# 静默窗口（最长 24 小时）
node dist/src/cli.js silence add --item 6 --hours 8 --reason 休假      # 单项静默
node dist/src/cli.js silence add --group finance --reason 财务集体休假  # 整组静默 24h（--hours 可省略，默认 24）
node dist/src/cli.js silence list                                     # 单项+分组窗口统一列出
node dist/src/cli.js silence list --group finance

# 报表：未来 30 天到期项 + 未处理告警（可加 --group）
node dist/src/cli.js report
node dist/src/cli.js report --group finance

# 按组导出三档到期项 CSV：域名,到期日,档位,处理状态（UTF-8 BOM，Excel 直接打开）
node dist/src/cli.js report csv --group finance --out finance-expiry.csv
node dist/src/cli.js report csv --group finance          # 不传 --out 输出到标准输出
```

### 组静默验收流程

```bash
node dist/src/cli.js group add finance
node dist/src/cli.js item add --kind domain --name pay.example.cn --registrar 阿里云 --expires <5天后> --group finance
# …再录 4 条 finance 项…
node dist/src/cli.js silence add --group finance --reason 财务集体休假   # 到点自动恢复
node dist/src/cli.js check run        # finance 五项标记"组静默中"，新增告警=0；其他组正常告警
# 静默期内新录入/新入组的 finance 项，下一次 check run 同样不冒告警
node dist/src/cli.js check history --run <runId>   # 静默列=组，检查记录照常留
# 24 小时后（或把检查时刻拨到 ends_at 之后）再 check run：五项自动恢复告警
node dist/src/cli.js report csv --group finance --out finance.csv  # 5 行，含档位与处理状态
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
- **去重**：同一监控项、同一档位，已存在"未处理"告警时不再重复记录；确认（ack）后再次命中该档会重新记一条，保证续期拖延能被再次提醒。`item renew` 续期时会在同一事务里把该项未处理告警自动确认（处理人标记"（续期）"），结束上一告警周期——否则上一周期遗留的未处理告警会把新一轮到期的同档位告警永久拦截。
- **静默**：窗口最长 24 小时（数据库 CHECK 约束 + 代码双重校验）。单项窗口只作用于指定监控项；组窗口作用于该组——检查时按监控项当前的 `group_name` 实时判定，因此**窗口期间新入组的项同样被罩住、退组即脱离**。静默期检查照常跑、检查记录照常写（标记 silenced=1 及来源 `item`/`group`），只是不产生新告警。窗口结束无需任何操作，下一次检查自然恢复告警。
- **日期**："哪一天"一律按 Asia/Shanghai 判定（调度、分档、告警日期、报表口径都是），与主机系统时区无关。
- **每日检查的可靠性**：检查是否成功以当天 `check_runs` 是否有记录为准（检查是单事务，失败整体回滚、零写入）。三个触发源——08:00 定时、进程启动补跑、每小时第 7 分巡检——都只做一件事："当天没有成功记录就跑一次"，因此关机重启、08:00 那一刻进程不在线、单次检查撞上短暂故障，当天都不会漏检。故障期间的重试间隔为 1/5/15 分钟；手动 `check run` 落的记录同样算作"今日已检"。历史日期不补（无法重建当时状态），只补今天。进程内有防重入；但不要同时起两个守护进程（建议 systemd 单实例），双实例最多产生重复检查记录，告警靠 open 去重不会重复。

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
npm test    # 编译并运行 node:test 测试（62 个用例）
```

覆盖：到期分档边界（30/14/7 及档外、已过期）、重复告警拦截（未确认不重复、确认后重新记、档位升级各记一条）、续期告警周期（续期自动确认上一周期 open 告警、新一轮到期重新告警）、旧库迁移（补列 + 历史静默记录回填）、静默窗口（单项与整组两种：24 小时上限、静默期不新增但留检查记录、只作用于对应对象、**组静默罩住期间新入组项、到点自动恢复**、单项与组窗口叠加时来源标记）、分组筛选与改派、按组到期报表（档位归并 + 未处理/已确认/未告警状态）、跨月/跨年/闰年边界与上海时区日期判定、**每日检查可靠性（启动/巡检补跑、当天已跑则跳过、隔天再跑、失败按递增间隔重试、耗尽零写入且下轮恢复、进程内防重入、重试期间被手动补齐、跨午夜重试、withRetry 纯函数）**。

## 目录结构

```
src/
  time.ts       时区与日期工具（Asia/Shanghai 口径）
  expiry.ts     到期分档（纯函数）
  alerts.ts     告警判定：分档/去重/静默（纯函数）
  db.ts         SQLite 打开与建表
  repo.ts       数据访问层（全部 SQL）
  checker.ts    检查编排：判定 → 落库（单事务，只追加）
  retry.ts      通用异步重试（1/5/15 分钟间隔，可注入 sleep）
  daily.ts      每日检查保证：当天缺检则补跑 + 进程内防重入（纯编排，可注入）
  scheduler.ts  服务入口：08:00 准点 + 启动补跑 + 每小时第 7 分巡检
  cli.ts        CLI 全部命令
  seed.ts       5 条样例数据
test/           node:test 测试
```
