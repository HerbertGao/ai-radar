## Why

**正文补全与判分是两个独立编排的阶段，而它们的工作集是同一个键的子集关系。任何第二条判分链都会让补全永久空转。**

```
score-events.ts:196            判分工作集 = importance_score IS NULL ∧ merged_into IS NULL   ← 无 source 闸、无 LIMIT
content-enrichment.ts:263-278  补全工作集 = 判分工作集 ∧ EMPTY_CONTENT ∧ (canonical_url ∨ url)
                                            ↑ 判分工作集的【真子集】，同键于 importance_score IS NULL
```

评分是**一生一次**（`importance_score` 一旦非 NULL 即永久离开工作集）。故一个事件被判分的那一刻，它**同时永久离开两个工作集**。

`scoreUnscoredEvents` 今天已有**两个**调用方：日报链（`run-daily-workflow.ts:627`）与实时告警链（`alert-scan.ts:350`，`ALERT_SCAN_ENABLED` 门控、当前关）。告警链每 15–20 分钟跑一轮判分，**但不跑补全**（`alert-scan.ts:423-426` 的 `ponytail:` 注释明写「高频告警链不跑 og:description enrichment（保持精简车道）」）。

⇒ 一旦该门开启，等日报链 08:0x 跑到阶段 2.6 时，补全工作集**已被告警链清空**。`source-content-enrichment` 整个能力沦为死代码，而所有空正文事件被 title-only 判分。

**量级不在 sitemap，在 Hacker News**：`hacker-news.ts:73` 的 `content: item.text ?? null` 使 **HN 直链帖 `content` 恒 NULL**——30 天 838 个 `hacker_news` 事件（≈28/天）。这才是补全的招牌用例；sitemap 的 25 条小两个数量级。

### 为什么不能靠 `judge_claimed_at` 锁结构化

`score-events.ts:115-126` 的原子 claim 是**互斥量**（谁评分），不是 **happens-before**（先补全再评分）。其 claim 条件 `importance_score IS NULL` 在【正在补全】期间**恒为真**——链 A 正在为事件 E 抓 `og:description` 时，链 B 完全可以合法 claim 并 title-only 评掉 E。

把它扩成「补全感知锁」需要新列 + 迁移 + 状态机；而补全是 **best-effort**（og 缺失即失败），fail-closed 地卡住未补全事件会让它**永不评分、永不推送**——比现状更糟。**这条路是死的。**

### 唯一的结构化手段是【组合】

**让工作集的拥有者同时拥有它的前置**：把补全折进判分入口本身，使「先补全再评分」不再是一条散文规则、而是**单一函数内的语句顺序**。

- 对日报链**行为等价**（今天就是 补全 → 判分，中间无第三个消费者）；
- 对告警链**自动正确**（无需在 `alert-scan.ts` 里抄第二份编排）；
- 对未来第三个调用方（MR 事件车道、回放脚本、补评分运维脚本）**不可能漏**。

编排式插入（在 `alert-scan.ts` 里再调一次 `enrichCandidateContent`）只是把散文规则抄成第二份编排代码——规则仍是隐式的，第三个调用方照样漏，且并发下不成立（见上）。

## What Changes

- **补全折进判分入口**：`scoreUnscoredEvents` 的候选 SELECT 已 left join `raw_items`（取 `content`/`source`），**扩取** `rawItems.id` / `canonical_url` / `url` 与空判定**投影列** `isEmpty`（`content IS NULL OR content !~ '\S'`，与写回侧同一个 SQL 谓词——候选 SELECT 要判**所有**未评分事件，不能把空判定放进 `WHERE`，故只能作投影列；**禁止**在选取侧退回 JS `trim()`，否则 NBSP 类内容会「白抓一次、写回 0 行、还打出一条与事实相反的日志」）；每条事件**原子 claim 成功之后、送 LLM 之前**，若 `isEmpty` 且有可抓 URL，先执行一次单条正文补全，**并以补全函数【返回】的正文**（而非 SELECT 时读到的旧空值）判分——补全只写库不回传的话，DB 补全了、这一次判分仍是 title-only，而评分**一生一次**、没有下一次。
- **`content-enrichment.ts` 的批量工作集查询被删除**：`enrichCandidateContent`（自带一份与判分集同口径的 SELECT）降为**单条**补全函数（受控抓取 + SSRF 守卫 + 原子判空写回，逻辑逐条保留）。「两个查询必须同口径」这条不变量**连同它要防的漂移一起消失**——现在只有一个查询。
- **日报链删掉阶段 2.6** 的独立编排（含其防御性 try/catch）：`run-daily-workflow.ts:601-625`。
- **告警链无改动**：它调用同一个 `scoreUnscoredEvents`，自动获得补全。
- **僵尸回收阈值 `T` 的下界修正 + 让代码去配它**：补全落在 claim 之后，claim 窗口由「LLM + 写分」变为「抓取 + LLM + 写分」。但**现存的 superRefine（`env.ts:622-632`，`T > L + W`）今天就已经是错的**：判分重试的是**整个 LLM 调用**（`value-judge/index.ts:103`，`DEFAULT_MAX_ATTEMPTS=3`），**每次尝试各自**一个 `AbortSignal.timeout(LLM_TIMEOUT_MS)`（`llm-client.ts:65`）⇒ 改动前的真实最坏就是 `3L + W = 240000 > T = 180000`。它只是**潜伏**（`ALERT_SCAN_ENABLED=false`，只有一条判分链、没有第二个回收者），而本变更的下一环 `p0-alert-lane` 开的正是第二条链。故本变更**三件一起做**：
  1. **`fetchArticleGuarded` 的超时提到跳转循环外**（`content-enrichment.ts:209-216`：今天**每跳各建一个** `AbortSignal.timeout(F)`，`maxRedirects=5` ⇒ 6 跳 ⇒ 真实上限 **6F**；且 `assertHostAllowed` 的 `dns.lookup` **不受 signal 约束**）。改为**整次补全一条 deadline**（循环外建一次 signal + 每跳发起前比对 deadline）⇒ `F` 才**真的**等于 `COLLECTOR_FETCH_TIMEOUT_MS`。
  2. **superRefine 改为 `T > F + A×L + W`**（`A` = 判分最大尝试次数）= `15000 + 3×60000 + 60000` = **255,000** ⇒ **`JUDGE_CLAIM_RECLAIM_MS` 默认值必须从 `180000` 上调到 `300000`**（`.env.example` 同步）。`A` 与 `L` **从模块常量 import**，不抄字面量。仓内已有正确范式：`published-at-inference/backfill.ts:142-144` 就是 `LLM_TIMEOUT_MS × maxAttempts + slack`。
  3. **评分写 CAS 加 `importance_score IS NULL` 守卫**（`score-events.ts:234-246` 今天只有 `merged_into IS NULL`）——时间不变量依赖「所有超时都真被 signal 兜住」（DNS、STW 暂停、容器冻结都能越过），**「永不覆写」不能只靠算得准的阈值**。这是最后一道结构保证。

**今天零行为变化**：`ALERT_SCAN_ENABLED=false`，日报链是唯一调用方，其链序本就是「补全 → 判分」、中间无第三个消费者。（`JUDGE_CLAIM_RECLAIM_MS` 默认值上调是**修一个既有 bug**，不是本变更引入的行为变化。）

## Capabilities

### Modified Capabilities

- `source-content-enrichment`: 「判分与摘要前的确定性正文补全」——补全从「日报链内的独立阶段」改为「**判分入口内、原子 claim 之后、送 LLM 之前**的第一步」。「补全工作集必须精确等于判分工作集」由**两个查询的同口径约定**升格为**单一查询的结构事实**。作用域由「日报链」扩为「**任何判分调用链**」。
- `value-judge-agent`: 「判分输入须以正文与来源 grounding」——「凡被判事件皆先补全（除非补全失败）」这条**普遍约束**不再靠工作集口径对齐来兑现，而由「补全是判分入口的第一步」这一**组合关系**结构化保证；`scoreUnscoredEvents` 的每一个调用方自动满足它。
- `daily-intel-pipeline`: ①「日报链在 Value Judge 之前运行正文补全阶段」——补全不再是 `runDailyWorkflow()` 的独立阶段（删阶段 2.6）；并**显式登记**：原「补全放在语义合并之后、以免为将被 tombstone 的事件白抓」的取序理由**失效**，且「语义合并的合并判**仍仅标题**」这条断言在第二条判分链存在时**不再成立**。②「降级逐条容错与降级率熔断」——claim 回收阈值由 `T > L + W`（一条**改动前就已不成立**的假不变量：漏乘判分重试次数 `A`）修正为 **`T > F + A×L + W`**（默认下界 255,000 ⇒ `JUDGE_CLAIM_RECLAIM_MS` 默认值 `180000 → 300000`），并新增 MUST：**评分写 CAS 须自带 `importance_score IS NULL` 守卫**——「永不覆写」是**结构**保证，不能只靠算得准的时间阈值。

## 非目标(Non-Goals)

- **不开 P0 车道**：`ALERT_SCAN_ENABLED` 保持 `false`。本变更是开闸的**硬前置**，不是开闸本身。
- **不改语义去重的阈值与算法**：生产的语义去重阈值当前处于「暂缓调整、收集数据」状态。本变更**只登记**其灰区判输入将发生的变化（见 Impact），**不动** `SEMANTIC_DEDUP_HIGH` / `SEMANTIC_DEDUP_LLM` / 合并逻辑。
- **不改补全的抓取实现**：SSRF 出网守卫、`og:description`-only（不做全文抽取）、不引 HTML 解析库/无头浏览器、`MAX_BODY_BYTES` / `content-type` / 超时校验——逐条保留。
- **不给告警链加 `is_ai_related` 闸门**，不改告警推送候选查询。
- **不给判分工作集加 source 闸或 LIMIT**（它今天两者都无；这是一条已登记的性质，改它属另一变更）。
- **不动推送幂等、去重分层、时效窗口、熔断分母口径**（分母仍只含 Value Judge 与中文摘要两阶段）。
- **不抽新的编排层函数暴露给链路**：不新增「链路只准调它」这类靠**约定**维持的入口——本变更的全部价值在于把约定换成结构。

## Impact

- **代码**：
  - `src/agents/value-judge/score-events.ts`：候选 SELECT 扩取 raw_item 的 `id`/`canonical_url`/`url` 与 `isEmpty` 投影列；claim 成功后、送 LLM 前内联单条补全，并以其**返回值**作判分输入；**评分写 CAS 加 `importance_score IS NULL` 守卫**。
  - `src/pipeline/content-enrichment.ts`：`enrichCandidateContent`（批量 + 自带工作集 SELECT）降为单条补全函数、**返回补全后的正文**；删除重复的工作集查询；`fetchArticleGuarded` 的 `AbortSignal` 提到跳转循环外（整次一条 deadline，兜住无超时的 DNS）。
  - `src/pipeline/run-daily-workflow.ts`：删除阶段 2.6（`enrichCandidateContent` 调用 + 防御性 try/catch + 日志）。
  - `src/agents/value-judge/index.ts`：`DEFAULT_MAX_ATTEMPTS` 改为从 `config/env.ts` 导出的 `JUDGE_MAX_ATTEMPTS` 取（**单一定义**，供 superRefine 与判分共用；方向为 `agents → config`，与既有 `llm-client → env` 同向，无环）。
  - `src/config/env.ts`：claim 回收阈值 superRefine 由 `T > L + W` 改为 `T > F + JUDGE_MAX_ATTEMPTS × L + W`；`JUDGE_CLAIM_RECLAIM_MS` 默认值 `180000 → 300000`。
  - `src/pipeline/alert-scan.ts`：**无改动**（自动获得补全；`:423-426` 那条「高频告警链不跑 enrichment」的 `ponytail:` 注释须删除——它已不再成立）。
- **迁移**：无。
- **配置（默认值必须改，与原提案相反）**：新下界 = `15000 + 3×60000 + 60000` = **255,000**，而 `JUDGE_CLAIM_RECLAIM_MS` 现默认 `180000` **不满足**（原提案「默认值无需改，`180000 > 135000`」是按错误公式算的）。故默认值 **`180000 → 300000`**，`.env.example:188` 同步。生产若显式覆盖过 `JUDGE_CLAIM_RECLAIM_MS` 或调高过 `COLLECTOR_FETCH_TIMEOUT_MS`，部署前 MUST 复核新下界——不满足即容器启动期 fail-fast（**期望行为**：那个配置本来就会误回收）。
- **行为变化（今天：零）**：`ALERT_SCAN_ENABLED=false` 下日报链是唯一调用方，链序与今日逐字等价。
- **行为变化（第二条判分链存在时，MUST 显式接受）**：
  1. **告警链自动获得正文补全**——它每轮判分前会为空正文事件发起 per-article HTTP 抓取（每条上限 `COLLECTOR_FETCH_TIMEOUT_MS`）。这正是本变更的目的（今天它 title-only 判分并把事件永久踢出补全域）。
  2. **语义合并的灰区 LLM 判拿到的 `content` 变了**：`semantic-judge.ts:89,91` 消费 `raw_items.content`。今天，日报链的语义合并（阶段 2.5）跑在补全之前，本轮新事件恒无 `content`；开闸后，事件可能已被告警链补全并写回 `raw_items.content`，故灰区判的输入由「**仅标题**」变为「**标题 + Content**」。**误并率会动、方向不明**（正文让真同事件更易判同，也让不同事件因共享样板/模板正文更易判同）。**生产的语义去重阈值当前处于「暂缓调整、收集数据」状态**，故此条**必须被显式接受，而不是从阶段重排里泄漏出来**。缓解：`ALERT_SCAN_ENABLED` 仍关，该变化不随本变更上线；**开闸变更 = `p0-alert-lane`**，它 MUST 把「灰区判输入含正文后的误并率」列入其观察项并给出可执行的 DB 复算 SQL（这条 MUST 由本变更下达、由 `p0-alert-lane` 承接，见其阶段 B 观察项）。
  3. 原「补全放在语义合并之后，以免为将被 tombstone 的事件白抓」的取序理由失效：告警链的补全先于日报链的语义合并，可能为随后被 tombstone 的事件白抓。**代价有界**（每事件一次 HTTP、best-effort、不入熔断分母），接受。
- **不受影响**：推送幂等四元组、去重分层、Top N 时效闸、熔断分母、KB 准入闸。
