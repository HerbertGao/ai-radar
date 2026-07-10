## 上下文

现有系统级故障告警在 `daily-intel-pipeline`（`classifySystemFailure`）里，只判「采集返回总数 = 0」或「新闻类可处理数 = 0」——即**全源皆挂**。单源长期归零、只要其它源仍产出就完全静默。本轮三起失效（RSS 抛错被 `allSettled` 吞、blogger 从未出数、product_hunt 成功返回 0）都属这一盲区。

现成可复用的基建：日报工作流 `runDailyWorkflow` 已在 digest 锁内跑，已有 `AlertSink`（默认 `console.error`，生产可注入 Telegram），已有 `countAiGatedOut` 这一「best-effort、try/catch 隔离、仅日志、不进熔断」的诊断阶段范式。`raw_items` 已有 `source` + `fetched_at` 列。collector registry（`buildRegistry`）已是「已注册源」的单一事实源。

## 目标 / 非目标

**目标：**
- 让「某单源长期零新增」在**天级**（而非月级）被 `AlertSink` 上报。
- 判定 100% 确定性（DB 聚合），阈值 env 可配、可按源覆盖，新增源自动纳入。
- 零新增两种形态都覆盖：采集**抛错**（该源 max(fetched_at) 停在旧值）与采集**成功返回 0 条**（同样 max 不前移）。

**非目标：**
- 不改各 collector 采集逻辑、不改既有系统级（全源=0）告警。
- 不做自动重试 / 自动修复（只"发现并上报"，修复由人决策）。
- 不新增表 / 列 / 迁移（只读 `raw_items` 聚合）。

## 决策

**D1｜检测位置：日报工作流内，采集+塌缩之后、judge 熔断 throw 之前的 best-effort 阶段。**
紧接系统级故障告警块之后（`run-daily-workflow.ts` 约 line 478，`classifySystemFailure` 块后）插入。理由：① 本轮采集已完成，健康源的 `max(fetched_at)` 已刷新到本次运行、死源仍停在旧值——此刻查库能同时抓住"抛错"和"返回 0"两种失效；② 放在 judge/digest 熔断 `throw`（约 line 578 / 716）**之前**，保证熔断日、无候选早退日也照常检测（陈旧度与今日有无新闻正交）；③ 在 digest 锁内跑，锁保证**同一时刻单实例**（排除并发重复）。
- **只借 `countAiGatedOut` 的 try/catch 隔离范式，不借它的位置**：`countAiGatedOut` 在约 line 759（**两个 throw 之后**）；本阶段有意放在 throw 之前（理由②），实现时**不得**并排放到 `countAiGatedOut` 旁边，否则熔断日不检测、违背理由②。
- **retry 重复告警（有意接受）**：放在 throw 之前意味着熔断日 throw 使 BullMQ job 失败并重试（`DAILY_DIGEST_JOB_ATTEMPTS` 默认 3），每次 attempt 从采集重跑 → 该日陈旧告警最多重发 3 次。这与 D4/风险节"死源每日重复告警"是同一档 advisory 容忍度（死源本就该持续可见），有意接受、不额外去重。锁只挡并发、不挡顺序重试。
- *备选*：独立 cron / 独立队列 job——被否，徒增调度面且与日报同频，搭日报锁便车最省。

**D2｜判定查询：一次按源聚合 `max(fetched_at)`，程序侧比阈值。**
```sql
SELECT source, max(fetched_at) AS last_fetched
FROM raw_items
WHERE source = ANY($registeredSources)
GROUP BY source;
```
程序侧对每个**已注册源**取其 `last_fetched`（结果集里缺席的源 = 从未产出 = 视作 NULL → 陈旧），与「参考时刻 − 该源阈值天数」比较。判定纯程序 + DB，无 LLM。
- *不加索引、不迁移（有条件接受）*：`raw_items` 现有索引仅 `UNIQUE(source, source_item_id)`，对 `max(fetched_at)` 无用；一次/天的 seq-scan + hash aggregate 在当前规模开销可忽略（远低于同工作流里的逐条 LLM）。**验收前须实测**该聚合的 `EXPLAIN ANALYZE` 一次以确认；**ponytail 上限**：若实测慢或 `raw_items` 涨到聚合 >数百 ms，升级路径是加 `(source, fetched_at DESC)` 索引（届时单独一个迁移），当前不预造。
- *源集合（排除结构性停用源，防 F2 永久误报）*：默认取 `buildRegistry().map(e => e.source)` 去重（只读 `source`、不触发 `collect()`、不触网；新增 collector 自动纳入），**再剔除本部署结构性不产出的源**——即 list 型配置为空、collector 恒返回 0 的源：`RSS_FEEDS` 空的 `rss`、`BLOGGER_FEEDS` 空的 `blogger`、`SITEMAP_SOURCES` 空的 `sitemap`（三个 list 驱动源各有独立空配置停用开关；其余源无此类空配置开关，恒纳入）。**关键**：单靠"每源阈值放大"无法抑制此类源——它们 `max(fetched_at)` 恒为 NULL（从未产出），NULL 直接判陈旧、绕过任何天数阈值比较，故必须在**源集合层**排除而非靠阈值。区分「配置了 feeds 却 0 行 = 真失效（告警）」与「feeds 为空 = 有意停用（跳过）」由该 feeds-非空判定完成。

**D3｜阈值配置：全局默认 + 单串按源覆盖。**
- `SOURCE_STALENESS_ALERT_DAYS`：全局默认天数（正整数，建议默认 3）。
- `SOURCE_STALENESS_ALERT_DAYS_OVERRIDES`：逗号分隔的 `source:days` 串（如 `product_hunt:2,arxiv:2,blogger:7`），zod 解析为 `Map<source, days>`。某源无覆盖用全局默认。
- 沿用本仓既有「分隔串 env 配置」风格（对齐 `RSS_FEEDS` / `BLOGGER_FEEDS`），一个变量承载全部覆盖，不搞每源一个 env。

**D4｜告警：一次聚合告警列出所有陈旧源。**
发现 ≥1 个陈旧源时，调一次 `AlertSink`，消息体列出每个陈旧源的 `source` + `last_fetched`（或"从未产出"）+ 已零新增天数。无陈旧源则完全不调（不发"一切正常"噪音）。单条聚合告警而非每源一条，避免刷屏。

**D5｜可测性：注入 `now` + 复用 `dbh`。**
检测函数签名 `detectStaleSources({ now, sources?, thresholds? }, dbh)`，`now` 由工作流注入（与 `push_date` 同源），`sources`/`thresholds` 默认取 registry / env、测试可注入。集成测种入不同 `fetched_at` 的 `raw_items` 断言陈旧/新鲜判定；单元测阈值解析与 NULL→陈旧逻辑。

## 风险 / 权衡

- **新注册源首日 NULL 误报** → 一个源刚接入、当天首次采集前 `max(fetched_at)` 为 NULL 会判陈旧。缓解：健康新源当轮采集即产出、`max` 立刻刷新为 now，误报窗口 ≤ 1 天；且告警是**advisory**（不阻断任何流程），一次性噪音可接受，运营看到后要么它已自愈要么正是要查的真失效（blogger 就是"从未出数"的真失效）。
- **低频源误报** → 低频博客/源可能正常数日不更。缓解：`SOURCE_STALENESS_ALERT_DAYS_OVERRIDES` 给该源更大阈值。权衡：阈值需人工按源节奏校准（保留调参旋钮，不追求零配置自动判定）。
- **聚合查询随 `raw_items` 增长变慢** → 见 D2 ponytail 上限（加索引的升级路径已标注，当前规模不需要）。
- **告警去重/频率** → 同一死源每天都会命中、每日重复告警。权衡：本变更范围内接受"每日提醒"（advisory，死源本就该持续可见）；若嫌吵，后续可加"仅状态翻转时告警"的抑制，属独立增量、不在本次范围。
