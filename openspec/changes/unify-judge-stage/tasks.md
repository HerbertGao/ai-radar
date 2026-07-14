# 任务：统一判分路径（补全折进判分入口）

## 0. 基线核对（归档前 MUST 重跑，绝不可省）

- [ ] 0.1 **`source-content-enrichment` 的 MODIFIED 块以 `fix-sitemap-published-at` 的 delta 为基线整条复制而来，不是以当时的主规范为基线。**
      理由：`openspec-cn` 的 MODIFIED 是**整条需求替换**，而归档守卫（1.6.0 `specs-apply.js` 的 `findMissingCurrentScenarios`）**只比场景名、不比正文**——`validate --strict` 抓不到正文回滚。若以旧主规范为基线，归档本变更会把 `fix-sitemap-published-at` 的「全站样板 `og:description` 视同缺失 + 共享 `isSiteBoilerplate`」**整段静默回滚掉**。
- [ ] 0.2 **归档本变更之前 MUST 重新以「`fix-sitemap-published-at` 归档后的 `openspec/specs/source-content-enrichment/spec.md`」为基线逐条核对**：
      ```bash
      diff <(sed -n '/^### 需求:判分与摘要前的确定性正文补全$/,/^### 需求:/p' openspec/specs/source-content-enrichment/spec.md) \
           <(sed -n '/^### 需求:判分与摘要前的确定性正文补全$/,$p' openspec/changes/unify-judge-stage/specs/source-content-enrichment/spec.md)
      ```
      逐条确认：主规范里该需求的**每一个场景名**都在本变更的 MODIFIED 块中**逐字存在**（可多、不可少），且 fix-sitemap 引入的样板判定段落**未被丢失**。若 `fix-sitemap-published-at` 在归档前又改动了该需求，**MUST 把改动重新并入本变更的 MODIFIED 块**。
- [ ] 0.3 同法核对 `value-judge-agent` / `daily-intel-pipeline` 的两条 MODIFIED 需求（当前无其他未归档变更触碰它们；归档前仍 MUST 复查一次）。

## 1. 补全降为单条函数（`src/pipeline/content-enrichment.ts`）

- [ ] 1.1 把 `enrichCandidateContent`（批量 + 自带工作集 SELECT）改为**单条**导出函数，签名约
      **`enrichRawItemContent({ rawItemId, target }, dbh, options) => { status: 'hit' | 'fail'; content: string | null }`**：
      受控抓取（SSRF 出网守卫 / `redirect:'manual'` 逐跳 host 重校验 / 2xx / content-type / `MAX_BODY_BYTES` / `COLLECTOR_FETCH_TIMEOUT_MS`）→ `extractOgTag(html, 'og:description')` → **`isSiteBoilerplate` 判样板（来自 fix-sitemap 的共享 helper）→ 命中即按 fail 计、不写回** → 原子判空写回 `UPDATE ... WHERE id=? AND (content IS NULL OR content !~ '\S')`。
      **返回正文绝不可省**（不是只返回 `'hit'|'fail'`）：判分入口是**先把 `content` SELECT 进内存**再送 LLM 的，`UPDATE` **不改**内存里那个值 ⇒ 只写库不回传 = **DB 补全了、这一次判分仍 title-only**，而评分**一生一次**、没有下一次（spec value-judge-agent「补全的正文必须经【返回值】进入本次判分输入」）。
      写回命中 0 行（已被并发填充）时**返回 DB 里那个既有正文**（`RETURNING content` 或回读一次），**不是** `null`——该事件确有正文，判分不该退化仅标题。
- [ ] 1.2 **删除**该模块内那份「与判分集同口径」的工作集 SELECT（`content-enrichment.ts:263-278`）——工作集自此只剩判分入口那一个 SELECT。
- [ ] 1.3 单条失败一律 try/catch 隔离、返回 `{ status: 'fail', content: null }`、**绝不抛出**（含 `SsrfBlockedError`）；`EMPTY_CONTENT` SQL 片段仍为选取（**投影列**，见 2.1）/写回**同一个**常量。
- [ ] 1.4 **`fetchArticleGuarded` 改为「整次补全一条 deadline」（`:202-242`，绝不可省——`F` 的记账靠它成立）**：
      今天 `AbortSignal.timeout(COLLECTOR_FETCH_TIMEOUT_MS)` 建在**跳转循环内**（`:215`，每跳各一个）⇒ `maxRedirects=5` ⇒ 6 跳 ⇒ 一次补全的真实上限是 **6F**，而回收阈值按 `F` 记账。且 `assertHostAllowed` 的 `dns.lookup`（`:211`）**不受 signal 约束**。改为：
      ```ts
      const signal = AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS);   // 循环外，只建一次
      const deadline = Date.now() + env.COLLECTOR_FETCH_TIMEOUT_MS;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (Date.now() > deadline) throw new Error('补全总超时');            // 兜住不受 signal 约束的 DNS
        await assertHostAllowed(current, resolve);
        const res = await fetchImpl(current, { ..., signal });               // 全部跳共用同一个 signal
      }
      ```
      残余天花板（已登记、不在本变更根除）：单次已开始的 `getaddrinfo` 挂起仍不被打断——这正是任务 2.5 的 CAS 守卫存在的理由。

## 2. 补全折进判分入口（`src/agents/value-judge/score-events.ts`）

- [ ] 2.1 候选 SELECT（`:180-194`）在既有 `content` / `source` 的 left join 基础上**扩取** `rawItems.id` / `rawItems.canonicalUrl` / `rawItems.url`，**并加空判定投影列**（同一个 left join，不新增查询）：
      ```ts
      isEmpty: sql<boolean>`(${rawItems.content} IS NULL OR ${rawItems.content} !~ '\\S')`,
      ```
      **为何是投影列而不是 `WHERE`**：候选 SELECT 要判**所有**未评分事件（不只空正文的），空谓词**不能**进 `WHERE`。
      **为何不能在 TS 里 `trim()`**：那是主规范「空定义须单一谓词」明令禁止的分叉——`content = ' '`（NBSP）时 TS 判空 → **白抓一次 HTTP**，而写回侧 SQL `!~ '\S'` 为**假** → **命中 0 行** → 打出**与事实相反**的「已被并发填充，跳过」日志。投影列使选取与写回复用**同一侧、同一个**谓词。
- [ ] 2.2 判分循环内、`claimEventForJudging` 返回 `'claimed'` **之后**、`judgeRawItem` **之前**：若 **`event.isEmpty`**（**不是** `!event.content?.trim()`）且 `rawItemId` 与 `canonicalUrl ?? url` 均非空 → 调 `enrichRawItemContent({ rawItemId, target }, dbh, options.enrich)`（**MUST 透传** `options.enrich`，见 2.6）；**并把它返回的 `content` 显式传给 `judgeRawItem`**（`content: enriched.content ?? event.content`），**禁止**沿用 SELECT 时读到的旧空值。
      **fail-open 绝不可省**：补全失败/跳过时**照常送 LLM 判分**（仅标题输入），**禁止** `continue` 跳过该事件——否则一次抓取失败会让它永不评分。
- [ ] 2.3 `ScoreEventsResult` 增补全计数（`enrichHit` / `enrichFail`，`enrichFail` 含 SSRF 拒绝数与命中全站样板数），供**每一条**调用链各自日志暴露。
- [ ] 2.4 补全失败**绝不**计入 `degradedCount`（熔断分母仍只含 judge/digest 两阶段）。
- [ ] 2.5 **评分写 CAS 加 `importance_score IS NULL` 守卫（`:234-246`，绝不可省）**：
      ```ts
      .where(and(
        eq(aiNewsEvents.eventId, event.eventId),
        isNull(aiNewsEvents.importanceScore),   // ← 新增：永不覆写的最后一道结构保证
        isNull(aiNewsEvents.mergedInto),
      ))
      ```
      理由与 TTL 算得对不对**无关**：时间不变量依赖「所有超时都真被 `AbortSignal` 兜住」，而 DNS 解析（见 1.4 残余）、进程长 STW 暂停、容器冻结/迁移**都能越过它**。CAS 是**结构**保证，时间阈值只是**概率**保证——「一事件只评一次分、永不覆写」这种承诺必须落在结构上。
      命中 0 行的既有分支（`:247` 起）今天把 0 行**归因为 tombstone**；须改为**区分两因**：`merged_into` 非空 → 既有 tombstone 路径（`judged--`、释放 claim、不计降级）；`importance_score` 已非空 → **误回收被兜住**，记 WARN 日志（**这是应当被看见的异常**，不是常态），同样不计 scored、不计降级、不稀释分母。

- [ ] 2.6 **`ScoreEventsOptions` 增 `enrich?: EnrichContentOptions`（注入 seam，绝不可省）**：补全搬进判分入口后，`fetchImpl` / `resolve` / `maxRedirects` / `logError` 的注入口**必须**随它一起搬——今天 `ScoreEventsOptions` 只有 `{ judge, logError, reclaimMs }`，**没有任何参数能承载 fetch mock**，任务 6.1/6.2/6.3/6.5 按字面**不可实现**，且补全会在 `scoreUnscoredEvents` 内部走 `globalThis.fetch` + 真 `dns.lookup`。
      ```ts
      export interface ScoreEventsOptions {
        judge?: JudgeOptions;
        /** 内联正文补全的选项（注入 fetchImpl/resolve 桩使测试不触网）。 */
        enrich?: EnrichContentOptions;
        logError?: (message: string, detail: unknown) => void;
        reclaimMs?: number;
      }
      ```
      **这一条与「删掉调用链编排」是同一件事的两面**：补全的**能力**下沉了，补全的**可注入性**必须同步下沉。**MUST NOT 只删消费者、不给注入 seam 新家**——那样测试桩「还在传、但没人读」，无网护栏被静默拆除（有网 CI：真外发且测试通过；无网 CI：fetch 抛错被 1.3 的逐条 try/catch 吞成 `enrichFail++`、事件照常 title-only 判分、测试**依然通过**）。

- [ ] 2.7 **`releaseJudgeClaim` 加属主校验（`:143-153`，绝不可省）**：今天它的 WHERE 只有 `event_id = ? AND importance_score IS NULL`——**不校验「这一次 claim 是不是我写的」**。两条判分链下的交错：A claim 事件 E（`judge_claimed_at = t0`）→ A 的补全 DNS 挂起超过 `T` → D **合法回收** E（写入 `t1`）并开始判分 → A 的 LLM 随后失败 → `catch` → `releaseJudgeClaim(E)` → 此刻 `importance_score IS NULL` **仍为真**（D 还没写分）→ **清掉 D 的活 claim** → 下一 tick 第三个 claimer 进入，与 D **并发判同一条**，**再发一次补全 HTTP + 一次 LLM**。写 CAS（2.5）保住了「永不覆写」⇒ **数据仍是对的**，坏的是**成本**。三行修法（与 2.5 同一招式）：
      - `claimEventForJudging` 把 claim 凭据以 **`::text`** 回传调用方（`ClaimResult` 随之带上 **`claimToken: string`**，**不是** `claimedAt: Date`）：
        ```ts
        .returning({ claimToken: sql<string>`${aiNewsEvents.judgeClaimedAt}::text` })
        ```
      - `releaseJudgeClaim(eventId, claimToken, dbh)` 的 WHERE 用该 token 精确比对（PG 侧解析回 `timestamptz`，逐微秒相等）——**只释放自己那一次 claim**，别人的活 claim 一行不动（命中 0 行 = 已被回收，良性）：
        ```ts
        .where(and(
          eq(aiNewsEvents.eventId, eventId),
          isNull(aiNewsEvents.importanceScore),
          sql`${aiNewsEvents.judgeClaimedAt} = ${claimToken}::timestamptz`,
        ))
        ```
      - **MUST NOT 用 `.returning({ judgeClaimedAt })` 拿 JS `Date` 作 claim 凭据**：`schema.ts:166` 的 `judgeClaimedAt` 未声明 `mode: 'string'` ⇒ drizzle 默认 `mode: 'date'` ⇒ 回传的是**毫秒精度**的 JS `Date`，而 `now()` 写入 `timestamptz` 的是**微秒**精度（生产实测 **99.87%** 的行带非零微秒位）⇒ 回传比较 `eq(judgeClaimedAt, claimedAt)` **恒不命中** ⇒ release 命中 0 行 ⇒ **永久 no-op**：判分失败的事件再也无法提前释放，每一条都要锁满整个 `T`（本变更把 `JUDGE_CLAIM_RECLAIM_MS` 调到 **300000 = 5 分钟**）——把一个「省成本」的修复变成「更慢」的回归，且**在测试里会假绿**（整毫秒时间戳的桩 / 小 `reclaimMs` 都不暴露截断）。凭据 MUST 以 **`::text` 往返**（改用独立的 `uuid` claim token 列亦可，但需迁移，本期不做）。
      - **凭据串的解析依赖读写两侧会话的 `DateStyle` 一致**：`timestamptz::text` 同会话往返恒无损（微秒位完整、ISO 下偏移量内嵌，换 `TimeZone` 亦安全）；只有写侧与读侧会话的 `DateStyle` 不一致时才会误解析（如写侧 `SQL, DMY` 出 `14/07/2026`、读侧 `SQL, MDY` 解析成 month=14）。本仓不覆盖该参数（服务端默认 `ISO, MDY`）、连接池同源，故今天不可达。**MUST NOT** 给连接串加 `options=-c datestyle=…`；若将来必须加，凭据 MUST 改为固定格式（`to_char(… AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`）。
      - 订正 `:95` 的注释：「保证『一事件只被评一次分』跨日报/告警两链路成立」在**两条链**下**不成立**——claim 只**降低**重复判分的概率；「只评一次分、永不覆写」的**结构**保证是写 CAS（2.5），claim + 属主校验保证的是「不互相踩 claim」。
      - **`ClaimResult` 由字符串联合变对象 ⇒ 同步迁移全部 9 处既有断言（MUST，逐个列出）**：今天 `ClaimResult = 'claimed' | 'skipped'`，调用方都在做 `=== 'claimed'` / `=== 'skipped'` 直接比较，带上 `claimToken` 后 `typecheck` 会当场炸（**这是好事**）。**MUST NOT 用 `as any` 或只取 `.status` 糊过去**，逐处迁到新返回形态：
        - `src/agents/value-judge/__tests__/claim.integration.test.ts`：`:106`、`:107`、`:108`（三路并发 claim 的结果过滤）、`:147`、`:151`、`:159`、`:164`、`:174`
        - `src/dedup/__tests__/tombstone-visibility.integration.test.ts`：`:197`

## 3. 删掉日报链的独立编排（`src/pipeline/run-daily-workflow.ts`）

- [ ] 3.1 删除阶段 2.6 整段（`:601-625`）：`enrichCandidateContent` 调用、防御性 try/catch、`enrichResult` 日志、以及顶部对应 import（`:45`）。
      **MUST NOT 只删不迁**：`RunDailyWorkflowOptions.enrich`（`:166`）今天的**唯一**消费者就是这一行（`:611`），而它承载着日报集成测试的无网护栏（`run-daily-workflow.integration.test.ts:40-46` 的 `NO_NETWORK_ENRICH = { fetchImpl: 抛错, resolve: 固定 IP }`，`:50` 注入）。删掉消费者而不给它新家 = **拆绊线**（桩还在传、但没人读）。故：**MUST 删掉 `RunDailyWorkflowOptions.enrich` 字段本身**，`run-daily-workflow.integration.test.ts:50` 改传 `judge: { enrich: NO_NETWORK_ENRICH }`——桩经判分入口的注入 seam（2.6）送达补全。
      **MUST NOT 保留该字段并在调 `scoreUnscoredEvents` 时转发**：保留转发正是 spec 明令禁止的「为某一条链另开平行的补全字段」，且它是**唯一能重现「桩还在传、转发被删掉、测试仍绿」的形态**——本变更起因的那个 blocker 的复发路径。字段删掉后，同样的失手会在 `typecheck` 当场炸。
- [ ] 3.2 补全的命中/失败数改由 `scoreUnscoredEvents` 的返回值取，并入 Value Judge 阶段日志行。

## 4. 告警链（`src/pipeline/alert-scan.ts`）

- [ ] 4.1 **无功能改动**（它调同一个 `scoreUnscoredEvents`，自动获得补全）。
- [ ] 4.2 **删除** `:423-426` 那条已不再成立的 `ponytail:` 注释（「高频告警链不跑 og:description enrichment（保持精简车道）」）——留一条与代码相反的注释是下一个人凌晨 3 点要解码的东西。
- [ ] 4.3 把补全计数并入告警链的 score 阶段日志（告警链的补全不得成为盲区）。
- [ ] 4.4 **补全的注入 seam 告警链自动获得，`alert-scan.ts` 无需改动**：`RunAlertScanOptions.judge: ScoreEventsOptions`（`:90`）已是现成通道 ⇒ 测试经 `options.judge.enrich` 注入无网络桩即可（见 6.10）。**MUST NOT** 在 `alert-scan.ts` 上再开一个平行的 `enrich?` 字段——那正是本变更要消灭的「每条链各自编排补全」。

## 5. 回收阈值下界（`src/config/env.ts` + `src/agents/value-judge/index.ts`）

> **现存的 superRefine 今天就是错的**（不是本变更引入的）：它校验 `T > L + W`，而判分重试的是**整个 LLM 调用**（`value-judge/index.ts:103`，`DEFAULT_MAX_ATTEMPTS=3`）、**每次尝试各自**一个 `AbortSignal.timeout(LLM_TIMEOUT_MS)`（`llm-client.ts:65`）⇒ 改动前的真实最坏就已是 `3L + W = 240000 > T = 180000`。它只是**潜伏**（只有一条判分链、没有第二个回收者）。**下一环 `p0-alert-lane` 开的正是第二条链。**

- [ ] 5.1 **单一定义 `A`**：在 `src/config/env.ts` 导出 `export const JUDGE_MAX_ATTEMPTS = 3;`，`value-judge/index.ts:66` 的 `DEFAULT_MAX_ATTEMPTS` 改为 import 它（**删掉那份字面量 3**）。
      方向 `agents → config` 与既有 `llm-client → env` 同向、**无环**；反向（env import agents）会成环并把整个 AI SDK 拖进 env 的模块图。
      **禁止**在 superRefine 里抄一份字面量 `3`——两份必然漂移（改了重试次数、忘了改阈值）。
- [ ] 5.2 `:622-632` 的启动期 superRefine 改为
      **`JUDGE_CLAIM_RECLAIM_MS > COLLECTOR_FETCH_TIMEOUT_MS + JUDGE_MAX_ATTEMPTS × LLM_TIMEOUT_MS + JUDGE_WRITE_BUDGET_MS`**
      = `15000 + 3×60000 + 60000` = **255,000**（`F` 因补全落进 claim 而进预算；`A×L` 因重试重试整个调用而必须乘）。错误消息须报出四项（`F` / `A` / `L` / `W`）及其和。
      仓内已有正确范式：`published-at-inference/backfill.ts:142-144`（`env.LLM_TIMEOUT_MS * maxAttempts + slack`）。
- [ ] 5.3 更新 `JUDGE_CLAIM_RECLAIM_MS` 的注释（`:416-422`）：`T > F + A×L + W`，并写清 `A` 为何不可省。
- [ ] 5.4 **默认值必须改**（与原提案相反）：`JUDGE_CLAIM_RECLAIM_MS` 默认 **`180000 → 300000`**（> 255000，留 45s 余量）；`.env.example:188` 同步。
      **不改默认就是拿 fail-fast 给一个会误回收的配置盖章。**
- [ ] 5.5 部署前 MUST 核对生产 env：若显式覆盖过 `JUDGE_CLAIM_RECLAIM_MS`（或调高过 `COLLECTOR_FETCH_TIMEOUT_MS`/`LLM_TIMEOUT_MS`）而不满足新下界，容器会在启动期 fail-fast——**期望行为**（那个配置本来就会误回收），非回归。

## 6. 测试

- [ ] 6.1 `score-events` 单测（**本变更的权威验收**）：空 content + 可抓 URL 的事件 → 注入 fetch mock，断言**先补全再判分**，且 **`judgeRawItem` 收到的 `content` 【入参】** 等于补全后的正文。
      **只断言「`raw_items.content` 被写入」不合格**——补全只写库不回传时该断言**同样为绿**（DB 补全了、这一次判分仍 title-only），对本条毫无证伪力。断言必须落在 **judge 的输入**上。
- [ ] 6.2 `score-events` 单测（**fail-open，关键**）：补全抛错 / og 缺失 / 命中样板 → 断言该事件**仍被判分**（仅标题输入）、`*_score` 落库、`enrichFail` +1、`degradedCount` **不**增。
- [ ] 6.3 `score-events` 单测：claim 失败（`'skipped'`）的事件**不发起任何 HTTP**（补全在 claim 之后 ⇒ 未 claim 到者不抓）。
- [ ] 6.4 `score-events` 单测（**空判定单一谓词**）：`content = ' '`（NBSP）的事件 → 其 `isEmpty` 投影列为 `false` ⇒ 断言**不发起任何 HTTP**（无白抓）、照常送判。
      本条钉死「选取侧不得退回 TS `trim()`」——TS 实现下该用例会发一次抓取、写回 0 行、并打出「已被并发填充」的假日志。
- [ ] 6.5 **回归护栏**：断言 `run-daily-workflow.ts` **不再** import `content-enrichment` 的补全入口（防有人把阶段 2.6 加回来）；断言告警链路径上空 content 事件会触发补全（`alert-scan` 集成测试，fetch 与 LLM 均经 `options.judge.enrich` / `options.judge.judge` 注入 mock）。
- [ ] 6.6 `env` 单测：
      - `JUDGE_CLAIM_RECLAIM_MS = COLLECTOR_FETCH_TIMEOUT_MS + JUDGE_MAX_ATTEMPTS × LLM_TIMEOUT_MS + JUDGE_WRITE_BUDGET_MS`（相等，非严格大于）→ 断言启动 fail-fast；
      - **`JUDGE_CLAIM_RECLAIM_MS = 180000`（旧默认值）+ 其余默认 → 断言启动 fail-fast**（这是本次修的那个 bug 的回归钉：旧默认不满足真实下界）；
      - 新默认值组合（`300000`）→ 断言通过。
- [ ] 6.7 `score-events` 单测（**写分 CAS 守卫**）：构造「claim 成功 → LLM 返回期间该事件已被另一路径写入 `importance_score`」→ 断言评分写**命中 0 行**、**不覆写**既有分数、不计 `scored`、不计 `degradedCount`、记 WARN（与 tombstone 0 行路径**可区分**）。
- [ ] 6.8 `content-enrichment` 单测（**整次一条 deadline**）：注入连续 302 的 fetch mock（≥3 跳）→ 断言**全部跳共用同一个 `AbortSignal`**（如 mock 记录各跳收到的 `signal` 引用相等），而非每跳一个新 signal。
- [ ] 6.9 迁移既有 `content-enrichment` 测试到单条函数口径（SSRF 守卫、原子判空写回、样板判定的用例逐条保留，**不得**借重构删掉）；补一条：写回命中 0 行（并发填充）时返回的是**DB 里的既有正文**、不是 `null`。
- [ ] 6.10 **无网络桩必须覆盖每一个调用 `scoreUnscoredEvents` 的测试文件（绝不可省）**：补全下沉进判分入口后，**所有**经 `scoreUnscoredEvents` 的测试都会对候选的真实 URL 发 DNS + HTTP。当前调用方与其种子：
      | 文件 | 种子 | 现状 |
      |---|---|---|
      | `src/pipeline/__tests__/run-daily-workflow.integration.test.ts` | `content: null` + 真实 URL | 已有 `NO_NETWORK_ENRICH`（`:40-46`，`:50` 注入） |
      | `src/pipeline/__tests__/alert-scan.integration.test.ts` | `rssItem()` 恒 `content: null` + `https://x.com/…` | **零注入** |
      | `src/dedup/__tests__/tombstone-visibility.integration.test.ts`（`:115`, `:211`） | `:170` 真实 URL 无 content | **零注入** |
      | `src/agents/value-judge/__tests__/score-events.integration.test.ts`（`:139`, `:180`, `:204`, `:215`, `:231`, `:255`） | `:105` `content ?? null` + `:99` `https://example.com/…` | **零注入** |
      | `src/agents/value-judge/__tests__/claim.integration.test.ts`（`:123`） | INSERT 不含 `content` 列 ⇒ NULL + `:51` `https://example.com/…` | **零注入** |
      `example.com` 是 IANA 的**真实可解析域名** ⇒ 过 SSRF 守卫、真发 DNS + HTTP；其页面无 `og:description` ⇒ 补全按 fail 计 ⇒ 被 1.3 的逐条 try/catch 吞掉 ⇒ **测试全绿**。故上述四个零注入文件的共用 helper **MUST** 经 `options.judge.enrich` 注入无网络桩（`fetchImpl` 直接抛错 + `resolve` 返回固定公网 IP），与 `run-daily-workflow.integration.test.ts:40-46` 的 `NO_NETWORK_ENRICH` **同规格**（导出复用那一个常量，避免多份漂移）。
      **`alert-scan.integration.test.ts` 的桩 MUST 走 `judge.enrich`**：`RunAlertScanOptions`（`alert-scan.ts:82-96`）**今天没有也 MUST NOT 新增** `enrich` 字段——它的现成通道就是 `judge?: ScoreEventsOptions`（`:90`），桩经 `judge: { judge: {...}, enrich: NO_NETWORK_ENRICH }` 送达补全（见 4.4：不为任一条链另开平行的补全字段）。
- [ ] 6.11 **结构性回归钉（绝不可省，MUST 为守卫、MUST NOT 只靠注入桩）**：补全的**默认** `fetchImpl` **与默认 `resolve`（`content-enrichment.ts:192-195` 的 `defaultResolve`，调真实 `dns.lookup`）二者** **MUST** 在 `process.env.VITEST` 下**直接抛错**。
      **守卫 MUST NOT 只挂 `fetchImpl`**：`fetchArticleGuarded` 里 `assertHostAllowed(current, resolve)`（`:211`）**先于** `fetchImpl`（`:212`）执行，且 `resolve` 未注入时就是真 `dns.lookup` ⇒ 只挡 HTTP 时，每个未注入 `resolve` 的测试**照样对 `example.com` / 各源域名发真实 DNS 查询**，而 7.5 要的是「无对外 DNS / HTTP」。
      **抛错位置 MUST 钉在「默认实现的函数体内」**（`defaultResolve` 与默认 `fetchImpl` 各自的函数体），与仓内既有守卫同形：`src/kb/embed-clean.ts:44`、`src/mr/curation/telegram-callback.ts:194`。**MUST NOT 抛在选项解析处**（`:254-255`）——那会把「本来就不走补全路径、既不该触网也不该失败」的测试一并打红。
      **代价与配套（MUST 一并做）**：函数体内抛错会被 1.3 的逐条 try/catch 吞成 `enrichFail++`、事件照常 title-only 判分 ⇒ **守卫单独不足以证明「零出站」，MUST NOT 拿「测试全绿」当证据**。零出站的证明落在 7.5 的机械核验上（未注入桩时默认 `fetchImpl` / `defaultResolve` 的 spy 调用次数为 0，或断网跑一遍并核 `enrichFail` 为 0）。
      **为何不能把防线建在「每个测试文件都记得注入桩」上**：逐文件注入是**纪律**，纪律靠枚举兑现，而枚举必然漏（6.10 那张表的**四个**零注入文件即是证据）；`VITEST` 守卫是**结构**，新增的第 N 个测试文件**漏不掉**。一份通篇论证「恒绿的守卫等于没有守卫」的变更，不该把最后一道防线交给记性。
      6.10 的注入桩仍然要补——它让测试能**主动控制**补全行为（模拟命中/失败/样板）；但**兜底必须是结构性的**：守卫在下面兜住所有没注入的路径。
- [ ] 6.12 **claim/release 往返测试 MUST 跑在真实 PG（集成测试）**，配 2.7。任何内存桩都会让下面第一条**假绿**——微秒截断只在真实 `timestamptz` 往返时才暴露：
      - **凭据往返（关键，缺了它 2.7 的陷阱必然重现）**：claim 一个事件（`now()` 写入带微秒的 `judge_claimed_at`）→ 取回 `claimToken` → **立即** `releaseJudgeClaim(eventId, claimToken)` → 断言**命中 1 行**、该事件的 `judge_claimed_at` **确已被置 NULL**。若凭据走 JS `Date`，此断言在真实 PG 上必红（命中 0 行）。
      - **属主校验**：A claim 事件 E（token `t0`）→ E 超时被 D 合法回收（`judge_claimed_at` 变为 `t1`）→ A 判分失败调 `releaseJudgeClaim(E, t0)` → 断言 A 的 release **命中 0 行**、E 的 `judge_claimed_at` **仍为 `t1`**（D 的活 claim 未被清掉）。

## 7. 验收

- [ ] 7.1 `openspec-cn validate unify-judge-stage --strict` 通过。
- [ ] 7.2 `pnpm test` / `pnpm typecheck` / `pnpm lint` 通过。
- [ ] 7.3 **零行为变化核验**（`ALERT_SCAN_ENABLED=false` 下）：日报链跑一轮，断言补全的抓取条数与命中/失败数与改动前同口径（唯一调用方、链序等价）。
- [ ] 7.4 部署前重跑任务 0.2 的基线 diff（`fix-sitemap-published-at` 应已归档）。
- [ ] 7.5 **全量测试须零网络出站（MUST 机械核验，MUST NOT 以「测试全绿」结案）**：跑一遍完整 `pnpm test`，确认**无对外 DNS / HTTP**。6.11 的 `VITEST` 守卫抛在函数体内 ⇒ 错会被逐条 try/catch 吞成 `enrichFail++`、测试仍绿 ⇒ **绿色测试对本条毫无证伪力**（这正是本变更通篇论证的失效模式：真实外发失败被吞成「正常降级」）。故本条 **MUST** 至少用下述一种手段直接核验出站行为本身：
      - **spy 调用次数**：在未注入桩的路径上给默认 `fetchImpl` / `defaultResolve` 挂 spy，断言**调用次数为 0**；
      - **断网跑一遍**：切断出网后跑全量 `pnpm test`，断言**全绿且补全失败计数（`enrichFail`）为 0**（若守卫或注入桩有洞，断网下该计数必 > 0）。
