## Context

Plan A Phase A1(见 `docs/hangar-migration-plan-a.md`)。经代码核实:「P0 即时推」机制已存在于 `realtime-alerts` 能力 + `alert-scan.ts` 高频 lane,完整实现确定性 `importance_score >= 85` 门(env `ALERT_IMPORTANCE_THRESHOLD`)、LLM 禁判、只采 `{rss,hacker_news,github}`、`published_at` 时效窗、与日报原子 claim 共评分、`target_type='alert'` 专用幂等(跨天 per-channel 可靠补发)、per-event 锁。**默认关**(`ALERT_SCAN_ENABLED='false'`,`env.ts:371`「功能打磨期关闭」)。A1 = 产品化并启用,不新建机制。约束:本仓第一架构原则(确定性状态由程序+DB,不交 LLM);守 `policy-push-timeliness`(禁上线后批量推旧消息)。

**现状要点(代码核实):**
- `alert-scan.ts:239` 告警候选 `canonicalUrl: null`(「本期保守置 null」);`:168` 已设计经 `representative_raw_item_id` 回指 `raw_items.canonical_url`,只是未接。
- 告警渲染走 headline 回退链(`:389`),告警事件「可能尚无中文摘要」(告警链不跑日报的中文摘要阶段)。
- `ALERT_SCAN_CRON` 默认 `*/20`;`ALERT_MAX_PER_SCAN=5`;`ALERT_FIRST_SEEN_WINDOW_DAYS=3`(基于 `published_at`)。
- P0 = value-judge 输出的 `importance_score >= 阈值`(已存在、env 可调)。注:`long_term_value` 列**存在**(schema.ts:292/383)但由提炼 Agent 产出、作 KB 准入闸 `>=70`,**非 value-judge 输出、非 P0 门**。
- `alert-scan` 已有 A0 的 `run(ctx)` 包装 + `options.emit` + stage emit(trigger=`alert-scan`)。

## Goals / Non-Goals

**Goals:** 补齐挡上线的两处打磨(原文链接、中文摘要)、调频、启用、加 P0 可观测;复用现有确定性门。

**Non-Goals:** 不新建 P0 字段/层、不改判定归属(仍程序阈值、不交 LLM)、不动幂等结构、不动采集源子集、不降级日报(A4)、不做 KB 结构化(A2)/RAG、不引 hangar、告警不走审批。

## Decisions

**D1. 复用现有 `importance_score >= ALERT_IMPORTANCE_THRESHOLD` 门,不加新字段。** P0 语义已由现有 `importance_score` 阈值(默认 85、严于日报 75/Top-N 60)表达、env 可调;`long_term_value`(**存在**,但是 KB 准入闸 `>=70`、由提炼 Agent 产出、非 value-judge 输出)非 P0 门。加新字段/层=违反「最小、复用现有」且改 value-judge 能力,无必要。

**D2. canonicalUrl:接已设计好的回指,不新建。** 告警候选 `canonicalUrl` 从 `null` 改为经 `representative_raw_item_id` 回指 `raw_items.canonical_url`(`normalizeUrl` 已在采集期去追踪参数);NULL 时消息无链接、不报错。机制 `:168` 已声明,只补线。

**D3. 中文摘要:对入选候选(≤5)各跑一次 `summarizeEvent` 生成中文标题/摘要并持久化,回退链降为兜底。** 告警链不跑日报的摘要阶段;对入选 P0 候选(极少、≤ `ALERT_MAX_PER_SCAN`)中缺 `headline_zh`/`summary_zh` 者,**复用日报摘要 Agent 的 `summarizeEvent`**(`agents/digest/index.ts:107`,纯 per-event 调用)生成 `{headline_zh, summary_zh}`——告警消息渲染取 `headline_zh`(`resolveHeadlineText`),故 headline 必须补上。**持久化**(经 `digestEvent`/persistence 写回 `ai_news_events`),使该事件若后进日报被「已摘要守卫」(`run-daily-workflow.ts:704`)复用、不重复摘要;与日报并发 double-UPDATE 为 last-write-wins、两值皆合法、无害(RC 核实)。**生成失败才走 headline 回退链**(`headline_zh → summary_zh 截断 → representative_title → 仅标题`,摘要缺失/失败绝不漏告警)。
- 措辞澄清:「轻量」指**范围轻**(只 ≤5 条入选候选、不是整链),非「更轻的 LLM 调用」——用的就是 `summarizeEvent` 同一 per-event 调用。
- 备选「不加摘要、只用回退链」:否决——原始英文标题作 P0 告警 UX 差,正是「打磨期关闭」的原因之一。
- 备选「ephemeral 不持久化」:否决——同事件后进日报会被重摘要一次;持久化更省且被日报守卫复用。

**D4. 调频 + 启用作配置决策。** `ALERT_SCAN_CRON` 默认 `*/20 → */15`(仍 env 可配)。**取 `*/15` 而非 `*/10`**:base spec「重大发布事件级实时告警」需求写「默认保守如 15–30 分钟」,`*/10` 会低于该保守下界、与**未修改**的该需求冲突;`*/15` 落在 15–30 窗口内、无需为调频再改一条需求,且对 P0(稀有)已足够即时。`ALERT_SCAN_ENABLED` 推上生产(部署置 `'true'`,worker-main 才注册 alert 链)。频率是可调值,spec 不钉具体数。

**D5. P0 可观测:确定性旁路记录,不加对外副作用。** 每扫描结构化记录告警计数 + 命中 `importance_score` 分布 + `event_id`/`channel`(经 `ctx.emit`/pino,复用 A0 seam);纯观测、不 LLM 判质量、不额外推送、不改判定。供人工抽检精确/召回/噪音率(= A1 出口闸验证信号)。

**D6. 首次启用防旧消息刷屏:用发布时间基线水位,不写假 success 哨兵(守 `policy-push-timeliness`)。** 启用瞬间,`published_at` 近 N 天(默认 3)内、`importance >= 85`、从未告警的**存量**事件会成候选 → 违反「禁上线后批量推旧消息」。P0 稀有但**不可假设为 0**。
- **对策:发布时间基线水位。** 记一个基线时刻 `baseline`(= 启用时刻;存为 env `ALERT_MIN_PUBLISHED_AT` ISO 时刻,未设=无基线);告警候选查询加谓词 `published_at >= baseline`——**只告警启用后发布的新闻**,启用前发布的存量(**无论何时被评分、无论后加了哪个通道**)一律排除。
- **为何不用早前的「写 success 哨兵」方案(被本轮 review 否掉):** 对存量各通道写 `push_records(alert, status='success')` 假记录有四处硬伤:① `success` 语义是「已投递」,写无发送的假记录污染真相模型(**虽当前无承重消费者读它**——KB/source-quality/get-today 均按 `target_type='event'` 隔离、已核实——但**前向脆弱**:未来任何读 alert-success 当「已发」的消费者会被骗);② 只覆盖启用时**已评分**的候选,窗内**未评分**的存量启用后被评分 → 仍告警;③ 受 `ALERT_MAX_PER_SCAN=5` 限、只哨兵 5 条,余量启用后逐 tick 漏出;④ 只覆盖当时已配置通道,**后加飞书则存量在飞书重放**。**水位一举全解**:谓词在 `published_at`(评分后取候选时判)→ 与评分状态无关(解②)、无每扫描上限(解③)、与通道无关(解④)、**不写任何假记录**(解①)。
- 与时效窗关系:有效下界 = `max(now − N天, baseline)`;启用日 `baseline ≈ now` → 只新事件;N 天后时效窗自然更紧、baseline 失效。故 baseline 只在启用后头 N 天起作用。
- 边界:`published_at` 恰在 baseline 之前一刻发布的新闻不告警(可接受——「只告警开机后发布的」);`published_at` 为 NULL 者本就被现有 NULL 排除闸挡住,与 baseline 正交。
- **强制而非靠文档(round-2 加固,守 `policy-push-timeliness`):** 水位靠 env 设值,忘设=零抑制→刷屏。故:① `ALERT_MIN_PUBLISHED_AT` 经 Zod 校验为**合法 ISO 时刻或显式空串**(非法值启动 fail-fast,不静默匹配空/静默压制全部);② **`ALERT_SCAN_ENABLED='true'` 但基线未设(既非 ISO 亦非显式空串)→ 启动 fail-fast、拒绝注册告警链**(env `superRefine` 跨字段不变量,仿现有 Feishu 完整性校验)。运维须显式二选一:给 ISO 基线,或空串明示放弃、自担刷屏风险。把守卫从「部署次序文档」升级为「代码强制」。**注(fail-safe 方向):** 基线误设为**未来** ISO(手滑年份/时区)会使 `published_at >= 未来` 匹配空 → 静默压制**全部**告警;这是失败在**安全侧**(静默而非刷屏、不破 `policy-push-timeliness`),且被本变更的 P0 可观测(每扫描 N=0)显式暴露,故只披露、不加额外闸。

## Risks / Trade-offs

- **[启用即真发批量旧消息]** → D6 **发布时间基线水位**(`published_at >= baseline`)排除启用前发布的存量(与评分状态/通道无关);`VITEST` 守卫保测试不真发(钉 channels/注入 sender mock,memory `test-no-prod-sends`);部署按 `deployment-containerized`。
- **[canonicalUrl 回指丢候选]** → 补 canonicalUrl 的回指必须是 **LEFT JOIN/相关子查询**、绝不 INNER JOIN:`representative_raw_item_id` 为 NULL 或 raw_item 行已被塌缩删除时,达阈值事件仍须留在候选(消息无链接),**绝不因回指失败把候选丢掉 → 漏告警**(比无链接更糟)。
- **[高频加采集/评分成本]** → 调频只改 cron;评分沿用共享原子 claim(`claimEventForJudging` CAS)不重复评分,输者 `claimSkipped`;`{rss,hn,github}` 采集频率提约 1.3×(`*/20`→`*/15`),GitHub/HN 速率上限实现期核。
- **[轻量摘要加延迟/成本]** → 只对入选 ≤5 候选、P0 稀有;失败走回退链不阻塞、不漏告警。
- **[高频加 LLM 评分成本]** → 沿用现有原子 claim 与日报共评分、不重复评分;judge 已有超时/预算(`JUDGE_WRITE_BUDGET_MS`)。调频只改 cron,不改评分逻辑。
- **[canonicalUrl 回指失败]** → NULL 时消息无链接、不报错(渲染契约已含)。
- **[P2 局部不变量]** → 现有 spec 声明「告警幂等依赖 importance 一经评分即稳定」;A1 不引入重评分,不变量不受影响。

## Migration Plan

- 普通 PR(实现代码)。回滚 = revert + 置 `ALERT_SCAN_ENABLED='false'`。
- 部署次序:先合并代码(默认仍关)→ 跑一次 D6 告警基线 → 再置 `ALERT_SCAN_ENABLED='true'` 部署。基线与启用分离,避免启用瞬间刷屏。

## Open Questions

- **基线水位存 env `ALERT_MIN_PUBLISHED_AT`(ISO 时刻)还是一行 marker 表?** 倾向 env ISO 时刻(零 schema、部署置为启用时刻);实现期定。
- **观测的抽检节奏**(每日看一次噪音率 vs 累积口径):实现期定;spec 只要求确定性记录本次口径。
