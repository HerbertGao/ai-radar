# 设计

## Context

P0 车道（`src/pipeline/alert-scan.ts`）代码完整、开关常关（`ALERT_SCAN_ENABLED=false`），从未在生产跑过一轮。本变更把它**一次开到终态**：告警闸 = `已评分 ∧ is_ai_related=true ∧ (支路 A OR 支路 B)`，`sitemap` 进实时采集子集，cron 判据修根因，观察/回滚判据落到 DB 复算。

## D0 为什么把三件事合并成一个变更（而不是三个环）

原计划是三个串行变更（开闸 → sitemap 进子集 → 支路 B）。合并的理由是**结构性的**，不是省事：

1. **`realtime-alerts` 的「重大发布事件级实时告警」是一条 ~200 行的上帝需求。** `openspec-cn` 的 `## MODIFIED Requirements` 是**整条需求替换**，归档守卫（`specs-apply.js:220`）**只比场景名、不比正文** ⇒ 碰它的每一环都必须把 200 行**抄一遍**，任何一环抄漏一段就是**静默回滚**。这不是理论风险：拆分方案里的第 3 环（支路 B）在撰写时**已经真的丢掉了**第 2 环（sitemap）写进去的子集段与两条成本登记——损害为零纯属运气（另一个 capability 里恰好有副本）。

2. **拆分买到的是「独立可回滚」的外观，不是实质。** 第 2 环一归档，第 1 环就**不可能被单独 revert**——它的 MODIFIED 已被覆写进主规范，openspec 无 un-archive。

3. **AI 闸必须一次写对两处。** 告警闸与 `published-at-inference` 的回填域必须同构（见 D3）。分环写 = 第 1 环先给告警闸加 AI 闸、把回填域留宽，第 3 环再收口——中间那段时间回填域**比闸宽**，而回填有固定 `LIMIT`（默认 20）⇒ **饥饿**，不是「浪费配额」（见 D3）。

合并后：`realtime-alerts` 的两条需求**只被 MODIFY 一次**，基线就是**当前主规范**，一次写成终态 ⇒ 基线碰撞归零。

**「先开闸 → 再第四源 → 再支路 B」是一条【部署序列】，不是【规范变更序列】。** 它由 tasks 的**四个阶段 + 四个独立 commit + 四次改生产 env** 兑现——观察窗与 revert 点一个不少（见 tasks）。

## D1 `selectAlertCandidates` 没有 source 谓词 —— sitemap 进子集买到的是延迟，不是资格

`selectAlertCandidates`（`alert-scan.ts:236-258`）的 `WHERE` 里**没有任何 source 条件**。`REALTIME_NEWS_SOURCES` 的**唯一**运行时消费点是采集阶段（`alert-scan.ts:336` 的 `collectSources(REALTIME_NEWS_SOURCES, …)`）。而 `sitemap` **今天就在 `buildRegistry`**（`collectors/index.ts:156`）、日报链每天全量采 ⇒ **sitemap 事件早已躺在 `ai_news_events` 里**。

⇒ 开闸第一天，一篇当天发布的 Anthropic 官方新闻（实测 `importance` 曾到 88）就能直接 P0 告警——**跟 sitemap 在不在实时子集里毫无关系**。

**故：**
- **阶段 C 的收益是「压缩 sitemap 的采集延迟」**（≤24h → ≤20min），**不是**「让 sitemap 具备告警资格」。
- **阶段 B 的首跑核验不是「核验采集子集为 3 源」**，而是**「核验首轮告警候选的 `event.source` 分布」**（它会包含 sitemap）。
- **阶段 B 开闸时，风险面已经是四个源的事件。** 如实登记。

## D2 告警闸的最终形态：两支路 + 两项共用前提

```
importance_score IS NOT NULL                              -- ① 已评分：共用前提，在 OR 之外
AND is_ai_related = true                                  -- ② AI 闸：共用前提，fail-closed
AND ( importance_score >= ALERT_IMPORTANCE_THRESHOLD      -- ③ 支路 A
   OR representative_title 命中「精确事实变更词表」        -- ④ 支路 B
)
```

**①「已评分」MUST 在 OR 之外。** 写成 `(已评分 AND 支路A) OR 支路B` 时，**评分失败 / claim 被日报链抢走 / LLM 降级**（`importance_score` 留 NULL）的事件只要标题命中词表就直接推 P0——**绕过 Value Judge 阶段本身**。极端情况：LLM 当轮全挂，所有含 `pricing` 的采集条目直接进推送。

**②「AI 闸」为两支路共用（`= true`，fail-closed）。** 两支路各自需要它的理由不同、结论相同：

| 支路 | 为何需要 AI 闸 |
|---|---|
| A | `importance` 衡量「有多重要」，**不是**「是不是 AI 新闻」——两根轴正交。HN 头版的 KVM 逃逸 CVE（95）/ 合成活细胞（95）/ Linux LUKS bug（92）/ 癌症研究 / 土卫六探测器 / PID 控制器，无此闸会被全推到手机上。 |
| B | **无 importance 地板**——一条与 AI 无关的随机 SaaS「Introducing our new pricing」帖只要命中词表就会被推送。 |

**极性 MUST 为 `= true`，MUST NOT 为 `IS NOT FALSE`**：`false` 与 `NULL` 一律排除，与日报要闻闸 `eq(is_ai_related, true)`（`src/selection/top-n.ts:269`）同源。

> **AI 闸的实测拦截率极低（诚实登记）**：在该列全天生效的三个干净日（07-11 / 07-12 / 07-13），支路 A 的 **11** 条候选里 `is_ai_related IS FALSE` 的为 **0 条**（**0 拦 / 11 过**；07-10 回填日挡掉 1/14）。**它是一道尾部保险，不是一道高频过滤器。**（曾被用来给它背书的「24.3%」测的是 **`should_push=false`**，不是 `is_ai_related`——那 6 条抽样里 5 条的 `is_ai_related` 是 **NULL**，被挡住靠的是 fail-closed 对 NULL 的排除，而 NULL 是 2026-07-10 该列写路径上线前的历史产物、**不会重演**。该数字 MUST NOT 再被用来给 AI 闸背书。）

**闸里没有 `should_push`。** `is_ai_related` 判的是「这条是不是 AI 领域的事」，`should_push` 判的是「这条值不值得推」——**只否决后者，不否决前者**。支路 B 的全部意义正是推翻后者（唯一生产命中样本 `importance=30` / `should_push=false`，加上它支路 B 恒为空）。

**支路 B 是本系统唯一一处「确定性规则覆盖 LLM 否决」的通道**（其余确定性闸都是 fail-closed 的 AND、只收紧不放宽）。规范为它立了边界条款：新增同类通道 MUST 另起提案 + MUST 出示该类事件上 LLM 判断**系统性失效**的生产证据。否则告警闸会被逐条 OR 稀释成一堆词表。

## D3 `alertGatePredicate()`：一个构造器，两个消费点（结构替代散文）

`backfill.ts:191-192` 是 `.orderBy(desc(firstSeenAt)).limit(maxPerRun)`，`PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 默认 **20**。**有固定 LIMIT 就有饥饿。**

⇒ 回填域若比告警闸**宽**，宽出去的那些（高 importance 的**非 AI** 新闻）会**占掉 20 个名额**，把真正在闸内、`published_at IS NULL` 的事件**挤出本轮回填** → 保持 NULL → 被告警闸的 NULL 排除挡住 → **永不告警、可观测无痕迹**。这恰恰是 `published-at-inference` 主规范自己列为要防的危害（「饿死近期 NULL 事件」）。⇒ **「回填域比闸宽只浪费配额」是错的。**

**处置（结构，不是散文）**：**阶段 A 就抽 `alertGatePredicate()` 共享构造器**（5 行），`selectAlertCandidates`（`alert-scan.ts`）与 `scopePredicate`（`backfill.ts:104-114`）**同调**：

```ts
// src/pipeline/alert-gate.ts —— 告警闸的唯一定义；alert-scan 与 backfill 同调。
export function alertGatePredicate(threshold: number): SQL {
  return and(
    isNotNull(aiNewsEvents.importanceScore),                       // ① 已评分
    eq(aiNewsEvents.isAiRelated, true),                            // ② AI 闸：fail-closed，绝不写 IS NOT FALSE
    gte(aiNewsEvents.importanceScore, String(threshold)),          // ③ 支路 A（numeric 列在 drizzle 里映射为 string）
  ) as SQL;
}
```

**阶段 D 把 ③ 换成 OR，一处改动、两个消费点同时生效**（这正是抽构造器的全部意义）：

```ts
    or(
      gte(aiNewsEvents.importanceScore, String(threshold)),        // ③ 支路 A
      factChangeTitlePredicate(),                                  // ④ 支路 B（恒返回 SQL，见 D4）
    ),
```

⇒ AI 闸**一次写对两处**，回填域在**每个阶段**都 **== 告警闸**，结构上不可能漂移。**因此「MUST NOT 反向把 AI 闸从告警闸摘掉」这类散文警告一概不写**——它们是在补一个结构缺口，缺口补上了，警告就是噪音。

> **「同构」仅指该共享谓词（防 overclaim）**：回填域另有**四个**合取项——`published_at IS NULL`、`first_seen_at` 超窗剪枝、**豁免源排除**（`ne(rawItems.source, 'sitemap')`，由硬前置 `fix-sitemap-published-at` 引入：该源的发布日由确定性页面提取产出，提取失败即 NULL 且 MUST NOT 转 LLM 猜；tasks A3.3 明文护住「MUST NOT 顺手删掉豁免源谓词」）、**代表 raw_item 存在**（回填查询用 **INNER JOIN**，告警闸用 **LEFT JOIN**）。故 `representative_raw_item_id` 为 NULL 的事件**进得了告警候选、进不了回填域**；`sitemap` 的 NULL 事件同理。两者都不是缺陷（无代表 raw_item 即无线索；豁免源是被论证过的取舍），但 MUST NOT 说成「完全同构」。

**阶段序（不要写反）**：`alert-scan.ts` 是 `判分 → 回填 → 选候选`。回填时 `importance_score` 已非 NULL，故回填域可与告警闸共用「已评分」前提。

## D4 支路 B 的闸判定必须在 SQL 侧

候选查询是 `... ORDER BY published_at DESC LIMIT ALERT_MAX_PER_SCAN`。**LIMIT 先于任何应用层过滤执行** —— 把词表匹配放 TS 侧做二次过滤，SQL 只会选出支路 A 的候选，**支路 B 的事件根本进不了结果集**。失败模式是「实现完了、测试也写了、就是永远不触发」。

SQL 谓词形态**唯一，照抄**：

```ts
sql`lower(${aiNewsEvents.representativeTitle}) like any (${sql.param(patterns)})`
// → lower("ai_news_events"."representative_title") like any ($1)   ✅
```

裸 JS 数组会被 drizzle 渲染成 `like any (($1,$2,$3))`（`inArray` 的机制）→ **PG 42809，每轮抛错、整个 job 失败**。`sql.param()` 单参数、词表增删不改变计划形状。

`factChangeTitlePredicate()` **签名恒返回 `SQL`、永不返回 `undefined`**：drizzle 的 `or()` 对空参数列表返回 `undefined`，而 `and(x, undefined)` 会**静默丢掉那一项** → OR 塌缩成只剩支路 A → **支路 B 恒空且无人察觉**。

> **drizzle 的 `and` / `or` 是自由函数**：写成 `isNotNull(...).and(...)` 编译不过。照 D3 的形态。

## D5 词表：两个文件、四组常量 + 一组共现规则、模块加载即断言

| 文件 | 内容 | 依赖 |
|---|---|---|
| `src/keywords/precise-fact.ts` | **四**组词表常量（含 **`NEGATIVE_PATTERNS`**，见下）+ **`PRECISE_FACT_COOCCUR` 共现规则**（取值意图词 ∧ 事实名词，**仅 advisor 消费**）+ **模块加载即断言**（遍历集含 `NEGATIVE_PATTERNS`：不含 `%` / `_` / `\`、非空） | **零依赖** |
| `src/keywords/fact-change-gate.ts` | `factChangeTitlePredicate()` → Drizzle `SQL`（正向 `LIKE ANY` **∧ NOT** 器物名 `LIKE ANY`）；`matchFactChangeKeywords(title: string \| null)` → `string[]` | drizzle + `src/db/schema` |

**第四组常量 `NEGATIVE_PATTERNS`（器物名，两个出口共同消费）= `rate limiter` · `限流器` · `速率限制器`。** 正向词表里的 `rate limit` / `限流` / `速率限制` 都是这些器物名的**子串**（无词边界）⇒ 「`Show HN: A Rate Limiter for LLM APIs`」`is_ai_related=true` 且命中 `%rate limit%`、支路 B 无 importance 地板 ⇒ **直接推手机**；advisor 侧「what is a rate limiter?」⇒ **无兜底拒答**。

**`rate limiting` 不入否定项（生产语料实测裁决）**：30 天全语料里含 `rate limit*` / `限流*` / `速率限制*` 的真命中共 2 条——`Beyond rate limits: scaling access to Codex and Sora` 与 `Improved Batch Inference API: … and 3000× Rate Limit Increase`——**两条都不含器物名** ⇒ 否定项零误杀；同窗口 `rate limiter` 工具帖 **0 条** ⇒ 防的是一个**尚未发生**的假阳（HN 语料里该类库贴常见，仍要防）。而 `rate limiting` 是**公告的常用动名词**（`Improved rate limiting`），挡它就是**漏掉真的限流变更公告**——而那正是支路 B 存在要防的失效。**方向不对称是有意的**：漏一条真变更（不可恢复）远重于误震一次博文（可恢复）。**残余假阳登记**：不含器物名后缀的博文 / 教程（`Rate limiting best practices`）仍会震一次。

**两个出口的落点（缺任一即空转）**：
- **`/advisor`**：**一票否决【两条分支】——共现【与】裸词**。判定序 = 「先判否定项 → 命中即整闸返回 `false` → 再判裸词 / 共现」。**只并进共现的否定项不行**：裸词分支会漏拦（「这个 **rate limiter** 的**定价**怎么算」由核心裸词 `定价` 命中 ⇒ 无兜底拒答一个工具帖提问）。
- **P0 支路 B**：SQL 侧否定合取项。**MUST 复用与正向【同一个】 `lower(representative_title)` 表达式**——词表全小写而 PG `LIKE` 区分大小写，HN 标题是 **Title Case**（`A **R**ate **L**imiter`）⇒ 正向（有 `lower()`）命中、否定（无 `lower()`）不命中 ⇒ `NOT(false)` = true ⇒ **手机照震**。**而规范样例恰好全小写 ⇒ 测试会绿**，这个失效是静默的 ⇒ 一致性测试 MUST 含 Title Case 用例。放应用层同样不行：`LIMIT` 先于应用层执行，被挡掉的候选已占名额。

**必须分开**：`src/rag/price-gate.ts` 只需要词表；若词表模块 import drizzle/schema，`price-gate.ts` 会为一份纯字符串数组**传递依赖上整个 `src/db/schema`**。这条理由 MUST 写进 `precise-fact.ts` 的文件头注释。放 `src/keywords/` 而非 `src/rag/`：它被 `pipeline` / `agents` / `rag` 三层共同消费。

**双出口的一致性边界**：SQL `LIKE ANY`（逐词包 `%`）与 TS `String.includes()`。
- **`_` 是 LIKE 的单字符通配符**（实测 `'gptX4 released' LIKE '%gpt_4%'` → `true`），TS 侧当**字面量** → 含 `_` 的词让两个出口**静默分叉**，没有任何测试会自然发现它。`\` 是 LIKE 默认转义符，同禁。⇒ **模块加载即断言**（比测试更难绕过）。
- **不变量收窄为「ASCII + CJK 等价」**：`İ`(U+0130) 下 PG `lower()`（glibc → `i`）与 JS `toLowerCase()`（→ `i` + U+0307）分叉。后果止于归因字段，MUST NOT 声称全 Unicode 等价。

**三条选词规则**（每条防一类已知的静默失效）：
1. **死词自检**（作用域 = **该 gate 的消费集**）：`W` 是死词 ⟺ 消费集中存在更短的 `S` 使 `W.includes(S)` 恒真 —— `some(kw => q.includes(kw))` 下 `S` 先满足。`额度上限` ⊂ `额度` → 死词。存量死词也要清（`性价比最高` ⊂ `性价比`、`哪个划算`/`哪个更划算` ⊂ `划算`、`how much does` ⊂ `how much`；删除**不改变命中集**）。
2. **CJK 子串陷阱**：`'使用量'.includes('用量')` **恒真** → 裸 `用量` MUST NOT 入表。招牌用例「周用量上限提升 50%」由 `用量上限` 命中，删裸 `用量` 零召回损失。
3. **中英一致**：`rate limit` 在英文里**正是那个运维词**（「how to handle rate limit errors」/「429」），与中文裸 `限流`、与标准中译 `速率限制` 完全同类 → 三者都 MUST NOT 作为**裸词**进核心（advisor 侧假阳 = 拒答、**无兜底**），只进 P0 扩展。

**但「不收裸词」≠「洞只能留着」——advisor 侧另设【确定性共现规则】**，形态为 **`NOT(否定项) ∧ 取值意图词 ∧ 事实名词`**：

```
INTENT = what is · what's · current · maximum · how many · 多少 · 上限是 · 最多 · 最高   （跨语言并集）
FACT   = rate limit · usage limit · 速率限制
NEG    = error · 429 · retry · back off · backoff · handle · handling · maxed · exceed ·        ← 落地快照，SOT = conversational-rag 穷举表
         avoid · throttl · 怎么办 · 怎么处理 · 退避 · 重试 · 撞          ← 一票否决，优先于共现
```

**否定项不是可选项——「共现比裸词窄 ⇒ 自动放过运维型」是【假的】（实测）**：运维问法**照样含意图词**——`how do I set max_tokens to avoid hitting the rate limit?`（`max` ⊂ `max_tokens`）、`I maxed out my rate limit, how do I back off?`、`how to handle current rate limit errors`、`what is a rate limit error?`——不带否定项时**全部被误拦**，而这批里只有「what is Claude's rate limit?」该拦。把运维型放回去的是**否定项**，不是共现本身。

**三条词表约束（每条对应一个实测的静默失效）**：① **裸 `max` MUST NOT 入意图词**（⊂ `max_tokens` / `maxed`；`maximum` 覆盖真取值问法、`what's the max usage limit` 由 `what's` 命中 ⇒ **零召回损失**，且**顺带解掉「`maximum` 是死词（⊂ `max`）」**）；② **`how much` MUST NOT 入意图词**（它已是 `SELECTION_QUERY_EXT` 的裸词 ⇒ 共现分支恒不独立命中 = **死规则**；同理 `是多少` ⊂ `多少`、事实名词侧的 `用量上限` 已是核心裸词）；③ **否定项 MUST NOT 含 `hit`**（`hit` ⊂ **`white`** ⇒ 「rate limit for **white**-label apps」会被误放行）——**否定项自己也要过子串自检**。

**子串自检的作用域 MUST 覆盖共现的三个词表全部（意图 / 事实 / 否定），中英一视同仁**：本规范为 CJK 立了这条自检（`用量` ⊂ `使用量`），却从未套到英文上，而炸掉的两处（`max` ⊂ `max_tokens`、`hit` ⊂ `white`）**全是英文**。

**否定项的方向是【有意】的**：它把**假阳**（拒答，无兜底）换成**假阴**（落进 RAG 路径，有 `RAG_MIN_COSINE` 兜底）——**这正是本规范自己的原则（假阳无兜底 ⇒ 宁可假阴）的兑现，不是它的例外**。

**MUST NOT 用 LLM 复核决定是否拦截**（那把红线③交回 LLM）。**共现规则只进 advisor**，不进 P0——P0 是纯标题词表谓词（SQL `LIKE ANY`，D4 的形态不变），且新闻标题里的 `rate limit` 几乎必是变更公告。

**全角变体**：`token 包` 的三个变体（半角空格 / **全角空格 U+3000** / 无空格）MUST 全在表内——中文标题用全角空格分隔中英文是常态；这类漏词**恒不可见**。

## D6 归因：支路 A 优先，NULL 走显式分支

```ts
trigger = (importanceScore >= threshold) ? 'importance' : 'fact-change'   // 支路 A 优先
```

（候选层已数值化：`AlertCandidate.importanceScore` 经 `Number()` 转为 `number | null`（`alert-scan.ts:272`），三元可直接数值比较——该事实以 `AlertCandidate` 现状为准。）

- `matchedKeywords` **仅在 `trigger === 'fact-change'` 时记录**。**MUST NOT 用 `matchedKeywords.length > 0` 反推 trigger** —— `matchFactChangeKeywords` 是纯标题函数，一条经支路 A 正常入选的高分事件若标题恰含词表词也会返回非空 → 误标 `fact-change` → **误触发回滚判据**（把一个正常工作的功能当噪音关掉）。
- **`importanceScore === null`（按构造不可达）MUST 走显式分支**：记 **error 级结构化日志** + `trigger='unknown'`，**MUST NOT 抛错**。`p0.observed` 的 emit 在 `alert-scan.ts:495`，**在全部 dispatch 之后、且不在 try/catch 内** → 抛错 = 副作用已发生后炸掉整轮 → BullMQ 重试 → 整轮重跑。
- **JS 陷阱不在缺省值**：`null >= 85` **静默求值为 `false`** —— 不需要任何 `?? 0` 就会把 NULL 候选静默归成 `'fact-change'`、污染回滚判据。`'unknown'` 的全部意义就是让这条静默路径**在日志里显形**。

> **`p0.observed` 的 `hits[]` 不带 `is_ai_related`（登记）**：新的 AI 闸在旁路信号里是**盲的**——只能从 DB 复算看出它是否失效。可接受（复算能兜），如实登记。

## D7 cron 展开器：fail-closed，且文法要覆盖 `a/n`

判据 = 「分钟字段**展开后的分钟集合** ∩ {0,30} = ∅」。

**文法必须覆盖 cron 分钟字段的全部合法形式**：`*` / `*/n` / `a-b` / `a-b/n` / **`a/n`**（隐式 `a-59/n`，BullMQ 用的 `cron-parser` 支持）/ `a,b,c` / 纯数字。

**漏掉 `a/n` 的后果是恒绿**：喂 `0/15` → 各项都不匹配 → 展开器返回**空集** → `∅ ∩ {0,30} = ∅` → **判过**。而 `0/15` 实际展开 = `{0,15,30,45}` —— **违反，却被判过。**

⇒ **MUST：无法展开的分钟字段即判违反（fail-closed）。** 一个「解析不出就当合规」的守卫，正是这条变更花整节论证要杀死的东西。

**cron 选值原则**：分钟展开集既避开 `{0,30}`，也避开其余飞书 cron 的分钟集（`{3}` 日报 / `{7}` 周报 / `{53}` MR 价格复核）。默认值 `4-59/15` → `{4,19,34,49}`；生产值 `9-59/20` → `{9,29,49}`。**不要用 `3-59/20`**（其 `{3}` 与日报 `{3}` 在 08:03 撞同一分钟）。

## D8 归档基线（合并后的碰撞面）

`openspec-cn` 1.6.0 的归档守卫（`specs-apply.js:220`）要求 MODIFIED 块的**场景名集合是主规范该需求的超集**（少一个即 throw，`validate --strict` **抓不到**）；MODIFIED 是**整条需求替换**（正文漏抄 = 静默回滚）。

| capability | 基线 | 备注 |
|---|---|---|
| `realtime-alerts` / `feishu-push` / `model-radar-ingestion` / `conversational-rag` | **当前主规范** | 合并后各只被本变更 MODIFY 一次 ⇒ **零碰撞** |
| `source-collectors`「sitemap 增量采集」 | **`fix-sitemap-published-at` 的 delta 全文** | 前置变更也 MODIFY 这条 ⇒ 归档前 MUST 以其归档后的主规范重新核对（tasks 5.1） |
| `published-at-inference` | 当前主规范 | 若 `fix-sitemap-published-at` 把「sitemap 源不回落 AI 推断」落在**这个** capability，归档前 MUST 同步（tasks 5.1） |

## D9 上线前硬前置：支路 B 的离线回放（唯一能证伪「恒空」的东西）

支路 B 的签名失败模式是「**恒空且无人察觉**」——上线后什么都没看到，而「什么都没看到」**正是期望值**（≤1 条 / 30 天）。**任何开关或观察期都区分不了「在工作」和「已损坏」。**

⇒ 上线前 MUST 在**最终词表**上跑离线回放，**三列对照**。**2026-07-13 生产只读实测（24 词——该次实测时点的词表规模快照）**：① 不带闸（完整词表谓词 = 正向 ∧ 非否定项，不带分数/AI 闸）= **1** · ② 支路 B 真实命中 = **1** · ③ 高分归因 `importance` = **0**。唯一命中：`importance=30` / `is_ai_related=true` / `should_push=false` / 「GPT-5.6 一发布，Claude 终于舍得重置 Fable 5 额度了」。**零噪音**。它 `should_push=false` ⇒ 正是支路 B 要推翻的那个否决；`importance=30` ⇒ 支路 A 永远抓不到它。

**该回放是常设检查，不是一次性门**：**每次改词表【或改采集源集合】后 MUST 重跑**——命中面是**语料**的函数，而本变更自己就在改语料（`sitemap` 进 `REALTIME_NEWS_SOURCES`）；词表或语料一变，「恒空」的可能性就回来了。（该列**未被 `is_ai_related` 的时间删失影响**，故 ≤1 条/30 天是成立的**上界**。）

**它的【分辨率上限】必须一并登记**：回放能证伪的只有「**整表恒空**」，**证伪不了「除某一个词外全部失效」**——唯一命中样本是由 **`额度`** 一个词命中的 ⇒ **删掉除 `额度` 外的全部 23 个词，回放依然 ① = ② = 1、验收依然全绿**。逐词的召回**不由回放守护**，只能由「改核心词 MUST 对 advisor / P0 两个出口逐一裁决」这条纪律守护。

## D10 回滚

**每个阶段一个独立 commit ⇒ 一个独立 revert 点。** 阶段 B/C 另有 env 级回滚（`ALERT_SCAN_ENABLED=false`，worker 完全跳过告警链）。阶段 A 与阶段 D 的代码修复**不随开关回滚**——cron 判据、cron 值、AI 闸、共享构造器各自独立正确。

支路 B **不加 env 闸**：① 告警链已有 9 个旋钮；② 开关区分不了「在工作」和「已损坏」（D9），加一个只是多一个说服自己的东西。回滚 = revert 阶段 D 的 commit。

## D11 高频车道的两条「必须有界 / 必须有出口」

**这两条不是可登记的风险，是一条高频车道的基本属性。**

**① 判分 MUST 有界。** `scoreUnscoredEvents` 的候选 SELECT **既无 `ORDER BY` 也无 `LIMIT`**（`score-events.ts:242-266`，工作集谓词 `and(isNull(importanceScore), isNull(mergedInto))` 在 `:266`），告警链每轮直接全量送判（`alert-scan.ts:350`）。`concurrency: 1`（`alert-queue.ts:116`）**排除了并发堆积**——但也正因如此，**一轮卡 11.5 小时 = P0 车道死大半天**（`213 × (3×60s + 15s) = 41,535s`），而唯一止血是人去翻 `ALERT_SCAN_ENABLED=false`。

⇒ 给告警侧的判分加**每轮工作预算**：候选 SELECT 加

```sql
ORDER BY first_seen_at DESC NULLS LAST, event_id DESC   LIMIT N + 1   -- +1 仅触顶信号，只处理前 N 条
--                          ^^^^^^^^^^  ^^^^^^^^^^^^ 二者均必需
```

**五条都不可省**：

- **`ORDER BY` 不可省**——只加 `LIMIT` 时 PG 返回**任意** N 行。
- **`NULLS LAST` 不可省**——`ai_news_events.first_seen_at` **可空**（`schema.ts:146` 无 `.notNull()`），而 PG `ORDER BY x DESC` 默认 **NULLS FIRST**（实测 `(1, NULL, 3)` 上 `DESC LIMIT 1` 返回 **NULL**）⇒ **一行 NULL 即恒排第一、每轮吃掉一个名额、永不老化**（工作集无时间剪枝）——与下面「毒事件」是同一个永久饥饿，只是成因换成了「NULL 排序默认值」。仓内他处均已写 `DESC NULLS LAST`（`experience-chain.ts:534`）。**今日是休眠地雷**（生产 `first_seen_at IS NULL` = **0 / 3698**）——修它是因为**失效是静默的**，不是因为它正在爆。
- **「不加 LIMIT、循环内数到 N 就 break」不是等效变体，MUST NOT 用**：它全量无序 SELECT、break 前 N 条，而物理扫描序轮间稳定 ⇒ 排在头部的 N 条**毒事件**（判分恒失败 → 释放 claim → 仍 NULL → 留在工作集 → 下轮又排头部）**每轮吃满预算**，其后健康事件**永久饿死**；判分工作集**无时间剪枝**，毒事件永不老化出局。⇒ 一个声称「绝不丢事件」的契约，在该变体下**能永久丢事件**。
- **🔴 预算的默认值必须是「无界」，不能是 N。** 它是**调用方显式传入**的选项（`{ ...options.judge, maxPerRun: N }`——显式值放 spread 之后恒胜注入体；spread 只复制自有属性，此为前瞻性防御而非现状失效）。写成 `options.maxPerRun ?? N` ⇒ **日报链（不传该选项）一并被截到 N ≤ 3 条/天** ⇒ ① 要闻段枯竭；② 下面「不饥饿」的**唯一依据**（老事件由**无界的日报链**排空）**当场坍塌** ⇒ 老事件永久积压。**且条数 ≤ N 的 fixture 测试全绿、看不见** ⇒ 必须有一条「日报链判 > N 条」的回归钉。
- **N 必须满足 `N × (F + A×L + W) < cron 周期`**（`F=COLLECTOR_FETCH_TIMEOUT_MS=15s`【env】/ `A=JUDGE_MAX_ATTEMPTS=3`【**不是 env**——是 `unify-judge-stage` 把 `value-judge` 的 `DEFAULT_MAX_ATTEMPTS` 提为 `config` 侧导出常量后的那一个】/ `L=LLM_TIMEOUT_MS=60s`【env】/ `W=JUDGE_WRITE_BUDGET_MS=60s`【env】（与 T 公式同口径）⇒ 每条最坏 **255s** ⇒ 15 分钟 cron ⇒ **N ≤ 3**）。反例：N=20（与 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 同量级的「自然」取值）⇒ 单轮 **85 分钟** = 周期的近 6 倍 ⇒ `concurrency:1` 下队列**越积越长** ⇒ **车道仍不可用**。「N 是模块常量、有界即可」**不构成约束**。**口径区分**：预算口径的每条最坏 = `F + A×L + W`（末次尝试成功仍要写分）；「重渲染风暴 11.5h」的每条 = `F + A×L = 195s`（LLM 全挂 = 全部尝试失败 ⇒ 无写分）——两个口径各自正确，MUST NOT 互相替换。

  **🔴 且该不等式必须落进 `env.ts` 的 `superRefine`，不能只写在散文里**：五项里四项是 env（F / L / W / cron 周期）⇒ 生产上调 `LLM_TIMEOUT_MS`（或把 cron 调密）⇒ 约束**静默失效** ⇒ 单轮又超周期 ⇒ 积压 ⇒ **车道回到不可用**，无一处变红。**同一份提案对 `T > F + A×L + W` 已要求 superRefine 启动期强制**（`unify` 的 spec：「**禁止**只写在文档里」）——**对 N 不能是另一套标准**。错误消息须报出五项当前值。

**不饥饿的论证（`DESC` 取序表面上会饿死老事件，故必须论证）**：① 老的未评分事件**过不了告警闸的时效地板**（`alert-scan.ts:249` / `:258`）⇒ 判了也不告警 ⇒ 告警链花预算在它们身上是纯浪费；② 它们由**无界的日报链**在 ≤24h 内排空。⇒ **「日报链 MUST NOT 设界」现在承载两个理由**（一天一次无界是对的 ＋ 它是告警链非饥饿性的唯一依据），**这条依赖必须显式登记**——将来谁顺手给日报链也加个界，积压就永久饿死了。

**触顶事件的落点（否则「复用既有通道」会被实现成新建通道）**：`emit` 挂在 `RunAlertScanOptions`（`alert-scan.ts:126`），**不在** `ScoreEventsOptions`，而截断发生在 `scoreUnscoredEvents` 内部。⇒ 唯一不新建通道的落法：**`ScoreEventsResult` 增 `budgetExhausted` / `candidateCount`，由 `alert-scan.ts` emit**。**MUST NOT 给 `ScoreEventsOptions` 加 `emit`**。

**日报链保持全量**。被挡下的事件 `importance_score` 仍为 NULL ⇒ **留在工作集里，下一轮继续** ⇒ claim / 写 CAS 不变量原样成立、不丢事件（`LIMIT N+1` 天然落在 claim 之前，第 N+1 行不 claim）。**墙钟 deadline 变体不采用** ⇒ 「MUST 释放飞行中 claim」那条子条款随之删除（无飞行中止、无需释放）。

**② 源级失败 MUST 有告警出口。** **现状（`fix-sitemap-published-at` 已归档后基线，git `5c42f19`）**：**日报链已读 `collected.perSource`**——`run-daily-workflow.ts:526` 的消费循环对 `ps.ok=false` 发 `dedupKey='source-health:<source>'` 告警（`fix-sitemap-published-at` 引入）。**缺口只在高频链**：`alert-scan.ts` 不读 `collected.perSource`、不调 `classifySystemFailure`（`alert-scan.ts:334-341`，注释理由「防刷屏」），且 `RunAlertScanOptions` 无 `alert` 注入口。`sitemap.ts` 那句「throw → `perSource.ok=false` → 计入告警」在**日报链上已兑现**，只在**高频链上尚是空头支票**。（`classifySystemFailure` 的入参 `CollectStats` 不含 `perSource`（`circuit-breaker.ts:92`）——但那是「全源 0」系统判据，与源级 `perSource` 消费是两条不同链路，日报链直接读 `perSource`、不经此函数。）

但「不做**全源 0** 的系统告警」（空轮是常态，正确）**不蕴含**「不做**源级**健康告警」——两条判据不同。

**🔴 而告警链【没有 `AlertSink` 的注入口】——不补则上面整段在生产上是空的，且测试恒绿。** `RunAlertScanOptions`（`alert-scan.ts:82-127`，首字段 `now`）的字段含 `log` / `emit` / `judge` / `collect` / `publishedAtInfer` / `publishedAtLock` / `threshold` / `windowDays` / `maxPerScan` / `dbh` / `channels` / `senders` / `lock` / `digest`——**没有 `alert`**（日报链的 `RunDailyWorkflowOptions` 在 `run-daily-workflow.ts:203` 有）；`createAlertScanWorker({connection, concurrency})`（`alert-queue.ts:97`）**也没有透传口**，`worker-main.ts:160` 只传 `connection`（透传口**无需补**——注入点在 run(ctx)，不在 worker 工厂）。⇒ 必须 ① `RunAlertScanOptions` 增 `alert?: AlertSink`；② **`alert-scan.ts` 的 `run(ctx)` 包装（`:524`）真的注入 `buildOpsAlertSink(...)`**（与日报链生产入口同型——`run-daily-workflow.ts:1179`；用 `buildOpsAlertSink` 而非裸 `createOpsAlertSink`：后者需预构造 senders）；③ **一条「未注入即 stderr」的显式回归断言**。

**③ 不是可选的**：源级告警的单测**自己注入 sink** ⇒ **无论生产接没接线，那些用例都恒绿**，而生产回落 `console.error` ⇒ 高频链的源级告警**静默**。一个只能被「测试自己传进来的东西」满足的契约，对生产零保证——**这与本设计通篇指认的「恒绿的守卫等于没有守卫」是同一个失效**。

⇒ **两条链都消费 `perSource`**（日报链已在，高频链本变更补齐），对 `ok=false` 出源级健康告警，经 `fix-sitemap-published-at` 新建的 **`createOpsAlertSink`** 落真实通道，`dedupKey='source-health:<source>'`。**限频住在 `UNIQUE(target_type, target_id, channel, push_date)` 里，判据 = 仅 `status='success'` 行算今日已告过**（`ON CONFLICT DO UPDATE … WHERE status <> 'success'`，权威见 platform-foundation；失败置 `failed` 不占名额、可重试）⇒ **零新状态、跨进程、跨重启、跨两条链共用判据**（首个 success 轮后其余轮跳过）；**MUST NOT 用 Redis 键或进程内 Map**——后者 redeploy 即复位 ⇒「连续 N 轮」永不达标 ⇒ **静默不告警，比刷屏更糟**。**日报链那一份已在，MUST NOT 因高频链补齐而被删**：整条车道的回滚路径是 `ALERT_SCAN_ENABLED=false`，只留高频链 ⇒ 一回滚**唯一的告警出口随之消失**；共用 `dedupKey` ⇒ 两条链自动互相去重、不双响。

**缺口的准确表述是【高频链无告警消费者】（日报链已有）**——`runRegistry` 已 `logError`（`collectors/index.ts:229-231`），高频链缺的是**出口**，不是记录；往反方向夸大成「两条链都没有」，与「恒绿的守卫等于没有守卫」是同一种失真。

## Risks / Trade-offs

| 风险 | 处置 |
|---|---|
| **告警链无熔断阶段**（`alert-scan.ts` 无 `stageShouldAbort`）——LLM 全挂 + 站点重渲染 213 篇时，单轮最坏 `213 × (3×60s + 15s) = 41,535s` ≈ **11.5 小时** = **P0 车道死大半天**。**并发堆积不成立**（`alert-queue.ts:116` 是 `concurrency: 1`，后续 cron 只排队）——**MUST NOT 把「数十轮并发跑」写成风险**；真实风险是**单轮长时阻塞 = 车道整段不可用** | **不加 `stageShouldAbort` 熔断，但判分 MUST 有界**（D11）：候选 SELECT 加 `ORDER BY first_seen_at DESC NULLS LAST, event_id DESC LIMIT N+1`（处理前 N 条），**N ≤ 3**（`N × 255s < 15min`）。触顶由 `alert-scan.ts` emit（`ScoreEventsResult` 加 `budgetExhausted`）、余量下轮续判。**`ALERT_SCAN_ENABLED=false` 是事后止血，MUST NOT 作为唯一的运行时保护**（预算只封判分段；回填段最坏 3600s 由「回填池近乎空」结构承载，登记于 realtime-alerts） |
| **sitemap 的「静默归零」护栏【高频链无告警消费者】**：`source-collectors` 的 MUST 是「2xx 但 `loc_count=0` → throw → `perSource.ok=false` → 计入告警」。**日报链已消费 `perSource`**（`run-daily-workflow.ts:526`，fix-sitemap 引入，生产经 `run(ctx)` 注入 `buildOpsAlertSink`）；缺的只是**高频链**——`alert-scan.ts` 不读 `perSource`、无 `AlertSink` 注入口。⇒ 站点改版把 sitemap 打成 0 loc 时，**高频链**会静默丢该源最长 24h，而 ≤20min 采集延迟正是本阶段唯一收益 | **修，不登记**（阶段 C）：**高频链补 `perSource` 消费**（日报链已有），做**源级健康告警**，经 `createOpsAlertSink` 落真实通道、`dedupKey='source-health:<source>'`、**限频由 DB 唯一约束承载**（非 Redis / 非进程内 Map）。**日报链那一份已在、MUST NOT 删**——回滚 = `ALERT_SCAN_ENABLED=false`，只留高频链则一回滚出口即消失。**不套用日报的「全源 0」系统告警** |
| **漏召是支路 B 的主要残余风险**（不是误报）——未命中词表的事件不产生任何可观测记录，「真实变更被漏推」在本口径下**恒不可见** | 如实登记；只能靠人工发现「某条该推的没推」或离线全量回放暴露。系统 MUST NOT 声称可观测能迭代出漏词 |
| **已知过宽词**（**两侧都要登记**）：`quota` ⊂ `quotation`、`额度`（算力/授信额度）、`价格`（显卡/算力价格）在 **`PRECISE_FACT_CORE`** 里 ⇒ **`/advisor` 也消费它们**；`sunset` 只在 P0 扩展里 | P0 侧假阳 = **一次手机震动**；**advisor 侧假阳 = 无兜底拒答（更贵的那一侧）**。逐词登记 + 进上线核验清单（见 `conversational-rag` 的过宽词表——**advisor 侧一栏不得省略**） |
| **支路 B 可能挤占同轮的支路 A**（共享 `ORDER BY published_at DESC LIMIT ALERT_MAX_PER_SCAN` 池） | 本期接受、不设分支配额。被挤出者保留候选资格，下一轮由 Model B 的「未 success 投递」窗口自动补（延迟一个 cron 周期）。**MUST NOT 声称「重大发布不被挤出本轮」** |
| **X/Twitter 采集缺口**：招牌用例「周用量上限提升 50%」实际首发于官方 X 账号，**不在任何现有源上** | 显式列为非目标。**本变更 MUST NOT 声称能抓到该类公告** |
| `ai_news_events` 的 source 全集 == `REALTIME_NEWS_SOURCES` 是两处手工字面量的巧合，**不是被守护的不变量** | 本期因此不加 source 谓词（筛 0 行）。等式一旦被打破，新源条目会**直接拿到支路 B 的 P0 资格**——规范里显式声明「加 source 谓词是正当补救，本条不得被引用来阻拦它」 |
| **量级判据的 SQL 是「会告警」的【上界】，不是闸的逐字复刻** | SQL 的时效闸是**逐行相对**窗口（`published_at >= first_seen_at - 3 days`），代码里的真闸是**墙钟**窗口（`startOfDayInTimeZone`）；SQL 还省略了 Model B 反连接与基线水位。**必须注明**，不得当成精确预测 |

## Open Questions

- 支路 A 的 **3.67 条/天**来自 **n=3 个干净日**（07-11 = 4 / 07-12 = 4 / 07-13 = 3）。日间波动**窄**：极差 **[3, 4]**，约 **1.3×** ⇒ 量级判据（≈ **26 条 / 7 天**）**有功效**，能区分信号与噪音。（**此前登记的「日方差 3.5 倍」是错的、已删**：它来自已被排除出均值的回填日 07-10——一天不能既被剔出均值、又用来算方差。）观察窗满 7 天后以真实数据复核。
