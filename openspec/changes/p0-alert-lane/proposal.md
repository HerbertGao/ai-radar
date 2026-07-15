## Why

P0 实时告警车道（`realtime-alerts`）自落地起一直关着（`ALERT_SCAN_ENABLED=false`）。**代码是活的、开关是死的**——它从未在生产跑过一轮。开闸不是「翻一个开关」：它会同时激活四个既有缺陷，并且开闸后的告警闸**从一开始就该是终态**，否则同一条 ~200 行的上帝需求要被反复整条重写。

**开闸会激活的缺陷（必须在同一个变更里修掉）：**

0. **告警闸会推非 AI 新闻（设计缺陷，生产实测）。** 支路 A 的闸**只有 `importance >= 阈值`**——**无 `is_ai_related` 闸**。`importance` 衡量「这条新闻有多重要」，**不是「这是不是一条 AI 新闻」**，两根轴正交。生产语料里的 KVM 客户机逃逸 CVE（`importance=95`）、从头合成的活细胞（95）、Linux LUKS 磁盘加密 bug（92）、癌症研究、土卫六探测器、PID 控制器——全是 Hacker News 头版的高 importance 非 AI 新闻。日报**正确地**没推它们（其要闻闸带 `eq(is_ai_related, true)`，`src/selection/top-n.ts:269`）；**关着时无人受害；开闸即把它们推到手机上。**

   > **AI 闸的实测拦截率极低，如实登记**：在 `is_ai_related` 列**全天生效**的三个干净日（2026-07-11 / 07-12 / 07-13），支路 A 候选 **11** 条中 `is_ai_related IS FALSE` 的为 **0 条**（**0 拦 / 11 过**；07-10 回填日挡掉 1/14）。**它是一道尾部保险，不是一道高频过滤器。**它仍必须加（fail-closed、与日报要闻闸同极性、且 `GhostLock` 那条 `should_push=true ∧ is_ai_related=false` 恰证 Judge 的分类是对的），但本变更 **MUST NOT** 用任何「高频拦截」的数字给它背书。

1. **P0 车道对「精确事实变更」结构性失明。** 厂商的**额度 / 限流 / 定价 / 弃用**变更直接改变开发者当日决策，但 `importance_score` 天然偏低（非模型发布、非融资），支路 A 恒抓不到。**不能靠降分数线补**（`developer_relevance >= 85 且 importance < 85` = 269 条 / 7 天，全是开发者博客与教程）——正解是**换一根轴**：一条确定性的标题词表 OR 支路。

2. **cron 违反飞书避整点规则，而守住该规则的断言是空守卫。** `ALERT_SCAN_CRON` 默认 `*/15`（分钟展开 `{0,15,30,45}`）与生产覆盖值 `*/20`（`{0,20,40}`）**双双违反**。现判据（`src/config/__tests__/env.test.ts:221-225`）比较的是**字段字符串**（`expect(['0','30']).not.toContain(minuteField)`）——`*/15` / `*/20` / `*` 全部恒绿，且只查 1 条 cron。**恒绿的守卫等于没有守卫**：它当初就没抓到 `ALERT_SCAN_CRON` 的违反。

3. **回滚判据当前不可测量。** 「观察 N 天的告警质量」建立在 `p0.observed` 上，而它经 pino 落进程 **stdout**（`src/pipeline/run-context.ts:68`）——仓内**无 run 事件落库、无日志聚合**。判据在证伪任何东西之前就已不可执行。所幸告警归因是 DB 列的**纯函数**，`push_records ⋈ ai_news_events` 今天就能复算，无需任何新表/新列/日志基建。

**sitemap 进实时子集买到的是采集延迟，不是告警资格。** `selectAlertCandidates`（`src/pipeline/alert-scan.ts:236-258`）**没有 source 谓词**——`REALTIME_NEWS_SOURCES` 只裁剪**采集**（`:336`），不裁剪**告警资格**。而 `sitemap` **今天就在 `buildRegistry`**（`src/collectors/index.ts:156`）、日报链每天全量采 ⇒ **sitemap 事件早已在 `ai_news_events` 里**。故开闸第一天，一篇当天发布的 Anthropic 官方新闻就能直接 P0 告警——**跟 sitemap 在不在实时子集里毫无关系**。把它纳入实时子集，收益是**压缩采集延迟**（≤24h → ≤20min），仅此而已。

## What Changes

- **告警闸一次建成终态**（`已评分 ∧ is_ai_related=true ∧ (支路 A OR 支路 B)`）：

  ```sql
  importance_score IS NOT NULL                              -- ① 已评分：两支路共用前提，在 OR 之外
  AND is_ai_related = true                                  -- ② AI 闸：两支路共用，fail-closed（= true，NOT `IS NOT FALSE`）
  AND ( importance_score >= ALERT_IMPORTANCE_THRESHOLD      -- ③ 支路 A：重要性
     OR representative_title 命中「精确事实变更词表」        -- ④ 支路 B：纯标题谓词，SQL 侧判定
  )
  ```

  **闸里没有 `should_push`**——它正是支路 B 要推翻的那个 LLM 否决（唯一生产命中样本 `importance=30` / `should_push=false`，加上它支路 B 恒为空）。支路 B 是本系统**唯一**一处「确定性规则覆盖 LLM 否决」的通道，规范为它立边界条款。

- **闸与回填域由同一个 `alertGatePredicate()` 共享构造器生成（阶段 A 即抽出，5 行）**：`src/pipeline/alert-scan.ts` 与 `src/agents/published-at-inference/backfill.ts` **同调**。⇒ AI 闸**一次写对两处**、回填域 **== 告警闸**，结构上不可能漂移。（回填有固定 `LIMIT PUBLISHED_AT_INFERENCE_MAX_PER_RUN`，默认 20 ⇒ **回填域比闸宽会饿死近期 NULL 事件**——那正是 `published-at-inference` 主规范自己列为要防的危害。「宽出去只浪费配额」不成立。）

- **cron 避整点判据修根因**：判据从「分钟字段**字符串** ∉ {'0','30'}」改为「分钟字段**展开后的分钟集合** ∩ {0,30} = ∅」。展开文法 MUST 覆盖 `*` / `*/n` / `a-b` / `a-b/n` / **`a/n`** / `a,b,c` / 纯数字，且**无法展开的分钟字段即判违反（fail-closed）**。覆盖面 MUST 为**全部 4 条走飞书发送的定时 cron**（含**非 env** 的模块常量 `DEFAULT_WEEKLY_CRON`）。

- **cron 值（默认 **和** 生产）**：`ALERT_SCAN_CRON` 默认 `*/15` → **`4-59/15`**（`{4,19,34,49}`）；生产覆盖值 `*/20` → **`9-59/20`**（`{9,29,49}`）。**改生产覆盖值是部署步骤的强制项**——机械断言只读得到代码里的默认值。

- **`sitemap` 进 `REALTIME_NEWS_SOURCES`**（一行常量 + 翻护栏测试 + 补 `collectorsReturning()` 桩）。收益 = **采集延迟 ≤24h → ≤20min**，**不是**「让 sitemap 具备告警资格」（它今天就有）。

- **精确事实域词表提为共享常量**（`src/keywords/precise-fact.ts`，零依赖叶子模块）：`/advisor` 前置闸与 P0 支路 B 共享核心 `PRECISE_FACT_CORE` + 各带一组扩展。SOT = `specs/conversational-rag/spec.md` 的穷举表。

- **加两条 superRefine**（不新增 env）：① `ALERT_FIRST_SEEN_WINDOW_DAYS=0 ∧ ALERT_MIN_PUBLISHED_AT=''` 的组合使支路 B 作用域扩成**全表历史**（直撞 `policy-push-timeliness`）⇒ 启动即 fail-fast；② cron 值的展开集约束由测试断言承载（不入运行时）。

- **P0 车道必须有界（基本属性，非可登记风险）**：`scoreUnscoredEvents` 的候选 SELECT **既无 `ORDER BY` 也无 `LIMIT`**（`score-events.ts:179-196`），告警链每轮全量送判 ⇒ 单轮最坏 `213 × (3×60s + 15s) = 41,535s` ≈ **11.5 小时** = **P0 车道死大半天**，而唯一止血是**人翻 `ALERT_SCAN_ENABLED=false`**（事后止血，不是保护）。⇒ 告警侧判分加**每轮工作预算**：候选 SELECT 加 **`ORDER BY first_seen_at DESC, event_id DESC LIMIT N`**（`event_id` 是必需的确定性 tie-breaker；**只加 `LIMIT` 不加 `ORDER BY` 会让 PG 返回任意 N 行**）。**N MUST 满足 `N × (F + A×L) < cron 周期`**（`F=15s` / `A=3` / `L=60s` ⇒ 每条最坏 195s ⇒ 15 分钟 cron ⇒ **N ≤ 4**）——取 N=20 则单轮 65 分钟 = 周期的 4 倍，队列只会越积越长，**车道仍不可用**。触顶发结构化事件（**由 `alert-scan.ts` emit，`ScoreEventsResult` 加 `budgetExhausted`；MUST NOT 给 `ScoreEventsOptions` 加 `emit`**）、余量下轮续判（claim / 写 CAS 不变量不变）；**日报链保持全量**（它现在承载**两个**理由：一天一次无界是对的 **＋** 它是告警链 `DESC` 取序不饿死老事件的唯一依据）。**并发堆积不成立**——`alert-queue.ts:116` 是 `concurrency: 1`，后续 cron 只排队。

- **两条链都消费 `perSource` 做源级健康告警**：sitemap 的「2xx 但 `loc_count=0` → throw → `perSource.ok=false` → 计入告警」契约**目前无任何告警消费者**——**没有一条链读 `perSource`**（高频链 `alert-scan.ts:334-341` 不读；**日报链也不读**：`run-daily-workflow.ts` 全文零命中，`classifySystemFailure` 的入参只有 `collectedCount` / `newsProcessableCount` 两个字段，`circuit-breaker.ts:92`）⇒ 该承诺在两条链上一直是空头支票，**不存在「日报链 24h 后兜底」这回事**。⇒ **两条链 MUST 都读 `perSource`**，经 `fix-sitemap-published-at` 新建的 `createOpsAlertSink` 落真实通道，`dedupKey='source-health:<source>'`，**限频由推送幂等唯一约束 `UNIQUE(target_type,target_id,channel,push_date)` 承载**（零新状态、跨进程/跨重启/跨链自动去重；**MUST NOT 用 Redis 键或进程内 Map**——后者 redeploy 即复位，「连续 N 轮」永不达标 = 静默不告警）。**日报链那一份绝不可省**：整条车道的回滚路径是 `ALERT_SCAN_ENABLED=false`，只放高频链则一回滚出口即消失。**不套用日报的「全源 0」系统告警**（高频空轮是常态）——两条判据不同。

- **`/advisor` 前置闸加确定性共现规则**（取值意图词 ∧ 事实名词，如 `(what is|max|…) ∧ (rate limit|usage limit)`）：英文取值型提问「what is Claude's rate limit」此前绕过确定性价格闸、落进 KB + LLM 的**非确定性**路径（红线③无确定性保证）。**共现比裸词窄**——拦取值型、放过运维型（「how to handle rate limit errors」），故「不能加裸词」**不蕴含**「这个洞必须留着」。**MUST NOT 用 LLM 复核决定是否拦截**；共现规则**只进 advisor**，不进 P0（P0 的 SQL `LIKE ANY` 形态不变）。

- **回滚 / 观察判据全部落到 DB 复算**：`push_records ⋈ ai_news_events`，SQL **MUST** 带 `p.status='success'`、**MUST** 用 `<threshold>` 参数化（不硬编码 85）、**支路 B 的低分命中 MUST NOT 计入噪音**。

## Capabilities

### 新增能力(New)

（无。）

### 修改能力(Modified)

- `realtime-alerts`：①「重大发布事件级实时告警」——告警闸改为「已评分 ∧ `is_ai_related = true` ∧（importance 阈值 **OR** 精确事实变更词表）」；闸与回填域由**同一构造器**生成；支路 B 的「LLM 否决覆盖」边界条款；采集源子集由三源扩为四源（含 `sitemap`，收益是**采集延迟**而非告警资格）；**告警侧判分 MUST 有界**（每轮工作预算，触顶发结构化事件、下轮续判；`concurrency:1` 已排除并发堆积，真实风险是单轮阻塞 = 车道整段不可用）；**高频链 MUST 消费 `perSource` 做源级健康告警**（按源去重/限频；「不做全源 0 告警」不蕴含「不做源级健康告警」）；`ALERT_SCAN_CRON` 的分钟展开集避整点（默认值与生产覆盖值同受约束）；不支持的配置组合启动 fail-fast。②「P0 实时告警质量可观测」——上线/回滚判据 MUST 可由 DB 复算（不以 stdout 日志为唯一载体）；触发支路可归因（`{'importance','fact-change','unknown'}`，支路 A 优先）；登记「可观测区分不了『在工作』与『已损坏』」这条诚实边界。
- `feishu-push`：「飞书自定义机器人通道推送」——避整点判据的**主语从字段字符串改为展开后的分钟集合**（字面量判据对 `*/n` / `*` 恒绿，是空守卫）；展开文法补 `a/n`；**无法展开即判违反（fail-closed）**；覆盖面从单条 `DAILY_DIGEST_CRON` 扩到**全部 4 条走飞书发送的定时 cron**（含非 env 的模块常量 `DEFAULT_WEEKLY_CRON`）。
- `source-collectors`：①「sitemap 增量采集」——`sitemap` **MUST 纳入 `REALTIME_NEWS_SOURCES`**（原为 MUST NOT），登记稳态成本与重渲染风暴落点；**「静默归零」护栏【两条链都无告警消费者】⇒ 两条链 MUST 都消费 `perSource` 兑现它**（经 `createOpsAlertSink`、`dedupKey='source-health:<source>'`、DB 唯一约束限频；缺的是**出口**——`runRegistry` 已 `logError`）。②「次级源经实时告警链由阈值过滤」——其「达阈值是**必要**条件」被支路 B 证伪；**前向守卫的触发谓词按事件塌缩的实际【黑名单】写**（`raw_type ∉ {product, paper, experience}`，含 NULL），**不是**「产出 `raw_type='news'`」（那会对今天就在子集里的 `hacker_news`(`post`) / `github`(`repo`) 判「不适用」）。③「RSS 源分层与次级源噪音治理」——其确定性闸**穷举**被支路 B 证伪，且「系统当前无 AI 相关性硬闸」的陈述今天已是假的。
- `model-radar-ingestion`：「ai-radar 事件流触发复核」——**只登记候选域宽度与开门前义务，不改任何事实判定**（其候选闸是裸 `published_at` 闭区间，无 source / importance / `is_ai_related` 闸）。
- `conversational-rag`：「价格/选型确定性前置闸」——前置闸关键词域补齐**取值型**短语；核心只收取值型（假阳无兜底），运维泛词与提问词分归两侧扩展；**新增确定性共现规则 `PRECISE_FACT_COOCCUR`**（取值意图词 ∧ 事实名词，仅 advisor 消费）关掉英文取值型提问的存量洞，**MUST NOT 用 LLM 复核**；三组常量逐词穷举（本能力是唯一 SOT）；LIKE 元字符禁令 + 死词自检 + CJK 子串禁令；**已知过宽词登记补齐 advisor 侧**。
- `published-at-inference`：「缺失发布时间的 AI 语义推断」——告警链回填作用域由「达阈值」扩为**与告警闸同构**的谓词（含共用 AI 闸），且**与告警闸由同一个构造器生成**；登记「固定 LIMIT ⇒ 回填域比闸宽会饿死近期 NULL 事件」；**登记「判不出无负缓存 ⇒ 每 tick 重推断，72–96×/天 的 LLM 放大」**（域小、本期不修，给出 `infer_attempted_at` / 负缓存作为可选补救）。

## 非目标(Non-Goals)

- **不新增任何 env 配置项**——告警链已有 9 个旋钮。回滚靠**阶段化 commit 的 revert** + `ALERT_SCAN_ENABLED=false`（整条车道）。
- **不降任何分数线**、**不给 Value Judge 新增 LLM 轴**、**不把 `should_push` 纳入任一支路**。
- **不加源子集闸**、不加索引、**不做 schema 迁移**、不动推送幂等四元组 / 双锁 / 原子 claim / `ALERT_MAX_PER_SCAN` / 时效窗口口径 / 时间源。
- **不碰正文补全的编排**（「补全先于判分」的结构化收口是前置变更 `unify-judge-stage` 的范围）。
- **不改 `MR_EVENT_REVIEW_ENABLED` 的默认值、不改 Model Radar 的任何事实判定**（价格 / 兼容 / 额度绝不交事件流或 LLM）。
- **不采集 X / Twitter**——一方厂商的产品变更公告（如「周用量上限提升 50%」）实际首发于官方 X 账号，**不在本变更涉及的任何源上**。这是一个**采集缺口**，须另起提案。**本变更 MUST NOT 声称能抓到该类公告。**
- **不声称词表是「全系统单一事实源」**——它覆盖的只有 `/advisor` 前置闸与 P0 告警闸两个出口；MCP 的 `search_kb` 出口**不过**此闸。
- **不建 run 事件落库或日志聚合基建**——判据改用 DB 复算，正是为了不引入新基建。
- **不给告警链加 `stageShouldAbort` 式熔断**（不做「阶段失败率超阈值即中止整轮」的那套）。**但判分 MUST 有界**——每轮工作预算是**基本属性**，不在本非目标内：无界 = 单轮 11.5 小时 = 车道死大半天，而「人翻开关」是事后止血、不是保护。

## Impact

- **代码**：新增 `src/keywords/precise-fact.ts`（零依赖词表叶子模块，含共现规则）、`src/keywords/fact-change-gate.ts`（Drizzle 谓词 + TS 纯函数双出口）、`alertGatePredicate()` 共享构造器；改 `src/pipeline/alert-scan.ts`（闸谓词 + 归因字段 + **判分工作预算** + **`perSource` 源级健康告警** + 注释）、`src/agents/value-judge/score-events.ts`（候选 SELECT 加**可选 `LIMIT`**——告警链传预算、日报链不传保持全量）、`src/agents/published-at-inference/backfill.ts`（回填域同调构造器）、`src/rag/price-gate.ts`（引用共享词表 + **共现匹配**）、`src/collectors/index.ts`（`REALTIME_NEWS_SOURCES` + 注释）、`src/config/env.ts`（`ALERT_SCAN_CRON` 默认值 + 1 条 superRefine）、`src/config/__tests__/env.test.ts:221-225`（判据重写 + 覆盖面扩到 4 条）、`.env.example`、`src/pipeline/worker-main.ts:12` 与 `src/pipeline/alert-queue.ts:6,66` 的注释。**无新增 env、无迁移、无新表**（判分预算为模块常量）。
- **配置（生产，分阶段）**：阶段 B 设 `ALERT_MIN_PUBLISHED_AT`（启用时刻 ISO）→ 改 `ALERT_SCAN_CRON=9-59/20 * * * *` → 置 `ALERT_SCAN_ENABLED=true`。**三项缺一不可，次序不可倒**（倒了 `src/config/env.ts:606` 的 superRefine 会 fail-fast 拒启动——那是**预期保护**）。
- **行为变化（用户可见）**：
  - 达阈值（≥85）、`is_ai_related = true` 且 `published_at >= 基线` 的新事件从「次日 08:03 日报」提前到「~20 分钟内实时告警」。**实测稳态量级 ≈ 3.67 条/天**（干净日 07-11 = 4 / 07-12 = 4 / 07-13 = 3，**n=3**）；不带 AI 闸的 30 天窗为 3.83 条/天。**日间波动窄**：极差 **[3, 4]**，约 **1.3×**。
  - 高 importance 的**非 AI** 新闻（KVM CVE / 癌症研究 / 探测器一类）**不再进入**告警。
  - 低 importance 但命中精确事实变更词表且 `is_ai_related=true` 的事件取得 P0 资格。预期 **≤ 1 条 / 30 天**（离线回放实测上界）。
  - `/advisor` 对**取值型**限额提问（「周用量上限多少」）从「可能作答」变为拒答；运维类提问（「API 限流了怎么办」）**不受影响**。
  - sitemap 一方厂商官方公告的采集延迟由 **≤24h → ≤20min**（其**告警资格今天就有**，不变）。
  - 基线之前发布的存量一律不追推（守 `policy-push-timeliness`）。
- **风险敞口（登记）**：阶段 B 开闸时，告警候选域**已经是四个源的事件**（含 sitemap）——`selectAlertCandidates` 无 source 谓词。首跑核验的对象是**候选的 `event.source` 分布**，不是「采集子集是 3 源」。
- **重渲染风暴（更正数量级 + 有界化）**：站点批量重渲染把 213 篇老文推回窗口时，告警链**无 `stageShouldAbort` 熔断**——LLM 全挂时**单轮**最坏 `213 × (3×60s + 15s) = 41,535s` ≈ **11.5 小时**，不是「30–60 分钟」。**并发堆积不成立**（`alert-queue.ts:116` 是 `concurrency: 1`）；真实风险是**单轮阻塞 = P0 车道死大半天**，故**判分加每轮工作预算**封顶（**N ≤ 4**，见上）。已见集在 fetch 之前过滤 ⇒ 风暴只发生**一轮**；`ALERT_SCAN_ENABLED=false` 是事后止血、**不是唯一保护**。
- **「判不出」的 LLM 重试放大（登记，本期不修）**：`backfill.ts:230-238` 对判不出**不写任何标记**（无 attempt 计数、无负缓存）⇒ 同一条事件每 15–20 分钟被重推断一次，直到 `first_seen_at` 滑出 3 天窗——**与「每天 72–96 次 `sitemap.xml` GET」是同一个放大系数**，只是落在 LLM 上。实际域很小（rss/hn/github 实测 0 条 NULL；`sitemap` 已整源豁免出回填域）⇒ 钱不多、本期不强制修；可选补救为 `infer_attempted_at` 列或带 TTL 的负缓存。**MUST 显式登记，不得沉默。**
- **飞书限流**：4 条走飞书的定时 cron 的分钟展开集全部脱离 {0, 30}，降低 11232 概率。
- **前置依赖（硬门，见 tasks 0）**：`fix-sitemap-published-at` 已归档**且其样板修复落地后重新计时的 7 天生产观察已满**；`unify-judge-stage` 已归档（否则开闸会让日报的正文补全阶段永久空转）。
- **不受影响**：日报链候选与推送、KB 入库、周报、产品/经验车道、MCP `search_kb`、Model Radar 的任何事实判定。
