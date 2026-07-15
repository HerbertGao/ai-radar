# 设计：统一判分路径（补全折进判分入口）

## 上下文

`scoreUnscoredEvents` 是**共享判分入口**（日报链 + 实时告警链），而 `enrichCandidateContent` 是**只在日报链编排**的独立阶段。二者工作集同键（`importance_score IS NULL ∧ merged_into IS NULL`），补全集是判分集的真子集。评分一生一次 ⇒ **谁先判分，谁就把事件从两个集合里同时永久移走**。

## D1：为什么是「组合」而不是「编排」或「加锁」

三条路，只有一条活着。

| 路 | 做法 | 为什么死 |
|---|---|---|
| **编排式插入** | 在 `alert-scan.ts` 里也调一次 `enrichCandidateContent` | 规则仍是隐式散文（「凡调判分者须先调补全」）。第三个调用方（MR 事件车道 / 回放脚本 / 补评分运维脚本）照样漏。且并发下不成立：链 A 的补全批与链 B 的判分**无 happens-before**。 |
| **锁结构化** | 扩 `judge_claimed_at` 为「补全感知锁」 | 它是**互斥量**不是 **happens-before**。claim 条件 `importance_score IS NULL` 在【正在补全】期间恒为真——A 抓 og 时 B 可合法 claim 并 title-only 评掉。扩成状态机需新列 + 迁移；且补全是 best-effort，fail-closed 卡住会让事件**永不评分**（比现状更糟）。 |
| **组合（选它）** | 补全 = 判分入口内的第一步 | 「先补全再评分」从散文规则变成**单一函数内的语句顺序**。工作集的拥有者同时拥有它的前置。任何调用方**不可能漏**。 |

## D2：补全落在 claim 之后（而非 claim 之前的批量阶段）

两种折法：

- **(a) 批量前置**：`scoreUnscoredEvents` 开头调一次批量 `enrichCandidateContent`（保留其自带的工作集 SELECT），再进 claim 循环。
- **(b) 逐条内联（选它）**：每条事件 **claim 成功之后**、送 LLM 之前补全该条。

选 (b)：

1. **删掉一整份重复查询**。补全的工作集 SELECT 与判分的候选 SELECT 是**同一个键的两次独立表达**——主规范为此写了整段「补全工作集必须精确等于判分工作集」的不变量来防漂移。(b) 之后只剩一个 SELECT（判分的候选 SELECT 已 left join `raw_items`，只需扩取 `id`/`canonical_url`/`url`），**这条不变量连同它要防的漂移一起消失**。(a) 保留两份查询，也就保留那条不变量与它的漂移风险。
2. **消除并发重复抓取**。(a) 下两条链的批量补全阶段会对同一批未评分事件**各抓一遍**（写回原子判空，故无正确性问题，但是纯浪费的 HTTP）。(b) 下只有 claim 到该事件的那条链会抓它。
3. 总墙钟时间不变：日报链今天就是「N 次抓取，然后 N 次 LLM」，(b) 是「N 次（抓取 + LLM）」。

**代价（(b) 独有，MUST 登记）**：抓取落进 claim 窗口 ⇒ 一个被 claim 的事件停留在「`importance_score IS NULL` 且 `judge_claimed_at` 已写」的最坏时长由 `A×L + W` 变为 `F + A×L + W`。见 D3——那里连带修掉一个**改动前就已存在**的错误下界。

## D3：僵尸回收阈值 `T` —— 公式今天就是错的，且代码不配它

### D3.1 先把事实摆出来（逐条 file:line 核过）

```
content-enrichment.ts:209  for (hop = 0; hop <= maxRedirects; hop++)         ← maxRedirects=5 ⇒ 【6 跳】
content-enrichment.ts:215    AbortSignal.timeout(COLLECTOR_FETCH_TIMEOUT_MS) ← 【每跳各建一个新 signal】
content-enrichment.ts:211    assertHostAllowed → dns.lookup                  ← 【不受任何 signal 约束】

value-judge/index.ts:66    DEFAULT_MAX_ATTEMPTS = 3
value-judge/index.ts:103   for (attempt = 1; attempt <= maxAttempts; attempt++)  ← 重试【整个 LLM 调用】
llm-client.ts:65             AbortSignal.timeout(LLM_TIMEOUT_MS)                 ← 【每次尝试各建一个】

真实最坏 claim 窗口 = 6×15s（抓取）+ 3×60s（LLM）+ 60s（写分） = 330,000ms
默认 JUDGE_CLAIM_RECLAIM_MS                                      = 180,000ms   ← 不满足
```

**且这不是本变更引入的**：现存 superRefine（`env.ts:622-632`）校验的 `T > L + W = 120000`，而改动前的真实最坏就已是 `3L + W = 240000 > T = 180000`。它今天只是**潜伏**——`ALERT_SCAN_ENABLED=false`，只有一条判分链，**没有第二个回收者**去误回收。`p0-alert-lane` 开的正是第二条链。

**误回收的后果不是「多花一次 LLM」**：`score-events.ts:234-246` 的评分写 CAS 只有 `merged_into IS NULL`、**没有 `importance_score IS NULL`** ⇒ 误回收 = **后写者覆写先写者** ⇒ 直接证伪规范自己写的「一事件只评一次分、永不覆写」。

### D3.2 三件一起做（缺一件公式仍是假的）

**① 让代码去配公式**（而不是把公式写成代码的样子）。`F` 要真的是「一次补全的上限」，`AbortSignal` 就必须**整次一条**，而不是每跳一条：

```ts
const signal = AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS);   // 循环外，只建一次
const deadline = Date.now() + env.COLLECTOR_FETCH_TIMEOUT_MS;
for (let hop = 0; hop <= maxRedirects; hop++) {
  if (Date.now() > deadline) throw new Error('补全总超时');            // 兜住不受 signal 约束的 DNS
  await assertHostAllowed(current, resolve);
  const res = await fetchImpl(current, { ..., signal });
}
```

这同时**收紧**了今天的 6F 上限（重定向链再长也只花一个 `F`），不新增旋钮。

> **已登记的残余天花板**：`deadline` 比对发生在 `assertHostAllowed` **之前**，故一次已经开始的 `dns.lookup` 挂起仍不被 `AbortSignal` 打断（libuv 线程池调用，只受系统 resolver 的 attempts/timeout 约束）。它把「跨跳累积」这一可无限增长的部分封死了，剩下的是**单次 getaddrinfo** 的系统级上限。根除需自定义 dispatcher / pin 到已解析 IP——与 SSRF 守卫的 TOCTOU 残窗是同一笔账，一起还。**这也正是 ③ 存在的理由：时间不变量不能是唯一的防线。**

**② `L` 按 `A × L` 记账**。判分重试的是**整个调用**，每次尝试各自一个 `AbortSignal.timeout(L)`：

```
T > F + A×L + W
  F = COLLECTOR_FETCH_TIMEOUT_MS   （一次补全的硬超时，含全部跳转与 DNS——由 ① 保证）
  A = JUDGE_MAX_ATTEMPTS           （判分最大尝试次数，默认 3）
  L = LLM_TIMEOUT_MS               （单次 LLM 尝试的硬超时）
  W = JUDGE_WRITE_BUDGET_MS        （LLM 返回后写 *_score / 事务提交的延迟上界）

  = 15000 + 3×60000 + 60000 = 255,000
```

⇒ **默认 `JUDGE_CLAIM_RECLAIM_MS` 必须从 `180000` 上调到 `300000`**（留 45s 余量）。不上调则容器启动期 fail-fast——**那是期望行为**，因为 `180000` 本来就是个会误回收的配置。

`A` 与 `L` **从模块常量 import 进 superRefine**，禁止抄字面量副本（两份必然漂移：改了重试次数、忘了改阈值）。仓内已有正确范式——`published-at-inference/backfill.ts:142-144`：

```ts
const inferMaxAttempts = options.infer?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
const inferLockTtlMs = env.LLM_TIMEOUT_MS * inferMaxAttempts + INFER_CAS_WRITE_SLACK_MS;
```

**常量放哪**：`JUDGE_MAX_ATTEMPTS` 定义并导出在 `config/env.ts`（superRefine 就在那个文件里用它），`value-judge/index.ts` 把它作为 `maxAttempts` 的默认值 import 回去。方向 `agents → config` 与既有 `llm-client → env` 同向，**无环**；反过来（env import agents）会把整个 AI SDK 拖进 env 的模块图，且成环。

> 判分侧仍可经 `JudgeOptions.maxAttempts` 逐调用覆盖 `A`（仅测试在用）。**若某调用方把它调到大于 `JUDGE_MAX_ATTEMPTS`，本下界即失效**——这条已登记：生产调用方（`score-events.ts`）不传该项。

**③ 评分写 CAS 加 `importance_score IS NULL` 守卫**（`score-events.ts:234-246`，与既有 `merged_into IS NULL` 并列）。

理由与 TTL 算得对不对**无关**：时间不变量的成立依赖「所有超时都真的被 `AbortSignal` 兜住」，而 DNS 解析（见 ① 的残余）、进程长 STW 暂停、容器被冻结/迁移**都能越过它**。CAS 是**结构**保证，时间阈值是**概率**保证——「永不覆写」这种承诺**必须**落在结构上。误回收真发生时，后写者命中 0 行、走既有 0 行路径（不计 scored、不稀释熔断分母），先写者的分数不被覆写。

**为何不给补全单独设一个更紧的超时**：`COLLECTOR_FETCH_TIMEOUT_MS` 已是抓取硬上限（补全模块本就用它），再引一个只服务本变更的旋钮属 YAGNI。

## D3b：空判定必须是 SQL 投影列，不是 TS `trim()`

主规范有一条 MUST：「空或纯空白 MUST 用**同一个 SQL 谓词**在候选载入与原子写回两处一致判定，**禁止**一处 JS `String.trim()`、一处 Postgres 谓词」。

而判分入口的候选 SELECT **不能**把 `EMPTY_CONTENT` 放进 `WHERE`——它要判**所有**未评分事件，不只空正文的那些。天真的写法是循环内用 `!event.content?.trim()` 判空，**那正是这条 MUST 禁止的分叉**，只是换了个位置：

| `content` | TS `trim()` | SQL `!~ '\S'` | 净效果 |
|---|---|---|---|
| `' '`（NBSP `U+00A0`）/ `　`（U+3000）/ `﻿`（BOM） | 判为空 → **发 HTTP 抓取** | 为**假**（不在 POSIX `[:space:]`） | 白抓一次 + 写回**命中 0 行** + 打出**撒谎的**「已被并发填充，跳过」日志 |

**唯一结构性可行的修法：把空谓词作为【投影列】一起 SELECT 出来。**

```ts
.select({
  ...,
  isEmpty: sql<boolean>`(${rawItems.content} IS NULL OR ${rawItems.content} !~ '\\S')`,
})
```

循环内用 `row.isEmpty` 决定是否补全。选取与写回自此复用**同一侧、同一个**谓词——分叉在结构上不可能出现，那条 MUST 不再需要靠人记住。

## D3c：补全必须把正文【返回】，只写库等于没做

`scoreUnscoredEvents` 是**先把 `content` SELECT 进内存**、再送 LLM 的。补全的 `UPDATE raw_items SET content=...` **不会**改写内存里那个 `event.content`。

⇒ 若单条补全函数只返回 `'hit' | 'fail'`（原 tasks 的签名），调用侧沿用 SELECT 时读到的旧空值 ⇒ **DB 被补全了，而这一次判分仍是 title-only**。评分**一生一次**，这条事件**再无第二次机会**——本变更的全部目的落空，而 DB 里那行补全好的正文**看起来一切正常**。

故：补全函数返回 `{ status, content }`（或 `string | null`），调用侧**显式**把它传给 `judgeRawItem`。

**测试口径同样是结构性的**：只断言「`raw_items.content` 被写入」的测试在缺陷存在时**同样为绿**，对本条毫无证伪力。**必须断言 `judgeRawItem` 收到的 `content` 入参**等于补全后的正文。

## D4：模块归属与依赖边

`enrichCandidateContent` 在 `src/pipeline/content-enrichment.ts`，`scoreUnscoredEvents` 在 `src/agents/value-judge/score-events.ts`。折进去意味着 `agents/value-judge` → `pipeline/content-enrichment` 的 import。

- `content-enrichment.ts` 的现有 import 为 `node:dns` / `node:net` / drizzle / `db` / `schema` / `env` / `collectors/sitemap`（`extractOgTag`、`MAX_BODY_BYTES`）——**零 `src/agents` 依赖**。故不构成文件级环。
- `pipeline → agents` 的边今天已存在（`run-daily-workflow.ts` / `alert-scan.ts` 都 import `scoreUnscoredEvents`）。新增的 `agents → pipeline` 是**目录粒度**的反向边，但落在一个对 `agents/` 无依赖的叶子模块上。

**接受该边，不为它搬文件**：把 `content-enrichment.ts` 迁进 `agents/` 会让一个「确定性 HTTP 抓取 + DB 写回、零 LLM」的模块住进 Agent 层，语义更错；新造一个 `src/enrichment/` 层只为消一条无害的 import 边，是为洁癖付整层的钱。若日后真出现环，再搬。

## D5：显式接受的两条行为变化（P0 开闸后生效）

> 今天 `ALERT_SCAN_ENABLED=false`，日报链是唯一调用方，链序与今日逐字等价 ⇒ **本变更上线当天零行为变化**。下面两条在第二条判分链存在时才生效，但**必须现在就接受**，不能让它们从阶段重排里泄漏出来。

### D5.1 语义合并的灰区判输入由「仅标题」变为「标题 + Content」

主规范 `daily-intel-pipeline`「日报链在 Value Judge 之前运行正文补全阶段」今天断言：

> 补全放在合并之后只富化**存活代表事件**、不对随即被 tombstone 的事件浪费抓取。故语义合并的合并判**仍仅标题**，是已知且接受的取舍。

日报链内的**链序不变**（语义合并 2.5 仍在判分之前，补全仍是判分的第一步 ⇒ 仍在语义合并之后）。**变的是链外**：告警链每 15–20 分钟补全一批事件并写回 `raw_items.content`；等次日 08:0x 日报链跑语义合并时，这些事件**已带正文**。`semantic-judge.ts:89,91` 的灰区 prompt 由 `if (input.contentA) parts.push('Content: …')` 拼装 ⇒ 输入实质变化。

**方向不明**：正文让真同事件更容易被判同（好），也让不同事件因共享样板/模板正文更容易被判同（坏——`fix-sitemap-published-at` 正在闭合的就是这个洞的一个实例）。**生产的语义去重阈值当前处于「暂缓调整、收集数据」状态**，故：

- 本变更**不动**任何阈值与合并逻辑（非目标）；
- 本变更**不开** `ALERT_SCAN_ENABLED`，故该变化不随它上线；
- **开闸变更 = `p0-alert-lane`（本仓开 `ALERT_SCAN_ENABLED` 的那一个），它 MUST 把「灰区判输入含正文后的误并率」列入其阶段 B 观察项，并给出可执行的 DB 复算 SQL**（观察窗内 `merged_into IS NOT NULL` 占比 vs 开闸前基线）——不得由那份提案默认「语义合并输入未变」，也不得只写一句散文了事。

### D5.2 「不对将被 tombstone 的事件白抓」的取序理由失效

告警链的补全先于日报链的语义合并 ⇒ 可能为随后被合并成 tombstone 的事件白抓一次 HTTP。**代价有界**：每事件至多一次（补全成功即写回非空 `content`，该事件离开 `EMPTY_CONTENT` 域；失败则事件被判分后离开判分域），best-effort，不入熔断分母。接受，不为它加「先看会不会被合并」的前置查询（那要么是猜测，要么是把语义合并也拖进判分入口）。

## D6：可观测

补全的命中/失败计数今天由日报链的阶段 2.6 日志输出。折进判分入口后，计数须随 `ScoreEventsResult` 一并返回并由**各调用链**自己的日志输出（日报链与告警链都要看得见），而非只挂在 `runDailyWorkflow()` 上。「命中全站样板数」（`fix-sitemap-published-at` 引入）随之一并上移。

## 待解决

- 无。（判分工作集**无 source 闸、无 LIMIT** 是一条今天就存在的性质：站点批量重渲染那天，日报链自己就会拉满 per-article fetch + 判分。本变更不改它，亦不使之更坏——补全的抓取量与今天逐条相同，只是换了个函数发起。若日后要给判分工作集加 LIMIT，那是独立变更。）
