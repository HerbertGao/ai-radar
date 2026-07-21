> **四个阶段 = 四个独立 commit = 四个独立 revert 点。** 这是一条**部署序列**（观察窗与 revert 点一个不少），**不是**规范变更序列——规范一次写成终态（见 design D0）。
>
> ```
> 阶段 A（commit 1）：cron 判据 + cron 值 + AI 闸 + alertGatePredicate() 共享构造器 + 判分预算（A5）+ superRefine
>                     → 车道仍关，AI 闸是 no-op。可先合并。
> 阶段 B（commit 2）：ALERT_MIN_PUBLISHED_AT → ALERT_SCAN_CRON（生产）→ ALERT_SCAN_ENABLED=true。观察 7 天。
> 阶段 C（commit 3）：REALTIME_NEWS_SOURCES 加 sitemap（一行 + 翻护栏测试 + 补桩）。观察。
> 阶段 D（commit 4）：支路 B（词表 + OR 支路 + advisor 前置闸 + trigger 归因）。观察 7 天。
> ```
>
> **所有可复算 SQL 的 `<threshold>` 一律读生产 `ALERT_IMPORTANCE_THRESHOLD`（`src/config/env.ts:385` 可配），MUST NOT 硬编码 `85`**——生产改阈值 → 判据静默失灵。`<patterns>` = 最终词表逐词包 `%`；**`<negPatterns>` = `NEGATIVE_PATTERNS` 逐词包 `%`（D1.10）——每一条复算 SQL 都 MUST 带那个否定合取项，否则复算的不是真实闸、会把被否定项挡掉的工具帖算进支路 B 的量级**。**success 窗口一律按 `p.pushed_at` 取**（`created_at` 是 pending 行创建时刻，跨界重试会错窗）。

## 0. 硬前置门（未全绿 MUST NOT 进入阶段 B「开闸」）

> 阶段 A **不依赖本门**，可先行合并——它独立正确、且与开关无关（车道关着时 AI 闸与共享构造器都是 no-op；车道一开它们是强制项）。

- [ ] 0.1 **`fix-sitemap-published-at` 已归档，且其样板修复落地后重新计时的 7 天生产观察已满。**（两腿：归档**已成**——git `5c42f19`；7 天观察**未满**——起点 = 该变更样板修复的生产部署日，以其部署记录为准，本文档不复制日期防漂移。全绿指两腿皆满。）在坏基线上观察 7 天 = 假绿信号。
- [x] 0.2 **`unify-judge-stage` 已归档**（git `5c42f19`；补全已折进判分入口 `src/agents/value-judge/score-events.ts:294`）——**该前置已满足**。其防的失效：unify 前，补全工作集是判分工作集（`score-events.ts:266` 的 `importance_score IS NULL` 谓词）的**真子集**、两者同键，告警链每 15–20 分钟判一次分而**不跑补全**，等 08:0x 日报链跑到补全时工作集已空 → `source-content-enrichment` 变死代码（招牌用例 `hacker_news` 直链帖 `content` 恒 NULL，≈28 事件/天）。unify 把补全折进判分入口后，该空转不再可能。
- [x] 0.3 **【已跑，2026-07-14 生产只读实测】支路 A 的稳态量级 = 3.67 条/天。**
      **干净日**（`is_ai_related` 列全天生效之后）：07-11 = **4** 条 · 07-12 = **4** 条 · 07-13 = **3** 条 ⇒ **3.67 条/天，n=3**。
      **日间波动窄**：极差 **[3, 4]**，约 **1.3×**。
      07-10 是**回填日**（14 条，混合了列上线前后两批评分）——**排除出稳态估计**。
      > **此前登记的「日方差 3.5 倍」是错的，已删**：它来自 07-10 的 14 条，而 07-10 **已被排除出均值**。**一天不能既被剔出均值、又用来算方差**——那是拿一个被判定为「不属于该分布」的点去度量该分布的离散度。真实日间波动是 [3, 4]。
      不带 AI 闸的 30 天窗（`2026-06-13 → 07-12`）= **115 条 / 30 天 = 3.83 条/天**（这条 SQL 自洽、无删失）。
      > **为什么不能用旧的「3.6 条/天」**：`is_ai_related IS TRUE` 是一个**对时间变化的列做的删失过滤**（该列 2026-07-10 才上线）⇒ **分子按【评分时钟】删失、分母按【采集时钟】测量**，同一条 SQL 实跑得 0.70，与「3.83 × 95% = 3.64」不可能同时为真。
      **可复算 SQL（分子分母钉在同一个删失窗口上；`<threshold>` 读生产 env）**：
      ```sql
      -- 只统计 is_ai_related 已全天生效的日子（首个干净日 = 2026-07-11）。
      SELECT count(*) AS total,
             round(count(*)::numeric / (max(first_seen_at)::date - min(first_seen_at)::date + 1), 2) AS per_day
      FROM ai_news_events e
      WHERE e.merged_into IS NULL
        AND e.importance_score >= <threshold>
        AND e.is_ai_related IS TRUE
        AND e.first_seen_at >= date '2026-07-11'          -- ← 分子分母同域，删失窗口对齐
        AND e.published_at IS NOT NULL AND e.published_at <= now()
        AND e.published_at >= e.first_seen_at - interval '3 days';
      ```
      > **这条 SQL 是「会告警」的【上界】，不是闸的逐字复刻**：它的时效闸是**逐行相对**窗口（`published_at >= first_seen_at - 3 days`），而代码里的真闸是**墙钟**窗口（`startOfDayInTimeZone`，Asia/Shanghai）；它还省略了 Model B 的「未 alert-success 投递」反连接与 `ALERT_MIN_PUBLISHED_AT` 基线水位。**MUST NOT 当成精确预测。**
- [x] 0.4 **【已跑，2026-07-14 生产只读实测】AI 闸的实测拦截率极低——它是尾部保险，不是高频过滤器。**
      三个干净日（列全天生效后：07-11 / 07-12 / 07-13）累计实测 **0 拦 / 11 过**（07-10 回填日挡掉 1/14）。
      **闸仍然要加**：fail-closed、与日报要闻闸 `eq(is_ai_related, true)`（`src/selection/top-n.ts:269`）同极性；且生产语料里那条 `should_push=true ∧ is_ai_related=false` 的「GhostLock」样本（标题含该词）正说明 Judge 的分类是对的。
      **但 MUST NOT 用「24.3%」给它背书**——那个数测的是 **`should_push=false`**，不是 `is_ai_related`；那 6 条抽样里 5 条的 `is_ai_related` 是 **NULL**（07-10 前评分的历史产物，**不会重演**），它们被挡住靠的是 fail-closed 对 NULL 的排除。
      **可复算 SQL（上线前该跑却没人跑的那条）**：
      ```sql
      SELECT count(*) FILTER (WHERE is_ai_related IS FALSE) AS blocked,
             count(*)                                       AS total
      FROM ai_news_events
      WHERE merged_into IS NULL
        AND importance_score >= <threshold>
        AND first_seen_at >= date '2026-07-11';   -- 列全天生效之后
      ```

---

# 阶段 A（commit 1）：判据 + cron 值 + AI 闸 + 共享构造器（车道仍关）

## A1. cron 避整点判据修根因（feishu-push）

> 现判据（`src/config/__tests__/env.test.ts:221-225`）比较的是**字段字符串**：`expect(['0','30']).not.toContain(minuteField)`。
> 它对 `*/15`（展开含 0 **和** 30）、`*/20`（含 0）、`*`（全集）**恒绿**，且只查 1 条 cron。**空守卫——它当初就没抓到 `ALERT_SCAN_CRON` 的违反。**

- [x] A1.1 写 `expandCronMinutes(pattern: string): Set<number>`：取 cron 第 1 段（分钟字段），按 `,` 切项，每项展开——
      - `*` → `0..59`
      - `*/n` → `{m ∈ [0,59] | m % n === 0}`
      - `a-b` → `a..b`
      - `a-b/n` → 自 `a` 起步进 `n` 且 `<= b`
      - **`a/n` → 隐式 `a-59/n`**（`cron-parser` 支持；`0/15` → `{0,15,30,45}`）
      - 纯数字 → `{n}`
      返回各项的并集。**任一项无法按上述文法展开 MUST 抛错（fail-closed）**，判据侧把「抛错」计为**违反**。
      **数值有效性同为文法的一部分（fail-closed）**：各项 MUST 满足 `0 ≤ a ≤ b ≤ 59`、步进 `n` 为正整数（`*/0` / `0/0` 抛错）、纯数字 ∈ [0,59]（`60` 抛错）、倒置区间（`b < a`）抛错——**任何违反 MUST 抛错并计为违反**，绝不静默产出空集（空集 ∩ {0,30} = ∅ 恒判过）。
      > **漏 `a/n` 的后果是恒绿**：喂 `0/15` → 各项都不匹配 → 返回**空集** → `∅ ∩ {0,30} = ∅` → **判过**，而它实际撞整点半点。**「一个解析不出就当合规」的守卫，正是本节要杀死的东西。**
      **落点 = 零依赖叶子模块**（如 `src/config/cron-minutes.ts`），由 `env.test.ts` 的避整点断言与 `env.ts` 的 A5.1c superRefine **共同 import**（同一份文法，MUST NOT 抄第二份）。**避整点【判据】仍只在测试侧断言、不进运行时**；进生产路径的只有「cron 周期计算」这一个消费点。
- [x] A1.2 **替换** `env.test.ts:221-225` 的字面量断言：判据改为 `expandCronMinutes(cron) ∩ {0, 30} === ∅`，且**展开抛错即判失败**。
- [x] A1.3 **覆盖面扩到全部 4 条走飞书发送的定时 cron**（任一违反即失败）：
      | cron | 位置 | 值 | 分钟展开集 |
      |---|---|---|---|
      | `DAILY_DIGEST_CRON` | `src/config/env.ts:331` | `3 8 * * *` | `{3}` ✅ |
      | `ALERT_SCAN_CRON` | `src/config/env.ts:389` | A2 改为 `4-59/15 * * * *` | `{4,19,34,49}` ✅ |
      | **`DEFAULT_WEEKLY_CRON`** | **`src/pipeline/weekly-queue.ts:29`（模块常量，不在 env.ts）** | `7 9 * * 1` | `{7}` ✅ |
      | `MR_PRICE_CURATION_CRON` | `src/config/env.ts:555` | `53 9 * * *` | `{53}` ✅ |
      **`DEFAULT_WEEKLY_CRON` 不是 env 变量**——断言 MUST 直接 import 该常量，**MUST NOT** 因「它不在 env 里」而漏掉它，**MUST NOT** 在测试里抄一份字面量副本（该模块 top-level import `bullmq`；若测试环境不宜引入，把常量提到零依赖叶子模块再由两侧 import）。
      > **不在覆盖面内的 4 条 cron（不发飞书）**：`MR_EVENT_REVIEW_CRON`（`:510`）、**`MR_SCRAPE_HTTP_CRON`（`:516`）与 `MR_SCRAPE_BROWSER_CRON`（`:517`）——`MR_SCRAPE` 是【两条】cron**、`MR_STALENESS_CRON`（`:536`）。
- [x] A1.4 **展开器单元用例**：`*` / `*/15` / `*/20` / `4-59/15` / `9-59/20` / **`0/15`** / `3` / `a,b,c` 各自的展开集；**非法输入（如 `x` / 空串）MUST 抛错**；数值非法输入 MUST 抛错：`60` / `*/0` / `30-10`（倒置区间）。
- [x] A1.5 **负例断言（防判据退回字面量后无人察觉）**：喂 `*/15 * * * *` / `*/20 * * * *` / `* * * * *` / **`0/15 * * * *`** 给判据函数 → MUST 判**违反**。这是本节唯一能证伪「守卫又变回恒绿」的用例。

## A2. cron 值（默认值；生产覆盖值在阶段 B）

- [x] A2.1 `src/config/env.ts:389`：`ALERT_SCAN_CRON` 的 `.default('*/15 * * * *')` → **`.default('4-59/15 * * * *')`**（展开 `{4,19,34,49}`，仍在规范的「15–30 分钟」保守窗内）。同步更新其上方注释（补一句为何是 `4-59/15` 而非 `*/15`）。
- [x] A2.2 `.env.example:145-149`：`ALERT_SCAN_CRON=*/15 * * * *` → **`ALERT_SCAN_CRON=4-59/15 * * * *`**，并更新其上方注释块。
- [x] A2.3 **注释订正**（四处现写「默认 20min」，与 env 默认值 `*/15` 本就不符）：`src/pipeline/worker-main.ts:12`、`src/pipeline/alert-queue.ts:6`、`src/pipeline/alert-queue.ts:66`、`src/pipeline/alert-scan.ts:5`。

## A3. 告警闸的 AI 闸 + `alertGatePredicate()` 共享构造器

> **一次抽出、两处同调**——这是本变更最重要的结构改动。回填有**固定 LIMIT**（`PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 默认 **20**，`backfill.ts:191-192`）⇒ **回填域比闸宽 = 饥饿**（宽出去的高 importance 非 AI 新闻占掉 20 个名额，把真正在闸内、`published_at IS NULL` 的事件挤出本轮回填 → 永为 NULL → 被 NULL 排除挡住 → **永不告警、可观测无痕迹**）。**「回填域比闸宽只浪费配额」是错的。**

- [x] A3.1 新建 `src/pipeline/alert-gate.ts`，导出 `alertGatePredicate(threshold: number): SQL`：
      ```ts
      // drizzle 的 and / or 是【自由函数】——写成 isNotNull(...).and(...) 编译不过。
      export function alertGatePredicate(threshold: number): SQL {
        return and(
          isNotNull(aiNewsEvents.importanceScore),              // ① 已评分
          eq(aiNewsEvents.isAiRelated, true),                   // ② AI 闸：fail-closed
          gte(aiNewsEvents.importanceScore, String(threshold)), // ③ 支路 A（numeric → string）
        ) as SQL;
      }
      ```
      **MUST 写成 `= true`，MUST NOT 写成 `IS NOT FALSE`**——`false` 与 `NULL` 一律排除，与日报要闻闸 `eq(is_ai_related, true)`（`src/selection/top-n.ts:269`）同极性。
      **MUST NOT 顺手加 `should_push`**——那是 Judge 的「值不值得推」，P0 有意不受其约束。
- [x] A3.2 `src/pipeline/alert-scan.ts` 的 `selectAlertCandidates`（`:236-258`）：把「`isNotNull(importanceScore)` + `gte(importanceScore, threshold)`」两项**替换为** `alertGatePredicate(threshold)`。其余候选条件（时效窗口 / tombstone / 基线水位 / Model B 去重 / `ALERT_MAX_PER_SCAN`）**一条不减**。
- [x] A3.3 `src/agents/published-at-inference/backfill.ts` 的 `scopePredicate`（`:104-114`）alert 分支：把「`isNotNull(importanceScore)` + `gte(importanceScore, threshold)`」两项**替换为同一个 `alertGatePredicate(scope.threshold)`**。daily 分支（`eq(shouldPush, true)`）不变。
      ⇒ 回填域与告警闸的**共享谓词段恒等**（在**每个阶段**都成立；回填另有自己的 NULL/窗口/豁免/JOIN 合取项，见 design D3），AI 闸一次写对两处。
      **MUST NOT 顺手删掉豁免源谓词**（`fix-sitemap-published-at` 落在此查询上的 `ne(rawItems.source, 'sitemap')` 豁免合取项（MUST NOT 写成 `NOT IN`——`raw_items.source` 虽 NOT NULL + INNER JOIN 使两者今日等价，但本变更他处正是在纠 `NOT IN` 的三值逻辑，措辞与代码同型））：它是**共享谓词之外的独立合取项**，两条需求不冲突——删了就是把「sitemap 提取失败 → 交 LLM 猜发布日」整条静默改回来。
- [x] A3.4 **不构成「NULL 永不判分」死锁**（核验，不是改动）：Value Judge 的判分工作集（`src/agents/value-judge/score-events.ts:266`）按 `importance_score IS NULL` 选取、**不带** `is_ai_related` 闸 ⇒ 该列为 NULL 的新事件照常被判分并写入该列。本闸只作用于**判分之后**的候选谓词与回填域。
- [x] A3.5 **先扩 seed helper**（不扩则 A3.6 / A3.7 的新用例必红）：
      - `src/pipeline/__tests__/alert-scan.integration.test.ts` 的 `seedEventWithRawItem` / `seedScoredEvent`：INSERT 增 `is_ai_related` 与 `should_push` 两列，形参 `isAiRelated?: boolean | null`（**默认 `true`**）、`shouldPush?: boolean | null`
      - `src/agents/published-at-inference/__tests__/backfill.integration.test.ts` 的 `seedEvent`：同上增 `isAiRelated?`（默认 `true`）
      - 默认值取 `true` 与既有约定同源（`top-n.integration.test.ts` / `tombstone-visibility.integration.test.ts` 的 seed 即如此），使**既有用例行为不变**
- [x] A3.6 **告警闸单测**（`alert-scan.integration.test.ts`，**每条都须钉死 `is_ai_related` / `should_push` 的取值**）：
      - `importance=95` + `is_ai_related=true` → **告警**（基线不回归）
      - `importance=95` + **`is_ai_related=false`** → **不告警**（招牌用例：KVM 逃逸 CVE）
      - `importance=95` + **`is_ai_related=NULL`** → **不告警**（fail-closed；防有人改成 `IS NOT FALSE`）
      - `importance=95` + `is_ai_related=true` + **`should_push=false`** → **告警**（`should_push` 绝不入闸）
- [x] A3.7 **回填域测试**（`backfill.integration.test.ts`）：
      - **先核对既有 alert scope 用例**（4 处）——扩闸后应仍为绿；须**实际跑一遍确认**，不得假定
      - **另须核对未在提案中声明的消费者**：`src/dedup/__tests__/tombstone-visibility.integration.test.ts` 中直调 `selectAlertCandidates` 与 `backfillPublishedAt`（alert scope）的用例；须**实跑确认**
      - **新增**：`importance=95` + **`is_ai_related=false`** + `published_at IS NULL` → **不进回填域**（不为永不告警的事件耗配额、不挤占 LIMIT 20 的名额）

## A4. 不支持的配置组合 → 启动 fail-fast（superRefine，不新增 env）

- [x] A4.1 `src/config/env.ts` 加一条 superRefine（仓内已有先例：`:614` 的 `ALERT_SCAN_ENABLED × ALERT_MIN_PUBLISHED_AT`）：
      `ALERT_SCAN_ENABLED='true'` **且** `ALERT_FIRST_SEEN_WINDOW_DAYS === 0` **且** `ALERT_MIN_PUBLISHED_AT === ''`（显式 opt-out）⇒ **拒绝启动**。
      理由：该组合旁路了时效下界**且**旁路了基线水位 ⇒ 告警候选域扩成**全表历史**（阶段 D 后支路 B 尤甚：每条历史老公告都可能命中词表）——直撞用户的「推送时效性」红线（`policy-push-timeliness`）。规范只写了「MUST NOT 在生产使用」，`env.ts` **无对应守卫**。
      **这不是新 env 变量，不违反「不新增 env」。**
- [x] A4.2 单测：该组合 → `loadEnv()` 抛错；三者任一不满足 → 正常加载。

## A5. 告警侧判分有界（MUST——一条高频车道必须有界）

> `scoreUnscoredEvents` 的候选 SELECT（`src/agents/value-judge/score-events.ts:242-266`，工作集谓词在 `:266`）**既无 `ORDER BY` 也无 `.limit()`**；全文仅 `:363` 有一个与候选集无关的 0 行回读 `.limit(1)`——故「候选 SELECT 无界」成立，但**不是**「全文 grep `limit|budget|deadline` 零命中」。告警链每轮直接全量送判（`src/pipeline/alert-scan.ts:350`）。
> **并发堆积不成立**——`src/pipeline/alert-queue.ts:116` 是 `concurrency: 1`，后续 cron 只排队；**MUST NOT 把「数十轮并发跑」写成风险**。
> **真实风险**：单轮最坏 `213 × (3×60s + 15s) = 41,535s` ≈ **11.5 小时**（LLM 全挂 + 重渲染 213 篇）= **P0 车道死大半天**，而唯一止血是**人去翻 `ALERT_SCAN_ENABLED=false`**——那是事后止血，不是上线前的保护。

- [x] A5.1 `ScoreEventsOptions` 增 `maxPerRun?: number`（**不新增 env**——守「不新增 env 配置项」非目标）；候选 SELECT **仅在 `maxPerRun` 给出时**加**确定性取序 + `LIMIT`**，**形态唯一、照抄（`LIMIT` 取 `maxPerRun + 1` 行、只处理前 `maxPerRun` 条——+1 仅作触顶信号，见 A5.3）**：
      ```sql
      ORDER BY first_seen_at DESC NULLS LAST, event_id DESC   LIMIT maxPerRun + 1
      --                          ^^^^^^^^^^  ^^^^^^^^^^^^^ 二者【均必需】
      ```
      **🔴 `maxPerRun` 的默认值 MUST 为 `undefined`（＝无 `ORDER BY`、无 `LIMIT`、全量），MUST NOT 是模块常量 N。** 写成 `const limit = options.maxPerRun ?? JUDGE_MAX_PER_SCAN`（3）⇒ **日报链（`run-daily-workflow.ts` 不传该选项）每天只判 3 条** ⇒ ① 要闻段瞬间枯竭；② A5.2 的「不饥饿」论证（老事件由**无界的日报链**在 ≤24h 内排空）**当场坍塌** ⇒ 老事件永久积压。**且条数 ≤ N 的 fixture（现存用例大多如此）在两条链上行为逐字相同 ⇒ 恒绿、看不见。** 只有**告警链显式传**。
      **`ORDER BY` MUST NOT 省**（今天既无 ORDER BY 也无 LIMIT）：只加 `LIMIT` ⇒ PG 返回**任意** N 行。**`event_id` MUST NOT 省**：同秒入库的事件 `first_seen_at` 同值时单列排序仍是部分序。
      **🔴 `NULLS LAST` MUST NOT 省**：`aiNewsEvents.firstSeenAt`（`src/db/schema.ts:146`）**无 `.notNull()` ⇒ 可空**，而 PG `ORDER BY x DESC` 默认 **NULLS FIRST**（实测 `(1, NULL, 3)` 上 `DESC LIMIT 1` 返回 **NULL**）⇒ **一行 NULL 即恒排第一、每轮吃掉一个名额、永不老化**（判分工作集无时间剪枝）——与下面「毒事件」是同一个永久饥饿。仓内他处均已写 `DESC NULLS LAST`（`src/pipeline/experience-chain.ts:534`）。
      **登记：今天是【休眠地雷】**——生产实测 `first_seen_at IS NULL` = **0 / 3698**。修它是因为**失效是静默的**（第一行 NULL 出现时没有任何东西会变红），不是因为它正在爆。
      **「不加 LIMIT、循环内数到 N 就 break」MUST NOT 采用（它不等效）**：全量无序 SELECT + break 前 N 条 ⇒ 物理扫描序轮间稳定 ⇒ 排头的 N 条**毒事件**（判分恒失败 → `releaseJudgeClaim` → 仍 NULL → 留在工作集 → 下轮又排头）**每轮吃满预算**，其后健康事件**永久饿死**；而判分工作集**无任何时间剪枝**（谓词只有 `importance_score IS NULL AND merged_into IS NULL`），毒事件永不老化出局 ⇒ 契约声称「绝不丢事件」，该变体**能永久丢事件**。
      **落 `maxPerRun` 时 MUST 写成 `{ ...options.judge, maxPerRun: N }`——显式值放在 spread 之【后】，使预算恒胜注入体。**（注意：对象 spread 只复制**自有属性**，`options.judge` 不含 `maxPerRun` 键时反序写法**今天也不会**被覆盖成 `undefined`——本条是**前瞻性防御**：将来某个 judge 注入体若带上 `maxPerRun`，前置写法会被它静默覆盖、车道回到无界，而注入了 judge 桩的集成测恰是最可能踩中的那批。）
- [x] A5.1b **N 的取值 MUST 满足下式（只写「是模块常量」不构成约束）**：
      ```
      N × (F + A×L + W) < ALERT_SCAN_CRON 周期
      F = COLLECTOR_FETCH_TIMEOUT_MS = 15s（env.ts:357，【env】）
      A = JUDGE_MAX_ATTEMPTS = 3 —— 【不是 env】：它是 `unify-judge-stage` 的 tasks 5.1 把
          `value-judge/index.ts:66` 的 `DEFAULT_MAX_ATTEMPTS` 提为 `config/env.ts` 的【导出常量】后的那一个
      L = LLM_TIMEOUT_MS = 60s（env.ts:272，【env】）
      W = JUDGE_WRITE_BUDGET_MS = 60s（env.ts:434，【env】——与 T > F+A×L+W 的 claim 回收阈值同一口径）
      ⇒ 每条最坏 255s（末次尝试成功 + 写分）⇒ 15 分钟 cron ⇒ 【N ≤ 3】
      ```
      **反例（MUST 一并读到）**：取 `N=20`（与 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 同量级的「自然」选择）⇒ 单轮 `20×255s` ≈ **85 分钟** = cron 周期的**近 6 倍** ⇒ `concurrency:1` ⇒ **队列越积越长** ⇒ 车道仍不可用（只是从「死大半天」变成「每轮 1 小时余且持续落后」）。**目标没兑现。**
      **口径区分（MUST 一并读到）**：预算口径的每条最坏 = `F + A×L + W`（末次尝试成功仍要写分）；而「重渲染风暴 11.5h」的每条 = `F + A×L = 195s`（LLM 全挂 = 全部尝试失败 ⇒ **无写分**）——两个口径各自正确，MUST NOT 互相替换。
- [x] A5.1c **🔴 该不等式 MUST 落进 `env.ts` 的 `superRefine`，MUST NOT 只写在散文里**：五项里**四项是 env**（`COLLECTOR_FETCH_TIMEOUT_MS` / `LLM_TIMEOUT_MS` / `JUDGE_WRITE_BUDGET_MS` / `ALERT_SCAN_CRON` 周期）⇒ 硬编码一个 `3` + 一段散文 ⇒ **生产上调 `LLM_TIMEOUT_MS`（或把 cron 调密）时约束静默失效** ⇒ 单轮又超周期 ⇒ 积压 ⇒ **P0 车道回到不可用**，无一处变红。
      **同一份提案对 `T > F + A×L + W` 已要求 superRefine 启动期强制**（`unify-judge-stage` 的 spec：「**禁止**只写在文档里」）——**对 N 不能是另一套标准**。
      实现形态择一并显式落地：① N 由 env 派生 `N = floor((cronPeriodMs − 1) / (F + A×L + W))`（减一防**整除边界**：`floor(x/y)` 在整除时只给 `≤`、不满足严格 `<`）；② N 为模块常量（本期取 **3**，**落在 `env.ts` 自身**——与该 superRefine 同文件 ⇒ 无 import 环；`expandCronMinutes` 则落零依赖叶子 `src/config/cron-minutes.ts`、由 `env.ts` import）。**两种形态都 MUST 过同一条 superRefine**：`N ≥ 1 且 N × (F + A×L + W) < cron 周期`——`N = 0`（周期短于单条最坏时长，如 `*/3`）意味着告警链每轮判 0 条、车道静默退化为「等日报链判分」，MUST 启动 fail-fast 而非静默接受。
      **错误消息 MUST 报出五项的当前值**（`N` / `F` / `A×L` / `W` / cron 周期），否则运维拿到一条不可行动的报错。
      单测：调高 `LLM_TIMEOUT_MS` 使不等式不成立 → `loadEnv()` **抛错**；默认值组合 → 正常加载。
      展开 cron 周期用 A1.1 的 `expandCronMinutes`（同一份文法，MUST NOT 抄第二份）；**周期 = 分钟集在 mod-60 环上的最小相邻间隔**（`{4,19,34,49}` ⇒ 15min；单元素如 `{9}` 环绕到下一小时 ⇒ 60min）。**该环间隔是任意 cron 真实最小触发间隔的【下界】**（小时字段收窄只会拉大真实间隔）⇒ 以它作周期做 `<` 校验对任何 cron 形态都**只会偏严、绝不偏松**（fail-closed 方向正确）——小时字段非 `*` 时判据仍安全，无需另设守卫。
      **该 superRefine MUST 以 `ALERT_SCAN_ENABLED === 'true'` 为合取门**（同 A4.1 先例）：N 约束只对告警链有意义，纯日报部署（车道关）不得因 alert cron × LLM 超时组合被拒启动。（既有 `T > F+A×L+W` superRefine 不门控，因 claim 不变量对两条链都成立——本条不是。）展开器对生产 `ALERT_SCAN_CRON` 值**抛错**（文法/数值非法）时，该 superRefine MUST 同样 `addIssue` 启动 fail-fast（fail-closed，与 A1 同向）——绝不静默跳过校验。
- [x] A5.2 `src/pipeline/alert-scan.ts:350` 的调用传该预算（`{ ...options.judge, maxPerRun: N }`，见 A5.1）；**日报链（`run-daily-workflow.ts`）不传 ⇒ 保持全量**。
      **⚠️「日报链无界」现在承载【两个】理由，MUST 在代码注释里写清**：① 一天一次，无界是它的正确形态；② **它是告警链 `first_seen_at DESC` 取序不饿死老事件的唯一依据**（老的未评分事件过不了告警闸的时效地板 `alert-scan.ts:249`/`:258` ⇒ 判了也不告警 ⇒ 告警链花预算在它们身上是纯浪费；它们由无界的日报链在 ≤24h 内排空）。**将来谁给日报链也加个界，积压就永久饿死了。**
- [x] A5.2b **🔴 回归钉：日报链判 > N 条事件（不截断）。** fixture 造 **6** 条未评分事件（> N，默认 3）→ 跑日报链的判分阶段（**不传** `maxPerRun`）→ 断言 **6 条全被判**。
      **这是唯一能证伪「有人把 N 写成缺省值」的用例**——条数 ≤ N 的 fixture 在两条链上行为逐字相同、**恒绿**（现存用例大多如此）。
- [x] A5.3 触顶 MUST 发**结构化可观测事件**（复用既有 run-event 通道，**MUST NOT 新建通道**），**MUST NOT 静默截断**。
      **落点 MUST 定死**：`emit` 挂在 `RunAlertScanOptions`（`alert-scan.ts:126`）、**不在** `ScoreEventsOptions`，而截断发生在 `scoreUnscoredEvents` **内部** ⇒ 唯一不新建通道的落法是 **`ScoreEventsResult` 增 `budgetExhausted: boolean` / `candidateCount: number`，由 `alert-scan.ts` 读取后 emit**。
      **MUST NOT 给 `ScoreEventsOptions` 加 `emit`**——那就是新建一条通道，与本条自己的 MUST 相悖。
      **观测落法 MUST 定死**：候选 SELECT 取 **`LIMIT N+1`**、只处理前 N 条——`budgetExhausted = (取回行数 > N)`，`candidateCount = 本轮实际处理条数（≤ N）`。**单靠 `LIMIT N` 无法区分「恰好 N 条」与「超过 N 条」**，触顶信号会失真。第 N+1 条只作信号、不 claim 不判分。**事件名与载荷 MUST 定死**：经既有 `RunAlertScanOptions.emit` 通道发射 **`p0.judge_budget`**、载荷 `{ budgetExhausted: boolean, candidateCount: number }`——不新建通道、不改 `p0.observed` 的既有 schema（本句只限预算信号不搭 `p0.observed` 便车；阶段 D 给 `hits[]` 加归因字段是另行 spec 的纯附加，见 D2.3——非 schema 冻结不变量）。
- [x] A5.4 **claim / 写 CAS 不变量不变**：被预算挡在本轮外的事件 `importance_score` 仍为 NULL ⇒ **留在工作集里、下一轮继续**（预算只裁单轮工作量，不丢事件、不改「一事件只评一次分」）。`LIMIT N+1` 天然落在 claim **之前**（第 N+1 行只作信号、不 claim）⇒ 超预算事件**从未被 claim**、下一轮即刻可取（若落在 claim 之后，它们要等满 `JUDGE_CLAIM_RECLAIM_MS` 才被回收）。
      **不做墙钟 deadline 变体** ⇒ 「MUST 释放飞行中 claim」那条子条款不适用（无飞行中止、无需释放）。
- [x] A5.5 单测：候选 > 预算时 → 本轮只判 N 条 + 发触顶事件（`budgetExhausted=true`）；**余下的事件下一轮被判**（不丢）；日报链调用不受限（不传预算时行为与今天逐字一致，回归钉见 A5.2b）；**取序确定性**——`first_seen_at` 同值的两条事件按 `event_id DESC` 稳定取；**`first_seen_at IS NULL` 的事件 MUST 排在最后**（`NULLS LAST`）——seed 一条 NULL + N 条非 NULL，断言本轮判的是那 N 条非 NULL 的、NULL 那条**不占名额**（防 PG 的 `NULLS FIRST` 默认让它恒排第一、每轮吃一个名额且永不老化）。

## A6. 阶段 A 验收

- [x] A6.1 `npm run typecheck` / `lint` / `test` 全绿。
- [x] A6.2 告警链既有集成测试不因 cron 默认值改动而回归。
- [x] A6.3 守 `test-no-prod-sends`：本阶段不新增发送路径；确认新增/改动的测试不触真实飞书/Telegram。
- [ ] A6.4 **合并，车道仍关**（`ALERT_SCAN_ENABLED` 保持 `false`，worker 完全跳过告警链，`src/pipeline/worker-main.ts:156`）。**独立 commit。**

---

# 阶段 B（commit 2）：开闸 + 观察 7 天

> **次序不可倒**：`src/config/env.ts:614` 的 superRefine 在 `ALERT_SCAN_ENABLED='true'` 而 `ALERT_MIN_PUBLISHED_AT` 未设置时 **fail-fast 拒启动**——这是**预期保护**（防启用瞬间批量推存量 P0 刷屏），不是需要绕过的 bug。

## B1. 部署（三步，缺一不可）

- [ ] B1.1 **① 先设发布时间基线水位**：生产 env 设 `ALERT_MIN_PUBLISHED_AT` = **启用时刻**的 ISO（`node -e "console.log(new Date().toISOString())"`）。只告警该基线之后发布的新闻，启用前的存量一律排除。
- [ ] B1.2 **② 再改生产 cron 覆盖值**：`ALERT_SCAN_CRON=9-59/20 * * * *`（展开 `{9,29,49}`）。**这一步 MUST NOT 省略**——机械断言只读代码里的默认值，只改默认值而不改生产覆盖值 = CI 全绿而生产照撞整点。
      - **不要用 `3-59/20`**：其 `{3}` 与 `DAILY_DIGEST_CRON` 的 `{3}` 在 **08:03 撞同一分钟**。
      - 选值原则：分钟展开集既避开 `{0,30}`，也避开其余飞书 cron 的分钟集（`{3}` 日报 / `{7}` 周报 / `{53}` MR 价格复核）。`{9,29,49}` 与三者均不相交。
- [ ] B1.3 **③ 最后置开关**：`ALERT_SCAN_ENABLED=true`，`up -d` 使 worker 注册告警链。
- [x] B1.4 更新 `DEPLOY.md`「五、实时告警启用」：在现有三步之间插入 B1.2（改 cron 覆盖值）。

## B2. 首跑核验（开闸后第一轮扫描）

- [ ] B2.1 **核验的对象是【告警候选的 `event.source` 分布】，不是「采集子集为 3 源」。**
      `selectAlertCandidates`（`alert-scan.ts:236-258`）**没有 source 谓词**；`REALTIME_NEWS_SOURCES` 只裁剪**采集**（`:336`）。而 `sitemap` **今天就在 `buildRegistry`**（`collectors/index.ts:156`）、日报链每天全量采 ⇒ **sitemap 事件早已在 `ai_news_events`**，首轮候选**会包含它们**。
      ⇒ **登记风险敞口：开闸时的风险面已经是四个源的事件。**
      ```sql
      -- 首轮（及首日）告警候选的 source 分布：预期含 sitemap，不含 arxiv / product_hunt。
      SELECT r.source, count(DISTINCT p.target_id) AS alerted
      FROM push_records p
      JOIN ai_news_events e ON e.event_id = p.target_id
      LEFT JOIN raw_items r ON r.id = e.representative_raw_item_id
      WHERE p.target_type = 'alert' AND p.status = 'success'
        AND p.pushed_at > now() - interval '1 day'
      GROUP BY 1 ORDER BY 2 DESC;
      ```

## B3. 观察与回滚判据（7 天，全部 DB 复算）

> **回滚判据必须可复算。** `p0.observed` 经 RunContext 的 console.error 结构化 JSON 落进程 **stderr**（`src/pipeline/run-context.ts:56`；仓内未装 pino），仓内**无 run 事件落库、无日志聚合** → 判据若只挂在它上面，在证伪任何东西之前就已不可执行。归因是 DB 列的**纯函数**，故判据一律用 `push_records ⋈ ai_news_events` 复算（无需任何新表/新列/日志基建，可随时重跑）。

- [ ] B3.1 **噪音判据（回滚闸）**——开闸后每日跑，**MUST 恒为 0**。噪音口径 = **告警闸不满足**的条数（阶段 B/C 只有支路 A）：
      ```sql
      SELECT count(*) FROM push_records p
      JOIN ai_news_events e ON e.event_id = p.target_id
      WHERE p.target_type = 'alert'
        AND p.status = 'success'                       -- ← 绝不可省：dispatcher 先写 pending、失败置 failed
        AND p.pushed_at > now() - interval '7 days'
        AND ( e.importance_score IS NULL
           OR e.importance_score < <threshold>          -- ← 读生产 env，不硬编码 85
           OR e.is_ai_related IS NOT TRUE );            -- ← 这一项非 0 = AI 闸失效（KVM CVE 那一类）
      ```
- [ ] B3.2 **量级判据**——7 天内 alert-success 的 distinct 事件数应落在 **≈ 26 条 / 7 天**（3.67 条/天 × 7；见 0.3）。
      **判据有功效**：日间波动窄（干净日极差 **[3, 4]**，约 **1.3×**，n=3），故 26/7d 是一个能区分信号与噪音的基线，**无需为「统计功效不足」额外留大余量**。**本条是人工判读的量级 sanity check、不是机械回滚闸**（机械闸是 B3.1 的噪音=0）：参考线为**连续 ≥3 天日均 > 2× 基线（≈7.3 条/天）**才视为噪音信号；**单日峰值不算**。恒为 0 → 与 0.3 的 `total` 对账。
      ```sql
      SELECT count(DISTINCT p.target_id) FROM push_records p
      WHERE p.target_type = 'alert' AND p.status = 'success'
        AND p.pushed_at > now() - interval '7 days';
      ```
- [ ] B3.3 **命中分数分布（人工抽检）**——逐条看标题，确认没有 KVM CVE / 癌症研究 / 探测器那一类混进来：
      ```sql
      SELECT e.event_id, e.importance_score, e.is_ai_related, e.should_push,
             e.representative_title, p.channel, p.pushed_at
      FROM push_records p
      JOIN ai_news_events e ON e.event_id = p.target_id
      WHERE p.target_type = 'alert' AND p.status = 'success'
        AND p.pushed_at > now() - interval '7 days'
      ORDER BY e.importance_score DESC;
      ```
- [ ] B3.4 **误并率**（接下 `unify-judge-stage` 下达的观察项：「开启该门的变更 MUST 把『灰区判输入含正文后的误并率』列入其观察项」）——**开闸前 7 天基线 vs 开闸后 7 天**：
      ```sql
      -- 开闸日 = <B1.3 的日期>。跑两次：窗口分别取开闸前 7 天与开闸后 7 天。
      SELECT count(*) FILTER (WHERE merged_into IS NOT NULL)                       AS merged,
             count(*)                                                              AS total,
             round(100.0 * count(*) FILTER (WHERE merged_into IS NOT NULL)
                   / nullif(count(*), 0), 1)                                       AS merged_pct
      FROM ai_news_events
      WHERE first_seen_at >= <窗口起> AND first_seen_at < <窗口止>;
      ```
      **判据**：开闸后的 `merged_pct` **显著高于**开闸前基线 ⇒ 说明「判分输入含正文」把语义合并的灰区推向了误并。逐条回查被合并事件对的标题确认：
      ```sql
      SELECT t.event_id AS tombstone, t.representative_title AS merged_title,
             s.event_id AS survivor,  s.representative_title AS survivor_title, t.first_seen_at
      FROM ai_news_events t JOIN ai_news_events s ON s.event_id = t.merged_into
      WHERE t.merged_into IS NOT NULL AND t.first_seen_at >= <开闸日>
      ORDER BY t.first_seen_at DESC;
      ```
- [ ] B3.5 **回滚**：置 `ALERT_SCAN_ENABLED=false` 重启（worker 跳过整条告警链），或 revert 本阶段 commit。**阶段 A 的修复不随开关回滚**——cron 判据、cron 值、AI 闸、共享构造器各自独立正确。

---

# 阶段 C（commit 3）：`sitemap` 进实时采集子集 + 观察

> **本阶段的收益是【压缩采集延迟】（≤24h → ≤20min），不是「让 sitemap 具备告警资格」——它今天就有**（`selectAlertCandidates` 无 source 谓词；sitemap 早已在 `buildRegistry`，日报链每天全量采）。见 design D1。

## C1. 源子集（一行常量）

- [x] C1.1 `src/collectors/index.ts` 的 `REALTIME_NEWS_SOURCES`：`['rss','hacker_news','github']` → `['rss','hacker_news','github','sitemap']`。
- [x] C1.2 同步更新写死「三源」的注释：`src/collectors/index.ts`（模块头三视图说明、`REALTIME_NEWS_SOURCES` 常量注释、`collectSources` 注释）、`src/pipeline/alert-scan.ts`（模块头、采集阶段注释）。注释里说清 sitemap 的成本形状（已见集去重在 per-article fetch 之前 + first-fetch-wins ⇒ 稳态每轮 1 次 `sitemap.xml` GET + 1 次已见集查询）。
- [x] C1.3 **高频链 MUST 补 `perSource` 源级健康告警（日报链已有，勿重复造）**。
      > **实测的当前缺口（`fix-sitemap-published-at` 已归档后基线，git `5c42f19`；0.1 的另一腿「7 天观察期满」另行核验）——只在高频链，不是「两条链都没有」**：
      > - **日报链已消费 `perSource`**：`src/pipeline/run-daily-workflow.ts:526` 的消费循环对 `ps.ok === false` 发 `alert(..., { dedupKey: 'source-health:<source>' })`（`fix-sitemap-published-at` 引入，注释在 `:517`）；`grep -c perSource run-daily-workflow.ts` → **3**（非 0）；生产入口 `run(ctx)` 在 `:1179` 注入 `alert: buildOpsAlertSink(...)`（**非 `console.error`**；`defaultAlert = consoleAlertSink`（`:137`）只是未注入时的回落，生产走 `run(ctx)` 已注入）。
      > - **高频链未消费**：`src/pipeline/alert-scan.ts` 只读 `collected.items`，**从不读 `collected.perSource`**（`grep perSource alert-scan.ts` 零命中），且按设计不调 `classifySystemFailure`（防刷屏）；`RunAlertScanOptions` 无 `alert` 字段、`alert-queue`/`worker-main` 无透传口。
      > - （`classifySystemFailure(stats: CollectStats)`（`src/pipeline/circuit-breaker.ts:92`）的入参**不含 `perSource`**——但那是「全源 0」系统判据，与源级 `perSource` 消费是两条不同链路；日报链直接读 `perSource`、不经此函数。**MUST NOT 写成对该结构字段数的现在时断言**——只依赖「它不含 `perSource`」。）
      > ⇒ **`sitemap.ts` 那句「throw → `perSource.ok=false` → 计入告警」在日报链上已兑现，只在高频链上尚是空头支票。** 缺的是**高频链的告警出口**（`runRegistry` 确已 `logError` + `console.error`，`src/collectors/index.ts:229-231`），**不是记录本身、也不是「两条链都没有」**。

      - **🔴 先开注入口 —— 告警链【没有】 `AlertSink` 注入口，不补则本条在生产上是空的**：
        - `RunAlertScanOptions`（`src/pipeline/alert-scan.ts:82-127`，首字段 `now`）的字段含 `channels` / `senders` / `lock` / `digest` / `log` / `publishedAtInfer` / `publishedAtLock` / `emit` / `judge` / `collect` / `threshold` / `windowDays` / `maxPerScan` / `dbh`——**无 `alert`**（日报链的 `RunDailyWorkflowOptions` 在 `run-daily-workflow.ts:203` **有**）。⇒ MUST 增 **`alert?: AlertSink`**（复用 `ops-alert-sink.ts:69` 导出的 `AlertSink` 类型；未注入时同样回落 stderr 的 `consoleAlertSink`）。
        - 生产接线的落点 = **`alert-scan.ts` 自己的 `run(ctx)` 包装**（`:524`，当前只传 `emit`+`now`）：MUST 在其中注入 **`alert: buildOpsAlertSink(...)`**——与日报链同型（`run-daily-workflow.ts:1179`）。**MUST 用 `buildOpsAlertSink`（自发现并懒构造生产通道）而非裸 `createOpsAlertSink`**（后者要求调用方预构造 senders map，接线步骤会悬空）。`createAlertScanWorker` / `worker-main` 无需新增透传口（注入点在 run(ctx)，不在 worker 工厂）。
        - **只加字段、不接线 = 把注入口留给测试自己填**：C2.6 的单测**自己注入 sink** ⇒ **无论生产接没接线，那些用例都恒绿**，而生产回落 `console.error` ⇒ **高频链的源级告警静默**。故 MUST 另有 **C2.7** 的「未注入即 stderr」显式回归断言。
      - **高频链 MUST 补读 `collected.perSource`**（日报链 `run-daily-workflow.ts:526` 已读），对 `ok === false` 的**结构性失败**（sitemap 的 `loc_count=0` → 整源 throw 即典型）产出告警——两条链**共用同一个判定与同一个 `dedupKey`**；**「同一个判定」含日报链既有的良性限流豁免**（`isBenignRateLimit`——现为 `run-daily-workflow.ts` 的模块私有函数：arXiv / Product Hunt 的 429 退避是设计内背压、不告警）——MUST 把该谓词提为**共享函数**供两条链 import，MUST NOT 在高频链抄一份或漏掉豁免（共享是防两链判定**静默漂移**的结构要求——今日高频子集不含 arXiv/PH、且 DB 限频已把后果封顶为每天一响，故不是止血、是防漂移）；
      - **告警 MUST 经 `createOpsAlertSink` 落真实通道**（`fix-sitemap-published-at` 在 `platform-foundation` 新建，本变更**只引用、不 MODIFY**），**`dedupKey = 'source-health:<source>'`**；
      - **限频判据 = 仅 `status='success'` 的行算「今天已告过」**：`createOpsAlertSink` 内部 `INSERT … ON CONFLICT DO UPDATE … WHERE push_records.status <> 'success'`（权威定义与形态见 platform-foundation「运维告警落真实通道并由 DB 唯一约束限频」，本变更**只引用、不 MODIFY**）。存在 `success` 行 ⇒ 认领命中 0 行 ⇒ 直接 return；**发送失败置 `failed`、不占当日限频名额、下一轮可被重新认领重试**（**MUST NOT 写成 `ON CONFLICT DO NOTHING`**——那会让一次失败/崩溃残行挡死当天全部重试 = 该告警当天彻底哑火，正是 platform-foundation 逐字禁止的形态）。高频链每天 72–96 轮 ⇒ 首个 success 轮之后其余轮全部跳过；跨进程、跨重启、跨两条链共用同一判据（并发重叠窗口的行为以 platform-foundation 的契约为准，本变更不另作「绝不双响」的更强声明）。
        **MUST NOT 用 Redis 键或进程内 Map**——进程内 Map 每次 redeploy 复位 ⇒「连续 N 轮失败」永不达标 ⇒ **静默不告警，比刷屏更糟**。（这也回答了「无状态 cron worker 的限频状态存哪」：住在 `UNIQUE(target_type, target_id, channel, push_date)` 里。）
      - **日报链那一份【已在，绝不可删】**：整条车道的回滚路径是 `ALERT_SCAN_ENABLED=false`（B3.5 / C3.1）⇒ **删掉日报链那份、只留高频链，一回滚唯一的告警出口就随之消失**；
      - **MUST NOT 套用日报的「全源返回 0」系统告警**（高频链空轮是常态）。**「不做全源 0 告警」不蕴含「不做源级健康告警」**——两条判据不同；
      - **MUST NOT 只登记后继续吞**。

## C2. 测试（护栏翻转 + 补桩，MUST 与 C1 同 commit）

- [x] C2.1 **翻转护栏断言** `src/collectors/__tests__/collectors.test.ts`：`REALTIME_NEWS_SOURCES` 对 `sitemap` 由 `not.toContain` → **`toContain`**；同一断言块仍 MUST 断言**不含** `arxiv` / `product_hunt` / `hugging_face_papers` / `blogger` / `show_hn`。`PRODUCT_SOURCES` 仍 `not.toContain('sitemap')`。
- [x] C2.2 **同步改 `it` / `describe` 描述**——绝不留一个名叫「不含 sitemap」却断言「含 sitemap」的绿用例。
- [x] C2.3 子集用例（`collectSources：按 source 筛选子集`）的 `perSource` 断言加 `'sitemap'`，**并给该用例的 `collectors` 注入桩补 `sitemap: async () => []`**——否则 `buildRegistry` 回退真实 `collectSitemaps`。
- [x] C2.4 **补 `src/pipeline/__tests__/alert-scan.integration.test.ts` 的 `collectorsReturning()` 桩**：加 `sitemap: async () => []`。该 helper 被约 20 个用例共用；**不补则这些用例会跑真实 `collectSitemaps()`**——`SITEMAP_SOURCES` 的 env 默认值即 Anthropic，且测试经 `env.ts` 的 `import 'dotenv/config'` 自动加载 `.env` ⇒ ① 真发 HTTP 到 anthropic.com；② 真把文章写进共享测试库；③ 真调 LLM。守「测试绝不触真实外部」红线。
- [x] C2.5 全量跑 `npm test`——**MUST 逐个确认无网络出站到 anthropic.com**（C2.4 的回归面）。
- [x] C2.6 **源级健康告警单测**（C1.3）：注入 `perSource = { sitemap: { ok: false, ... } }` 的采集结果 → 断言**两条链各自**都会调 sink、且 `dedupKey === 'source-health:sitemap'`；**同一源当天再次失败**（同进程多轮 / 另一条链）→ 断言**已有 `success` 行时**认领（`ON CONFLICT DO UPDATE … WHERE status <> 'success'`）命中 0 行 ⇒ **不重发**；**另断言已有 `failed` 行时可被重新认领重发**（发送失败不占当日限频名额）——限频不靠进程内状态，重启/redeploy 后判据不变；**全源返回 0 条但 `ok: true`**（正常空轮）→ 断言**不告警**（这条是防有人顺手把日报的「全源 0」系统告警搬过来）。**MUST 注入 sender mock**——绝不真发生产通道。
- [x] C2.7 **🔴「未注入即 stderr」的显式回归断言（C2.6 自己注入 sink ⇒ 它恒绿、证伪不了生产接线）**：
      - **不传** `alert` 调 `runAlertScan()`（`perSource` 含一个 `ok:false` 的源）→ 断言回落写 `console.error`（**不静默**）；
      - **生产装配路径的断言**：`alert-scan.ts` 的 `run(ctx)` 包装 MUST 把一个**非 `consoleAlertSink`** 的 sink（`buildOpsAlertSink` 产物）传给核心——这是唯一能证伪「字段加了、线没接」的用例（与日报链 `run(ctx)` 注入同型）。
      - **MUST NOT 只靠 C2.6**：一个只能被「测试自己传进来的东西」满足的契约，对生产零保证。

## C3. 部署与观察（无 env 变更、无迁移）

- [ ] C3.1 部署。**回滚 = revert 本 commit（恢复三源），或 `ALERT_SCAN_ENABLED=false`（整条车道）。**
- [ ] C3.2 观察项：
      - ① **采集延迟**是否落到 ≤20min（对一篇新 sitemap 文章，比对其 `raw_items.first_seen_at` 与页面 `published_at`）——这是本阶段的**唯一收益指标**；
      - ② `sitemap.xml` GET 是否被对方 WAF / 限流拦（UA `ai-radar`；新增稳态成本 = 每天 **72–96 次** GET + 同样次数的已见集查询）；
      - ③ 是否出现「重渲染风暴卡住 P0 车道」（预期：不发生；发生则应只卡**一轮**，且判分已由 A5 的工作预算封顶）；
      - ④ **回填「判不出」的 LLM 重试放大（同一个 72–96×/天 的系数，落在 LLM 调用上——MUST 登记，不得沉默）**：`src/agents/published-at-inference/backfill.ts:242-243` 对判不出只 `undetermined += 1; continue;`，**不写任何标记**（无 attempt 计数、无负缓存，Redis 锁 `finally` 即释放）⇒ 同一条判不出的事件**每 15–20 分钟被重新推断一次**，直到 `first_seen_at` 滑出 3 天窗——最坏 **~288 轮 × 每轮至多 LLM 重试上限次**调用。
        **实际域很小、钱不多**（rss/hn/github 实测 0 条 NULL `published_at`；`sitemap` 已被 `fix-sitemap-published-at` 整源豁免出回填域），**故本期不强制修**；观察 `undetermined` 计数是否非零。
        **廉价闸（可选补救，池变大时先做它）**：给「判不出」写负缓存标记（`infer_attempted_at` 列，或带 TTL 的 Redis 键），使窗内不反复送判。
- [x] C3.3 **护栏兑现（本阶段修高频链，见 C1.3）+ 措辞订正**：`source-collectors` 的「防静默归零」护栏（sitemap 2xx 但 `loc_count=0` → throw → `perSource.ok=false` → **计入告警**）**在高频链上无告警消费者**——`alert-scan.ts` 不读 `perSource`；**日报链已读**（`run-daily-workflow.ts:526`，fix-sitemap 引入，生产注入 `buildOpsAlertSink`）。
      ⇒ 站点改版把 sitemap 打成 0 loc 时，**高频链只落 stderr**（`runRegistry` 的 `logError`，`collectors/index.ts:229-231`），日报链会告警。**MUST NOT 把缺口夸大成「两条链都没有」或「连信号都没留下」**——缺的是高频链的**出口**，不是记录。
      **故 C1.3 修高频链那一份**（源级健康告警，两条链共用 `dedupKey`、经 ops sink、DB 唯一约束限频），**不再登记为「接受的失效」**。
- [x] C3.4 **重渲染风暴的量级更正（登记）+ 有界化**：告警链**无熔断阶段**（`alert-scan.ts` 无 `stageShouldAbort`）。LLM 全挂时，单轮 `213 × (3×60s + 15s) = 41,535s` ≈ **11.5 小时**——**不是「只卡一轮 30–60 分钟」**（那个数低估一个数量级）。
      **并发堆积不成立**（`alert-queue.ts:116` 是 `concurrency: 1`，后续 cron 只排队）；**真实风险是单轮长时阻塞 = P0 车道死大半天**。**判分已由 A5 的每轮工作预算封顶（N ≤ 3，见 A5.1b）**；`ALERT_SCAN_ENABLED=false` 是事后止血，**MUST NOT 作为唯一的运行时保护**。**登记：判分预算不封回填段**（最坏 `20 × 180s = 3600s`，域近空承载其界，见 realtime-alerts 的登记；池变大先做负缓存）。

---

# 阶段 D（commit 4）：支路 B（精确事实变更词表）+ 观察 7 天

## D1. 精确事实域词表（共享 SOT）（小节内任务按依赖序排列，编号非连续）

- [x] D1.1 新建 **`src/keywords/precise-fact.ts`**，导出**四**组常量 + 一组共现规则：`PRECISE_FACT_CORE`（取值型，advisor + P0 两侧共享）、`SELECTION_QUERY_EXT`（提问词/主观词，仅 advisor）、`FACT_CHANGE_EXT`（变更词 + 运维泛词，仅 P0）、**`NEGATIVE_PATTERNS`（器物名否定模式，**两个出口共同消费**，见 D1.10）**，外加 `PRECISE_FACT_COOCCUR`（共现，仅 advisor，见 D1.9）。
      **成员以 `specs/conversational-rag/spec.md` 的穷举表为准（那是唯一 SOT——本文件 D1.9/D1.10 的成员代码块是标注过的「落地快照」、非第二权威源，改 SOT 时 MUST 同步）**；逐词穷举写死，不得留省略号。
      口径（**作用域 = 四组裸词常量**）：全部小写、多字短语、不含单字、不含 LIKE 元字符（`%` / `_` / `\`）。**共现三表**：全部小写、不含 LIKE 元字符；意图/事实词多字，**否定词允许单字**（如 `撞`——共现否定是一票否决，误杀方向 = 落 RAG 路径**有兜底**，与裸词假阳无兜底方向相反，单字禁令不适用）。
      **模块 MUST 保持零依赖**（不 import drizzle / schema）——否则 `src/rag/price-gate.ts` 会为一份纯词表**传递依赖上 `src/db/schema`**。**这条理由 MUST 写进 `precise-fact.ts` 的文件头注释**（不写，它下次就会被人顺手合并）。**不要放 `src/rag/` 下**——那会给 `src/pipeline/alert-scan.ts` 新增一条 `pipeline → rag` 的方向依赖。
- [x] D1.2 **元字符禁令必须可强制**：`precise-fact.ts` **模块加载即断言**（比测试更难忘记）。**遍历集 MUST 含 `NEGATIVE_PATTERNS`**（它同样被渲染成 SQL `LIKE ANY` + TS `includes()` 两个出口 ⇒ 同样会静默分叉）：
      ```ts
      for (const k of [...PRECISE_FACT_CORE, ...FACT_CHANGE_EXT, ...SELECTION_QUERY_EXT,
                       ...NEGATIVE_PATTERNS,                       // ← 绝不可漏
                       ...PRECISE_FACT_COOCCUR.intent, ...PRECISE_FACT_COOCCUR.fact,
                       ...PRECISE_FACT_COOCCUR.negative]) {
        if (/[%_\\]/.test(k)) throw new Error(`词表含 LIKE 元字符: ${k}`);
      }
      for (const [name, set] of Object.entries({ PRECISE_FACT_CORE, FACT_CHANGE_EXT, SELECTION_QUERY_EXT,
                                                 NEGATIVE_PATTERNS,
                                                 COOCCUR_INTENT: PRECISE_FACT_COOCCUR.intent,
                                                 COOCCUR_FACT: PRECISE_FACT_COOCCUR.fact,
                                                 COOCCUR_NEG: PRECISE_FACT_COOCCUR.negative })) {
        if (set.length === 0) throw new Error(`词表为空: ${name}`);   // ← 空数组会让上面的循环恒过（vacuous）
      }
      ```
      `_` 是 LIKE 的**单字符通配符**（实测 `'gptX4 released' LIKE '%gpt_4%'` → `true`），而 TS 侧 `includes()` 把它当**字面量** → **SQL 与 TS 两个出口静默分叉**，没有任何测试会自然发现它。`\` 是 LIKE 默认转义符，同禁。非空 MUST 由上面的**显式 length 断言**兜住——元字符循环对空数组恒过（vacuous），光靠它「保证非空」是假的。
- [x] D1.3 **CJK 子串陷阱**：裸 `用量` **MUST NOT 入任何一组**——`'使用量'.includes('用量')` 恒真 → 「ChatGPT 周使用量破 8 亿」会直接触发 P0（一次手机震动、**无 UI 兜底**）。招牌用例「周用量上限提升 50%」由**核心的** `用量上限` 命中（**P0 支路的词源 = `PRECISE_FACT_CORE ∪ FACT_CHANGE_EXT`，不含共现** ⇒ **`用量上限` 一旦离开核心，该招牌用例即在 P0 侧失联**——见 D1.9 末条），删裸 `用量` **零召回损失**。
- [x] D1.4 **死词自检**（作用域 = **该 gate 的消费集**）：
      - `额度上限` **MUST NOT 加**——`额度` 已在核心内，`'额度上限'.includes('额度')` 恒真。
      - **存量死词也要清**：`性价比最高` ⊂ `性价比`、`哪个划算` / `哪个更划算` ⊂ `划算`、`how much does` ⊂ `how much`（删除**不改变命中集**）。
- [x] D1.5 **中英必须一致**：`rate limit` 在英文里**正是那个运维词**（「how to handle rate limit errors」/「429」）→ 它与其标准中译 **`速率限制`**、与中文裸 `限流`、与 `usage limit` **MUST NOT 作为裸词进核心**（advisor 侧假阳 = **无兜底拒答**），只进 `FACT_CHANGE_EXT`（仅 P0）。**但「不收裸词」≠「洞只能留着」——见 D1.9 的共现规则。**
      **语义过宽自检**：`报价` / `单价` / `售价` **MUST NOT 进核心**（会命中「H100 售价上调」「OpenAI 报价 X 亿收购」这类市场/并购新闻），只归 `SELECTION_QUERY_EXT`。核心保留 `价格` / `定价` / `pricing`（真·公告措辞）。
- [x] D1.9 **共现规则 `PRECISE_FACT_COOCCUR`（关掉英文取值型的存量洞，MUST）**：前置闸 MUST NOT 只由裸词 `includes` 构成，MUST 另支持**确定性共现**。**形态 = `NOT(否定项) ∧ 取值意图词 ∧ 事实名词`（否定项一票否决，优先于共现；本节「否定项」指共现否定词表 `NEG`——与 D1.10 的器物名表 `NEGATIVE_PATTERNS` 是两张不同的表）**，三组词逐词穷举、照抄：
      ```ts
      // 落地快照——照抄自 conversational-rag 穷举表（唯一 SOT）；改 SOT 时 MUST 同步本处。
      const INTENT = ['what is', "what's", 'current', 'maximum', 'how many',   // 跨语言【并集】
                      '多少', '上限是', '最多', '最高'];                        // ← 中英交叉格必须能命中
      const FACT   = ['rate limit', 'usage limit', '速率限制'];
      const NEG    = ['error','429','retry','back off','backoff','handle','handling','maxed',
                      'exceed','avoid','throttl','怎么办','怎么处理','退避','重试','撞'];
      // 命中 ⟺ !NEG.some(w=>q.includes(w)) && INTENT.some(w=>q.includes(w)) && FACT.some(w=>q.includes(w))
      ```
      **⚠️「共现比裸词窄 ⇒ 自动放过运维型」是【假的】（实测 `q.toLowerCase().includes(kw)`、无词边界）**——运维问法**照样含意图词**，不带否定项时下面五条**全部被误拦**：
      | 提问 | 为什么会被误拦 |
      |---|---|
      | `how do I set max_tokens to avoid hitting the rate limit?` | `max` ⊂ **`max_tokens`** |
      | `I maxed out my rate limit, how do I back off?` | `max` ⊂ **`maxed`**（本规范此前逐字列为「MUST NOT 拦」） |
      | `how to handle current rate limit errors` | 含 `current` |
      | `what is a rate limit error?` | 含 `what is`（本规范此前自己登记为假阳） |
      | `what is Claude's rate limit?` | ← **唯一该拦的** |
      **把运维型放回去的是【否定项】，不是共现本身。**
      - **裸 `max` MUST NOT 入意图词**（⊂ `max_tokens` / `maxed`）。`maximum` 覆盖真取值问法；`what's the max usage limit` 仍由 `what's` 命中 ⇒ **零召回损失**，且**顺带解掉「`maximum` 是死词（⊂ `max`）」**。
      - **`how much` MUST NOT 入意图词**：它已是 `SELECTION_QUERY_EXT` 的**裸词**、被本闸消费 ⇒ 共现分支**恒不独立命中** = **死规则**（违反本变更自己的死词自检 MUST）。同理 **`是多少` MUST NOT 入**（⊂ `多少`，死词）、**事实名词侧 MUST NOT 收 `用量上限`**（已是核心裸词 ⇒ 死规则）。
      - **否定项 MUST NOT 含 `hit`**：`hit` ⊂ **`white`** ⇒ 「what is Claude's rate limit for **whit**e-label apps?」会被误放行。**否定项自己也必须过子串自检。**
      - **子串自检的作用域 MUST 扩到共现的【三个词表全部】（意图 / 事实 / 否定），中英一视同仁**——本变更为 CJK 立了这条自检（`用量` ⊂ `使用量`），却从没套到英文上，而炸的两处（`max` ⊂ `max_tokens`、`hit` ⊂ `white`）**全是英文**。
      - **否定项的方向 MUST 登记为【有意】**：它把**假阳**（拒答、无兜底）换成**假阴**（落进 RAG 路径、有 `RAG_MIN_COSINE` 兜底）——**这正是本变更自己的原则（假阳无兜底 ⇒ 宁可假阴）的兑现，不是它的例外。**
      - **MUST NOT 用 LLM 复核决定是否拦截**（那把红线③交回 LLM）——纯字符串判定，可单测可回放。
      - **共现规则【只】进 advisor 消费集，MUST NOT 进 P0 词表支路**（P0 是纯标题 `LIKE ANY` 谓词，形态由 D2.1 定死）。
      - **残余洞如实登记**：无意图词的裸名词短语（「Claude rate limits?」）仍漏——收窄不是关闭。
      - **`用量上限` 恒留核心（处置 MUST NOT 是裸「移出核心」；若确须移出，MUST 同时把它加进 `FACT_CHANGE_EXT`——条件条款以 conversational-rag「若确有一天必须把 `用量上限` 移出核心」为准）**：P0 支路**不消费共现** ⇒ 移出核心 = 招牌用例「周用量上限提升 50%」**静默失联**（它今天由**核心的** `用量上限` 命中，见 D1.3）；且承载它的那条共现规则本身是**死规则**（见上）。**其 advisor 侧运维假阳是已接受代价**（进核验清单，见 D4.3）。
- [x] D1.10 **🔴 `NEGATIVE_PATTERNS`（器物名否定模式，两个出口共同消费，绝不可省——规范 MUST 了它，而本 tasks 此前【零命中】；本节「否定项」指本表，与 D1.9 共现内部的 `NEG` 是两张不同的表）**：
      ```ts
      // 落地快照——照抄自 conversational-rag 穷举表（唯一 SOT）；改 SOT 时 MUST 同步本处。
      export const NEGATIVE_PATTERNS = ['rate limiter', '限流器', '速率限制器'] as const;
      // 【MUST NOT 含 'rate limiting'】——见下裁决表。
      ```
      **动因**：正向词表里的 `rate limit` / `限流` / `速率限制` 都是**器物名的子串**（无词边界）⇒ 「`Show HN: A Rate Limiter for LLM APIs`」`is_ai_related=true`、命中 `%rate limit%`、支路 B 无 importance 地板 ⇒ **直接推手机**；`/advisor` 侧「what is a rate limiter?」⇒ **无兜底拒答**。
      **🔴 逐词裁决（`rate limiting` MUST 移出否定项——生产语料实测）**：
      | 词 | 性质 | 处置 |
      |---|---|---|
      | `rate limiter` / `限流器` / `速率限制器` | **器物名**（只有库 / 工具才叫这个） | **保留** |
      | **`rate limiting`** | **公告常用动名词**（`Improved rate limiting` / `Updating rate limiting for the Claude API`） | **MUST 移出** |
      **生产实测（30 天全语料，标题含 `rate limit*` / `限流*` / `速率限制*`）**：真命中 **2** 条、**均不含器物名** ⇒ 否定项对它们**零误杀**：
      - `Beyond rate limits: scaling access to Codex and Sora`
      - `Improved Batch Inference API: Enhanced UI, Expanded Model Support, and 3000× Rate Limit Increase`
      同窗口 `rate limiter` 工具帖 **0 条** ⇒ 本组模式防的是一个**尚未发生**的假阳（HN 语料里该类库贴常见，仍要防）；而 `rate limiting` 留在否定项里挡掉的是**真公告**。
      **方向不对称 MUST 写清**：支路 B 存在的**全部意义**是捕获 LLM 低估的事实变更 ⇒ **漏掉一条真的限流变更公告，正是它要防的失效**；误震一次（`Rate limiting best practices` 一类博文）只是烦人、可恢复。
      **残余假阳 MUST 登记**：不含器物名后缀的**博文 / 教程**（`Rate limiting best practices` / `如何做限流`）仍会**震一次手机**。本期接受，进 D4.3 核验清单。
      **两个出口的消费点（缺任一即本条落空）**：
      - **`/advisor`（`src/rag/price-gate.ts`，见 D1.7）：MUST 一票否决【两条分支】——共现分支【与】裸词分支（`PRECISE_FACT_CORE` / `SELECTION_QUERY_EXT`）。** 判定序 MUST 为「**先判否定项 → 命中即 `isPriceOrSelectionQuery` 直接返回 `false` → 再判裸词 / 共现**」。**只并进共现的否定项 MUST NOT 采用**：裸词分支会漏拦（例：「这个 **rate limiter** 的**定价**怎么算」由核心裸词 `定价` 命中 ⇒ 无兜底拒答一个工具帖提问）。
      - **P0 支路 B（`src/keywords/fact-change-gate.ts`，见 D2.1b）**：候选谓词追加 SQL 侧否定合取项。
- [x] D1.6 **全角变体**：`token 包` 的三个变体 MUST 全部在核心内——半角空格 `token 包` / **全角空格 U+3000 `token　包`** / 无空格 `token包`。半角变体匹配不到全角标题，而中文标题用全角空格分隔中英文是常态；这类漏词**恒不可见**。
- [x] D1.7 `src/rag/price-gate.ts` 的 `PRICE_GATE_KEYWORDS` 改为消费 `PRECISE_FACT_CORE ∪ SELECTION_QUERY_EXT`（**不再自维护副本**）。`isPriceOrSelectionQuery` 的**签名不变**；**匹配算法由纯 `some(kw => q.includes(kw))` 扩为**：
      ```ts
      const q = query.toLowerCase();
      if (NEGATIVE_PATTERNS.some((w) => q.includes(w))) return false;   // ← 🔴 一票否决，【优先于下面两条分支】
      return BARE.some((w) => q.includes(w)) || cooccurHit(q);          //   裸词分支 ‖ 共现分支
      ```
      **否定项 MUST 在最前、MUST 同时否决两条分支**（D1.10）——放到 `cooccurHit` 里面只挡共现，裸词分支照样拦「这个 rate limiter 的定价怎么算」。
      净变化：删 4 个死词（命中集不变）、**净增 4 词**（`定价` / `用量上限` / `weekly limit` / **全角 `token　包`**——全角变体也进 advisor 消费集）+ **一组共现规则** + **一组否定模式**。
- [x] D1.8 词表单测：
      - **正向（裸词）**——「周用量上限提到多少了」被拦为「非我域」（**不要**用「额度上限」做正例：`额度` 本就在词表内，该例证明不了新词生效）；既有价格/额度/选型正例全部保持命中。
      - **正向（共现，D1.9）**——「what is Claude's rate limit?」「what's the max usage limit?」（由 `what's` 命中，**不靠裸 `max`**）「**rate limit 最高是多少**」（**中英交叉格**：中文意图 ∧ 英文名词——原设计的漏洞）「what is Claude's rate limit for **white-label** apps?」（**该拦**；这条是「否定项 MUST NOT 含 `hit`」唯一能证伪的用例）**均被拦**。
      - **负向（防过度拦截，缺一不可）**——「API 限流了怎么办 / 429 怎么处理」「429 怎么退避重试」「我一直撞 rate limit 怎么办」「速率限制撞了怎么退避重试」「怎么降低 token 用量」「GPT-5 的使用量大吗」「how to handle rate limit errors from the Claude API」「GPT-4 被弃用了吗」**均不被拦**。
      - **负向（共现的五条毒例，MUST 逐字进用例——它们【含】意图词，光靠共现挡不住）**：「how do I set **max_tokens** to avoid hitting the rate limit?」「I **maxed out** my rate limit, how do I back off?」「how to handle **current** rate limit errors」「**what is a rate limit error**?」「Show HN: a **rate limiter** for LLM APIs」**均不被拦**（前四条由否定项 `avoid`/`maxed`/`back off`/`handle`/`error` 一票否决 + 裸 `max` 不在表内；末条无意图词）。既有负例（「评价」「代价」「MCP 协议是什么」「空串」）不变红。
      - **死词删除零影响**——「性价比最高的编程订阅是哪个」「how much does Claude Code cost?」仍被拦（由 `性价比` / `how much` 命中）。
      - **共现不外溢到 P0**——断言 P0 侧的 `factChangeTitlePredicate()` / `matchFactChangeKeywords()` **不消费**共现规则（其词源仍为 `PRECISE_FACT_CORE ∪ FACT_CHANGE_EXT`；**但 MUST 消费 `NEGATIVE_PATTERNS`**，见 D2.1b）。
      - **🔴 否定项否决【两条分支】（D1.10；缺一即漏拦）**：
        - **共现分支**——「what is a **rate limiter**?」**不被拦**；
        - **裸词分支**——「这个 **rate limiter** 的**定价**怎么算」**不被拦**（它命中核心裸词 `定价`；**只把否定项并进共现的实现会拦下它** ⇒ 这条是唯一能证伪「否定项放错层」的用例）；
        - **`限流器` / `速率限制器` 中文侧同型**——「Nginx **限流器**怎么配」「**速率限制器**的**价格**」均**不被拦**。
      - **🔴 `rate limiting` 不在否定项内（D1.10 的裁决）**——「Improved **rate limiting**」「Updating **rate limiting** for the Claude API」**仍被 advisor 侧的裸词/共现按既有口径处理**（不因否定项而被放行），且 **P0 侧照常命中**（见 D2.5）。这条防的是有人「顺手把 `rate limiting` 也加进否定项」⇒ 漏掉真的限流变更公告。

## D2. 支路 B：单一构造器、双出口

- [x] D2.1 新建 **`src/keywords/fact-change-gate.ts`**（与词表同目录，依赖 drizzle + schema）。从**同一份词表**（`PRECISE_FACT_CORE ∪ FACT_CHANGE_EXT`）导出**两个出口**：
      - `factChangeTitlePredicate()` → Drizzle `SQL` 谓词。**形态唯一，照抄**：
        ```ts
        // patterns = 词表逐词 '%' + kw + '%'；词表常量本身不含 % / _ / \（由 D1.2 的模块加载断言保证）
        sql`lower(${aiNewsEvents.representativeTitle}) like any (${sql.param(patterns)})`
        // → lower("ai_news_events"."representative_title") like any ($1)   ✅
        ```
        **绝不可把裸 JS 数组传进 `like any (${patterns})`**：drizzle 会渲染成括号参数列表（`inArray` 的机制）→ `like any (($1,$2,$3))` → **PG 42809，每轮抛错、整个告警扫描 job 失败**（已实测）。
        **同样不可省掉 `%` 包裹**：不包就是等值匹配 → **支路 B 恒空**。
        **签名恒返回 `SQL`，永不返回 `undefined`**：drizzle 的 `or()` 对空参数列表返回 `undefined`，而 `and(x, undefined)` 会**静默丢掉那一项** → D2.2 的 OR 塌缩成只剩支路 A → **支路 B 恒空且无人察觉**。
      - `matchFactChangeKeywords(title: string | null): string[]` → TS 纯函数（**签名必须接受 `null`**，与 `AlertCandidate.representativeTitle: string | null` 兼容；`null` → `[]`）。
      两出口共同口径：**小写折叠**；`representative_title IS NULL` 视为不命中。
- [x] D2.1b **🔴 否定合取项 `NEGATIVE_PATTERNS`（D1.10）——两个出口都 MUST 追加，且 SQL 侧 MUST 复用【同一个】 `lower(...)` 表达式**：
      ```ts
      // fact-change-gate.ts —— 形态唯一，照抄。
      const positive = sql`lower(${aiNewsEvents.representativeTitle}) like any (${sql.param(patterns)})`;
      const negative = sql`lower(${aiNewsEvents.representativeTitle}) like any (${sql.param(negPatterns)})`;
      //                   ^^^^^ 🔴 与正向【同一个】表达式
      return and(positive, not(negative)) as SQL;    // 恒返回 SQL，永不 undefined
      ```
      **🔴 `lower()` MUST NOT 漏（漏了它恰好在它唯一要防的那条标题上失效）**：词表**全小写**，而 PG 的 `LIKE` **区分大小写**；HN 的真实标题是 **Title Case** —— `Show HN: A **R**ate **L**imiter for LLM APIs`。
      ⇒ 写成裸 `${aiNewsEvents.representativeTitle} like any (...)`：**正向**（有 `lower()`）命中 `%rate limit%` ✅、**否定**（无 `lower()`）匹配不到 `%rate limiter%` ❌ ⇒ `NOT(false)` = `true` ⇒ **手机照震，否定项等于不存在**。
      **而规范举的样例恰好是全小写的 ⇒ 测试会绿。** 这个失效是静默的，故 D2.5 MUST 加 Title Case 用例。
      **TS 出口同口径**：`matchFactChangeKeywords()` 先 `toLowerCase()`，命中 `NEGATIVE_PATTERNS` 任一 → 返回 `[]`（与 SQL 侧等价）。
      **MUST 在 SQL 侧、MUST NOT 放应用层**：`LIMIT` 先于应用层执行 ⇒ 被否定项挡掉的候选**已经占用了名额**。
      它是**纯 `representative_title` 谓词**——不引用 `raw_items` 任何列、不依赖 join，故可原样嵌入告警闸的 LEFT JOIN 查询与回填域的 INNER JOIN 查询。
- [x] D2.2 **闸判定必须在 SQL 侧**：`src/pipeline/alert-gate.ts` 的 `alertGatePredicate()`（阶段 A 建）把**第 ③ 项换成 OR**：
      ```ts
      // drizzle 的 and / or 是【自由函数】——isNotNull(...).and(...) 编译不过。
      and(
        isNotNull(aiNewsEvents.importanceScore),                   // ① 已评分：共用前提，在 OR 之外
        eq(aiNewsEvents.isAiRelated, true),                        // ② AI 闸：共用前提，fail-closed
        or(
          gte(aiNewsEvents.importanceScore, String(threshold)),    // ③ 支路 A
          factChangeTitlePredicate(),                              // ④ 支路 B
        ),
      )
      ```
      **一处改动、两个消费点（`alert-scan.ts` 与 `backfill.ts`）同时生效**——这正是阶段 A 抽构造器的全部意义。
      **候选查询带 `ORDER BY published_at DESC LIMIT ALERT_MAX_PER_SCAN`，LIMIT 先于任何应用层过滤执行** —— 若在 TS 侧对 SQL 结果二次过滤，SQL 只会选出支路 A 的候选，**支路 B 的事件根本进不了结果集**（「实现完了、测试也写了、就是永远不触发」）。
      其余候选条件**一条不减**：时效窗口 / tombstone / 基线水位 / Model B 一生一次去重 / `ALERT_MAX_PER_SCAN` / 原子 claim。
      **`should_push` 绝不可入闸**——它正是支路 B 要推翻的那个 LLM 判断（唯一命中样本 `should_push=false`，加了它支路 B 恒为空）。
      **本期不加 source 谓词**：`ai_news_events` 的 source 全集当前即 `REALTIME_NEWS_SOURCES`，源级谓词筛 0 行。若该等式将来被打破，**加 source 谓词是正当补救**（故不写成 MUST NOT）。
- [x] D2.3 可观测归因：`p0.observed`（emit 在 `alert-scan.ts:495`）的 `hits[]` 每条**候选**加 `trigger` 与 `matchedKeywords`。
      **`trigger` 取值集定死为三元 `{'importance', 'fact-change', 'unknown'}`**，**支路 A 优先**：
      ```ts
      trigger = (importanceScore >= threshold) ? 'importance' : 'fact-change'
      ```
      `matchedKeywords` **仅在 `trigger === 'fact-change'` 时记录**。
      **`importanceScore === null` 时**（按构造不可达）：MUST 走**显式分支**，记 **error 级结构化日志** + `trigger = 'unknown'`。
      **MUST NOT 抛错中止 P0 车道**：`p0.observed` 的 emit 在全部 dispatch **之后**且**不在 try/catch 内** → 抛错 = **副作用已发生**后炸掉整轮 → `run.failed` → BullMQ 重试 → **整轮重跑**（采集/补全/评分/回填）。
      **JS 陷阱不需要 `??`**：`null >= 85` **静默求值为 `false`** —— 不加任何兜底，上面那行三元自己就会把 `null` 静默归成 `'fact-change'`、污染 D4.3 的回滚判据。要的是**显式 null 分支**。
      **亦绝不可**用 `matchedKeywords.length > 0` 反推 trigger——`matchFactChangeKeywords` 是纯标题函数，一条经支路 A 正常入选的高分事件若标题恰含词表词会返回非空，误标 `fact-change` 会**误触发回滚判据**。
      > **登记**：`p0.observed` 的 `hits[]` **仍不带 `is_ai_related`** ⇒ 新的 AI 闸在旁路信号里是**盲的**，只能靠 DB 复算看出它是否失效。可接受，如实登记。
- [x] D2.4 **告警闸单测**（每条都须钉死 `is_ai_related` / `should_push` 的取值）：
      ① 低 importance(30) + 命中词表 + `is_ai_related=true` → **告警**；
      ② `importance_score IS NULL` + 命中词表 → **不告警**（已评分前提在 OR 之外）；
      ③ 高 `developer_relevance`(95) + 低 importance + 未命中词表 → **不告警**；
      ④ 命中词表但 `published_at` 超时效窗口 / 为 NULL 未回填 / 为未来 / 早于基线水位 / tombstone → **均不告警**；
      ⑤ 命中词表但 Model B 已投递全通道 → **不重推**；
      ⑥ 高 importance(90) + 标题恰含词表词 → 归因 `trigger='importance'` 且**不记** `matchedKeywords`；
      ⑦ 低 importance + 命中词表 + **`is_ai_related=false`** → **不告警**；
      ⑧ 低 importance + 命中词表 + **`is_ai_related=NULL`** → **不告警**（fail-closed）；
      ⑨ 低 importance + 命中词表 + **`should_push=false`** + `is_ai_related=true` → **告警**（支路 B 有意覆盖 LLM 否决）；
      ⑩ 归因函数直测：`importanceScore = null` 的候选 → `trigger='unknown'` + 记 error 日志 + **不抛错**；
      ⑪ **🔴 低 importance + `is_ai_related=true` + 标题 = `Show HN: A Rate Limiter for LLM APIs`（Title Case）→ **不告警**（`NEGATIVE_PATTERNS` 否定合取项，含 `lower()`；D2.1b）；
      ⑫ **🔴 低 importance + `is_ai_related=true` + 标题 = `Improved rate limiting`（动名词）→ **告警**（`rate limiting` **不在**否定项内——挡它就是漏掉真的限流变更公告）。
- [x] D2.5 **双出口一致性测试**（本阶段最容易埋的雷）：对同一批标题（含大小写混合、含 `null`、含中英混排、含 `token 包` / `token　包` 这类带半角/全角空格的词），断言 `factChangeTitlePredicate()` 的 SQL 命中集 **== `matchFactChangeKeywords()` 的 TS 命中集**。
      **🔴 MUST 含 Title Case 用例（否定项漏 `lower()` 的唯一证伪用例——全小写样例下两种写法结果相同、恒绿）**：
      | 标题（逐字） | 期望 |
      |---|---|
      | **`Show HN: A Rate Limiter for LLM APIs`**（Title Case 器物名） | **不命中**（否定项挡住）——**否定谓词漏 `lower()` 时这条会命中 ⇒ 红** |
      | `show hn: a rate limiter for llm apis`（全小写，同一条） | 不命中（两种写法都能过 ⇒ **它证伪不了任何东西**，故不可只写这条） |
      | **`Improved Batch Inference API: Enhanced UI, Expanded Model Support, and 3000× Rate Limit Increase`**（**生产实测的支路 B 真命中，Title Case**） | **命中**——它能被正向谓词捕获，**只因为正向用了 `lower()`** |
      | `Beyond rate limits: scaling access to Codex and Sora` | 命中 |
      | **`Improved rate limiting`**（动名词，**不在否定项内**） | **命中**——防有人把 `rate limiting` 加进否定项 |
      | `Nginx 限流器最佳实践` / `速率限制器压测` | 不命中（中文器物名） |
      **不变量收窄为「ASCII + CJK 等价」**：`İ`(U+0130) 下 PG `lower()` 与 JS `toLowerCase()` 已知分叉，后果止于归因字段，MUST NOT 断言全 Unicode 等价。
- [x] D2.6 回填域测试（`alertGatePredicate()` 一改，回填域自动同步）：
      - **新增**：低 importance + 命中词表 + `is_ai_related=true` + `published_at IS NULL` → **进回填域**；低 importance + **未**命中词表 + NULL → **不进**（既有行为不变）；低 importance + 命中词表 + **`is_ai_related=false`** + NULL → **不进**。
      - 重跑 `backfill.integration.test.ts` 与 `tombstone-visibility.integration.test.ts` 的既有 alert scope 用例（其 `seedEvent` 默认标题不含任何词表词，应仍为绿）——**实跑确认，不得假定**。

## D3. 集成验证

- [x] D3.1 **招牌 e2e**：一条 `importance=30` + `should_push=false` + `is_ai_related=true` + 标题命中词表 + 近日 `published_at` 的事件 → 走完「判分 → 回填（跳过，`published_at` 非 NULL）→ 支路 B 闸 → 推送」→ **成功告警**；幂等键 `UNIQUE(target_type='alert', target_id, channel, push_date)` 行为不变。
      **MUST 注入 sender mock、钉死 channels**——绝不真发生产通道。
- [x] D3.2 **回落路径 e2e（零流量，守的是「不静默丢弃」）**：同上但 `published_at = NULL` 且源为**非豁免源**（如 `rss`；**MUST NOT 用 `sitemap`**——它已被 `fix-sitemap-published-at` 整源豁免出回填域，用它写这条断言即是把豁免写反）→ 断言该事件**落入回填域** → **显式桩掉推断器返回「无法判定」** → `published_at` 保持 NULL → **不告警**。这是**正确的失败方向**：宁可漏，绝不把老文洗成今日发布。
- [x] D3.2b **豁免优先 e2e**：同 D3.2 但源为 `sitemap` → 断言该事件**不落入回填域**（推断器**零调用**）→ `published_at` 保持 NULL → **不告警**。
- [x] D3.3 全量测试与类型检查通过。

## D4. 上线前硬前置：离线回放（**唯一能证伪「恒空」的东西**）

> 支路 B 的签名失败模式是「**恒空且无人察觉**」——上线后什么都没看到，而「什么都没看到」**正是期望值**（≤1 条 / 30 天）。**任何开关或观察期都区分不了「在工作」和「已损坏」。**
>
> ⚠️ **本节 MUST NOT 因「已通过」而被删除**：它是**常设检查**——**每次改动词表（增/删/改任一词）【或改动采集源集合】后 MUST 重跑 D4.1 并重新走 D4.2 / D4.3**。
> **重跑触发条件里的「或改采集源集合」不可省**：假阳/命中面是**语料**的函数，而**阶段 C 自己就在改语料**（`REALTIME_NEWS_SOURCES` 加 `sitemap`）。
>
> ⚠️ **回放的【分辨率上限】MUST 一并读到**：它能证伪的只有「**整表恒空**」——**证伪不了「除某一个词外全部失效」**。D4.1 的唯一命中样本（「…重置 Fable 5 **额度**了」）是由 **`额度`** 一个词命中的 ⇒ **删掉除 `额度` 外的全部 23 个词，回放依然 ① = ② = 1、D4.2 的验收判据依然全绿**。⇒ 逐词的召回**不由回放守护**，只能由「改核心词 MUST 对 advisor / P0 两个出口逐一裁决」这条纪律守护（招牌反例：把 `用量上限` 移出核心，见 D1.9 末条）。

- [x] D4.1 **🔴 MUST 重跑（词表已变：新增第四组 `NEGATIVE_PATTERNS` + 否定合取项，D1.10/D2.1b）——D4 的常设规则是「改词表【或改采集源集合】后 MUST 重跑」，本变更两者都改了。**
      **上一轮结果（2026-07-13 生产只读实测，24 词——该次实测时点的词表规模快照、无否定项）三列对照**：① 不带闸（完整词表谓词 = 正向 ∧ 非否定项，不带分数/AI 闸）= **1** · ② 支路 B 真实命中 = **1** · ③ 高分命中词表 = **0**。
      **唯一命中**：`importance=30` · `is_ai_related=true` · `should_push=false` · 「**GPT-5.6 一发布，Claude 终于舍得重置 Fable 5 额度了**」。**零噪音**（无教程 / 软文 / 论文假阳）。
      它 `should_push=false` ⇒ **正是支路 B 存在要推翻的那个 LLM 否决**；`importance=30` ⇒ **支路 A 永远抓不到它**。① == ② == 1 ⇒ 词表既没恒空、也没被谓词判空。
      > **该列未被 `is_ai_related` 的时间删失影响**（它不依赖 07-10 才上线的那个列的历史值分布），故 **≤1 条 / 30 天是成立的上界**。
      **可复算 SQL**：
      ```sql
      SELECT count(*) FILTER (WHERE true)                                    AS c1_no_gate,
             count(*) FILTER (WHERE e.importance_score IS NOT NULL
                                AND e.is_ai_related IS TRUE
                                AND e.importance_score < <threshold>)        AS c2_branch_b,
             count(*) FILTER (WHERE e.importance_score >= <threshold>)       AS c3_high_importance
      FROM ai_news_events e
      WHERE e.merged_into IS NULL
        AND lower(e.representative_title) LIKE ANY (ARRAY[ /* <patterns> */ ])
        AND NOT (lower(e.representative_title) LIKE ANY (ARRAY[ /* <negPatterns> */ ]))  -- 器物名否定项，绝不可省
        AND e.published_at > now() - interval '90 days';
      ```
      **`importance_score < <threshold>` 不可省**：按支路 A 优先归因，高分事件记 `trigger='importance'`，不属支路 B 量级。
      **时效窗保留 `90 days`，不要照抄告警闸的 3 天窗**（它复算不出量级）。生产语料实际只跨 30 天（2026-06-13 → 07-12），故 90 天窗当前等价于全量。
      > 该 SQL 为**人工只读核验**，**不纳入 CI / 自动验收**（自动验收走本地 fixture + 集成测试）。
- [x] D4.2 **MUST 随 D4.1 重跑**（上一轮：**已满足**）。支路 B 命中数落在**个位数**量级（实测 **1**），逐条人工确认为真·额度变更。**仅当「不带闸 > 0」而「支路 B 命中 = 0」时**才停下查 grounding（说明 `is_ai_related` 在 title-only grounding 下把支路 B 判空了）——实测 ① = ② = 1，不触发。
      > **重跑时的判据不变**：若改词表后命中数远超量级，或出现 D4.3 的任一类假阳 → **先修词表，不上线**。
- [x] D4.3 **人工核验清单（逐条看标题，不是只看条数）——MUST 随 D4.1 重新逐条走一遍**（上一轮 2026-07-13：零假阳）：
      | 词 | 在哪一组 | 过宽面 | 假阳落在哪一侧 |
      |---|---|---|---|
      | `quota` | **核心**（两侧共享） | ⊂ `quotation` | **P0**（一次手机震动）**＋ `/advisor`（拒答，无任何兜底）** |
      | `额度` | **核心**（两侧共享） | 「算力额度」「授信额度」 | **P0 ＋ `/advisor`（无兜底）** |
      | `价格` | **核心**（两侧共享） | 泛市场新闻（「显卡价格」「算力价格」） | **P0 ＋ `/advisor`（无兜底）** |
      | `用量上限` | **核心**（两侧共享） | 中文运维问法「撞了多久恢复」 | **`/advisor`——拒答，无任何兜底**（为保住招牌用例召回的**有意取舍**；**处置 MUST NOT 是「移出核心」**，见 D1.9） |
      | `sunset` | `FACT_CHANGE_EXT`（仅 P0） | 英文标题里的普通用法 | P0（一次手机震动） |
      | **`rate limit`** | `FACT_CHANGE_EXT`（仅 P0） | **⊂ `rate limiter`**（SQL `LIKE '%rate limit%'` 无词边界）⇒ 「**Show HN: A Rate Limiter for LLM APIs**」`is_ai_related=true` 且命中 → **直接推手机**；HN 满地都是这种库贴 | P0：**器物名由 `NEGATIVE_PATTERNS` 在 SQL 侧挡掉**（含 `lower()`，D2.1b）。**残余 = 不含器物名后缀的博文 / 教程**（`Rate limiting best practices` / `如何做限流`）⇒ **仍震一次**，逐条看标题 |
      | **`限流`** | `FACT_CHANGE_EXT`（仅 P0） | ⊂ `限流器` | 同上：`限流器` 由否定项挡掉；残余（`如何做限流` 教程贴）仍震一次 |
      | **`速率限制`** | `FACT_CHANGE_EXT`（仅 P0） | ⊂ `速率限制器` | 同上：`速率限制器` 由否定项挡掉；残余同 |
      | **`deprecat`** | `FACT_CHANGE_EXT`（仅 P0） | **词干**（有意，覆盖 `deprecated`/`deprecation`）⇒ 「如何处理 deprecated API」教程贴照样命中 | P0（一次手机震动）；**无否定项**，保留、逐条看标题 |
      > **核心词的假阳打在【两侧】**——`PRECISE_FACT_CORE` 被 `/advisor` 前置闸**同时消费**，而 **advisor 侧的假阳 = 无兜底拒答，是更贵的那一侧**。旧登记表把它们统统标成「P0 → 一次手机震动」，**漏了最贵的一侧**。
      > **🔴 `rate limiting` MUST NOT 入 `NEGATIVE_PATTERNS`（生产语料实测裁决，D1.10）**：30 天全语料里含 `rate limit*` / `限流*` / `速率限制*` 的真命中共 **2** 条（`Beyond rate limits: scaling access to Codex and Sora` / `Improved Batch Inference API: … and 3000× Rate Limit Increase`），**两条都不含器物名** ⇒ 否定项零误杀；同窗口 `rate limiter` 工具帖 **0 条** ⇒ 防的是一个尚未发生的假阳。而 `rate limiting` 是**公告的常用动名词**（`Improved rate limiting`），挡它 = **漏掉真的限流变更公告** = 支路 B 存在要防的那种失效。**方向不对称是有意的：漏一条真变更（不可恢复）> 误震一次博文（可恢复）。**

## D5. 部署与观察（7 天）

- [ ] D5.1 部署镜像（**本阶段无 schema 迁移、无新增 env**）。
- [ ] D5.2 **支路 B 的回滚判据 MUST 由 DB 复算得出，MUST NOT 去数 `p0.observed`**（它只进 stderr——console.error 结构化 JSON，仓内无落库无聚合）。
      **触发即 revert 本阶段 commit**：7 天内支路 B 的 alert-success 事件数 **> 3 条**，或出现**任一条**非事实变更的标题（教程 / 软文 / 论文）。
      ```sql
      -- 支路 B 的告警产出（DB 复算；同一词表谓词重放候选域）。
      -- 支路 A 优先归因 ⇒ `importance_score < <threshold>` 不可省，否则算出来的不是支路 B。
      SELECT count(DISTINCT p.target_id) AS branch_b_alerts
      FROM push_records p
      JOIN ai_news_events e ON e.event_id = p.target_id
      WHERE p.target_type = 'alert' AND p.status = 'success'
        AND p.pushed_at > now() - interval '7 days'
        AND e.importance_score IS NOT NULL
        AND e.is_ai_related IS TRUE
        AND e.importance_score < <threshold>
        AND lower(e.representative_title) LIKE ANY (ARRAY[ /* <patterns> */ ])
        AND NOT (lower(e.representative_title) LIKE ANY (ARRAY[ /* <negPatterns> */ ]));
      ```
      **逐条看标题**（判据的另一半——「零非事实变更标题」只能人眼看）：
      ```sql
      SELECT e.event_id, e.importance_score, e.should_push, e.representative_title, p.pushed_at
      FROM push_records p
      JOIN ai_news_events e ON e.event_id = p.target_id
      WHERE p.target_type = 'alert' AND p.status = 'success'
        AND p.pushed_at > now() - interval '7 days'
        AND e.importance_score IS NOT NULL AND e.is_ai_related IS TRUE
        AND e.importance_score < <threshold>
        AND lower(e.representative_title) LIKE ANY (ARRAY[ /* <patterns> */ ])
        AND NOT (lower(e.representative_title) LIKE ANY (ARRAY[ /* <negPatterns> */ ]))
      ORDER BY p.pushed_at DESC;
      ```
- [ ] D5.3 **噪音判据更新为终态口径**（替换 B3.1 的阶段 B/C 版）——**支路 B 的低分命中 MUST NOT 计入噪音**，否则回滚判据会把新功能自己当噪音关掉：
      ```sql
      -- 噪音 = 两条支路【皆不满足】的条数。MUST 恒为 0。
      SELECT count(*) FROM push_records p
      JOIN ai_news_events e ON e.event_id = p.target_id
      WHERE p.target_type = 'alert'
        AND p.status = 'success'                          -- ← 绝不可省
        AND p.pushed_at > now() - interval '7 days'
        AND ( e.importance_score IS NULL
           OR e.is_ai_related IS NOT TRUE
           OR ( e.importance_score < <threshold>          -- ← 支路 A 不满足
                AND ( lower(e.representative_title) LIKE ANY (ARRAY[ /* <patterns> */ ])
                      AND NOT (lower(e.representative_title)      -- 支路 B 的否定项（D1.10）
                               LIKE ANY (ARRAY[ /* <negPatterns> */ ])) ) IS NOT TRUE ) );
                -- ↑ 支路 B 判定整体 IS NOT TRUE（而非 NOT(...)）：representative_title 为 NULL 时
                --   LIKE 求值为 UNKNOWN、NOT(UNKNOWN) 仍是 UNKNOWN 会把该行漏出噪音口径；IS NOT TRUE 把 NULL 按「不满足支路 B」计
      ```
- [ ] D5.4 记录首轮命中词分布作为词表校准基线。**该观测只能校准误报、校准不了漏词**（未命中即无记录）——**漏召是本阶段的主要残余风险**，只能靠人工发现「某条该推的没推」或离线全量回放（D4）暴露。

---

## 5. 归档前（基线核对，MUST）

> `openspec-cn` 1.6.0 的 MODIFIED 是**整条需求替换**，归档守卫（`specs-apply.js:220`）要求 MODIFIED 块的**场景名集合是主规范该需求的超集**（少一个即 throw，`validate --strict` **抓不到**）。合并后 `realtime-alerts` / `feishu-push` / `model-radar-ingestion` / `conversational-rag` **只被本变更 MODIFY 一次 ⇒ 基线即当前主规范、零碰撞**。剩下两处碰撞：

- [x] 5.1 **`specs/source-collectors/spec.md` 的「sitemap 增量采集」已按 `fix-sitemap-published-at` 的 delta 全文重取基线**（2026-07-14）。**有意翻转仅两处**，其余整条逐字继承：
      | 翻转点 | 基线（fix-sitemap） | p0 |
      |---|---|---|
      | 源子集归属（正文末段） | `MUST NOT 纳入 REALTIME_NEWS_SOURCES`（per-article fetch 较重） | **`MUST 纳入`** + 「实时子集归属」段（成本 / 延迟收益 / 「买到的是采集延迟不是告警资格」/ 重渲染风暴落点 / arxiv·PH 仍排除） |
      | 场景「sitemap 源不进实时告警/产品子集」正文 | 不在 `REALTIME_NEWS_SOURCES`/`PRODUCT_SOURCES` | **在** `REALTIME_NEWS_SOURCES`、**不在** `PRODUCT_SOURCES`（场景名按归档守卫要求保留原样） |
      **在基线之上【只增不减】的两处**：① 源级健康告警**扩到两条链**（基线的「日报链 MUST …」逐字保留，追加高频链 + 共用 `dedupKey` + DB 唯一约束限频 + 「回滚即 `ALERT_SCAN_ENABLED=false`，只放高频链则出口消失」）；② 场景「源级健康告警对每个失败源各响一条」追加一条 `**且**` 覆盖高频链。
      **`published_at_authority` 的基线是【两级非空】**（`sitemap` 的页面确定性提取 → **2**；**其余一切非页面提取的日期值**——rss 的 `pubDate`、hacker_news 与 show_hn 的投稿时刻、github 的 push 时刻、AI 推断——一律 → **1**，同档互不覆盖；无日期 → 0）。**MUST NOT 在第 1 档内部再排序**：档内任何排序都会引入一条能把日期**往后推**的覆盖关系（如让转载 RSS 的今日 pubDate 覆盖 LLM 正确推断出的 2023 年发布日）⇒ 老文又看起来是新的。
      **三个新场景已在 delta 内**（归档守卫要求 MODIFIED 块是主规范场景名的**超集**，fix-sitemap 先归档 ⇒ 缺一即 throw）：`日期提取归零由 DB 复算触发告警（与哪条链采的无关）` / `窗内有候选却零发射时整源失败并告警` / `源级健康告警对每个失败源各响一条`。
      **本条的根因就是 p0 自己**：`sitemap` 进 `REALTIME_NEWS_SOURCES` 后，高频链每 15–20min 先采走新文入库 ⇒ 已见集（`raw_items WHERE source='sitemap'`，**不分链**）已含该文 ⇒ 日报链跑 sitemap 时 `emitted = 0` **每天恒成立** ⇒ 旧版那条「`emitted>0 ∧ date_extracted=0`」的告警**永不触发**。基线已把支路①改为 **DB 复算**、支路②改为**采集器内 throw**，二者都与「谁采的」无关。
- [x] 5.2 **`specs/published-at-inference/spec.md` 的基线 = 当前主规范，已核：无碰撞**（2026-07-14）。`fix-sitemap-published-at` 在该 capability 下走的是 **`## ADDED Requirements`**、需求名为**`确定性提取源豁免 AI 发布日推断`**（另一条需求），而 p0 MODIFY 的是 **`缺失发布时间的 AI 语义推断`** ⇒ 两者**不同名、不碰撞**。p0 delta 已多处引用该豁免需求（A3.3 / D3.2b / 回填域的「豁免源排除」合取项），**MUST NOT 删除**。
- [ ] 5.3 **归档序 MUST 为**：`fix-sitemap-published-at` → `unify-judge-stage` → `p0-alert-lane`。
- [ ] 5.4 **每个 delta 的场景名 MUST 是主规范该需求的超集**（逐条比对；`validate --strict` 抓不到这一条）。

## 6. 规范一致性与验收

- [x] 6.1 `openspec-cn validate p0-alert-lane --strict` 通过。
- [x] 6.2 proposal 的 Modified Capabilities 与 `specs/` 目录**逐一对上**（6 个：`realtime-alerts` / `feishu-push` / `source-collectors` / `model-radar-ingestion` / `conversational-rag` / `published-at-inference`）。
- [x] 6.3 `npm run typecheck` / `lint` / `test` 全绿。
- [x] 6.4 守 `test-no-prod-sends`：新增/改动的测试不触真实飞书/Telegram。
