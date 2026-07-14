## Context

`sitemap` 采集器（首期 Anthropic News）的 per-article 阶段**已经下载整张文章 HTML**（取 `og:title` / `og:description`），但：

- **不取页面上的发布日** → 交 AI 推断 → 该源无任何页面外日期线索、且新公告在训练截止之后 → **对新公告推断只能返 `null`** → 被每一道时效闸排除；**对老文推断反而会从训练记忆里报出日期**（实测 25 条里 10 条有值，如 `Golden Gate Claude → 2024-05-21`）——**它是猜，不是提取**（见 D7）。
- **`og:description` 是全站样板文案**（6/14 逐字相同），且**非空** → 摘要防幻觉护栏 / 正文补全工作集 / 语义合并的空文本兜底 **三者全部被绕过**。

生产实测（2026-07-13）：**25 条事件 / 21 条 `should_push=true`（最高 `importance=88`） / 推送成功 0 条**。

**但存量一条也救不回来**（见 D6）：那 21 条的 `is_ai_related` **全为 NULL**（该列 2026-07-10 才上线），被日报要闻闸 `top-n.ts:269`（`eq(is_ai_related, true)`，fail-closed）排除，而判分工作集按 `importance_score IS NULL` 取 ⇒ **永不重判 ⇒ 永远 NULL**；且它们的真实发布日一律出 3 天时效窗。**本设计的全部收益在【未来新文】（约 1–2 篇/天）。**

## Goals / Non-Goals

**Goals**：让 sitemap 条目拿到**确定性**的真实发布日；让样板 `og:description` 不再冒充正文。

**Non-Goals**：
- **不碰 P0 车道**（`ALERT_SCAN_ENABLED` 保持 `false`）——本变更的风险敞口**仅限日报**。
- 不改 `REALTIME_NEWS_SOURCES`；不用 `lastmod`；不引入 HTML 解析库。

## Decisions

### D1 — 锚定：**唯一 h1**，不是 `og:title` 相等

| 候选锚点 | 30 页实测 | 判定 |
|---|---|---|
| **文档中有且仅有一个 `<h1>`** | **30 / 30** | ✅ 采用 |
| `og:title` 文本 == `<h1>` 文本 | **18 / 30** | ❌ **会丢弃 40% 有日期的页面** |

反例：`core-views-on-ai-safety` —— `og:title` = `Anthropic's core views on AI safety`，`<h1>` = `Core views on AI safety: When, why, what, and how`。**二者不等，而页面日期 `Mar 8, 2023` 完好。**

「唯一 h1」同时守住它要防的场景：站点日后加 nav / 相关文章卡片的 h1 → 数量 ≠ 1 → **干净失败**（`null` → 回落）。

> **教训（本设计的方法论前提）**：早前版本基于 **1 个样本**误断言「og:title 可作锚点」（实测**仅 18/30**），基于 **5 个样本**误断言「lastmod 全部相同」（实测**分散**）——**两条都被 30 页实测证伪**（lastmod 实为分散：19@2025-07-23 / 14@2024-12-19 / 12@2024-09-10 / 11@2024-08-05）。**本变更的每一条量化断言 MUST 标注样本量。**

### D2 — 整串全匹配，**绝不子串搜索**（这是全变更最危险的一处）

对紧邻元素的文本做 `^\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*$`。

**子串搜索的失败模式不是「找不到」，是「找到错的」**：

| 元素文本 | 子串搜索 | 整串全匹配 |
|---|---|---|
| `By Jane Doe · Mar 2, 2025 · 5 min read` | **抠出 `Mar 2, 2025`**（作者页的日期） | 失败 → `null` ✅ |
| `Updated Jan 5, 2024`（老文的**修订日**） | **抠出修订日当发布日** | 失败 → `null` ✅ |

而**页面上的错误日期天然落在 `2015-01-01 <= d <= now` 范围内** → 范围校验挡不住 → 时效窗口挡不住 → `ALERT_MIN_PUBLISHED_AT` 水位挡不住（**它们只拒未来值**）→ **一篇老文被当今日突发**。

**整串全匹配把「提取到错的」变成「什么都没提取到」——脏失败转干净失败，使「失败 → NULL → 回落」这条安全论证真正成立。**

### D3 — 解析口径：`Date.UTC()`，不是 `new Date(str)`

`Jul 9, 2026` **无时区**。`new Date('Jul 9, 2026')` 在 V8 里按**运行时本地时区**解析（非 ISO 串 → 实现自定义）。容器 TZ 未设 → UTC；设为 `Asia/Shanghai` → 整体偏 8 小时 → 下游 3 天时效窗与基线水位的边界比较漂 ≤1 天。

**MUST `Date.UTC(y, m, d)` 显式构造 UTC 零点。** 合理下限 MUST 为具体常量 **`2015-01-01`**（不得留给实现者临时发明）。

### D4 — 样板 `og:description` 视同缺失（**采集器与补全两处，共享同一判定**）

| 被修复的路 | 现状（样板非空 → 全部失效） |
|---|---|
| 摘要防幻觉护栏 | `hasContent = Boolean(content?.trim())` → `true` → 「无正文不编造」**不触发** → LLM 拿样板当 grounding 写摘要。**比无正文更糟** |
| 正文补全工作集 | `content IS NULL OR content !~ '\S'` → 样板非空 → **永久排除在补全域外** |
| 语义合并 | embedding 文本的 `content` 摘录两篇相同 → 相似度被系统性推高；灰区 LLM 的两侧 `Content:` 也是同一串 → 误并 |

**只在采集器置 null 是不够的——补全会把它写回来。** 补全的正文来源同样是 `og:description`，且**零样板感知**（`content-enrichment.ts:289` 抽 og → `:299` `.set({ content: description })` 原样写回）：

1. 采集器判样板 → `content = null`；
2. 该行**恰因此**进入补全工作集（`EMPTY_CONTENT`）；
3. 补全重抓**同一张页面** → `extractOgTag` 拿回**同一段样板**。**它非空 —— 这是 `extractOgTag` 的成功路径，不是失败路径** → **原样写回** → `content` 变回样板 → 三道护栏重新被绕过，且该样板成为这条 raw_item 的**终身正文**（`content` 非空 ⇒ 永久离开补全工作集；事件判分后 `importance_score` 非 NULL ⇒ 也永久离开判分工作集）。

**故样板判定 MUST 同时落在补全的写回之前**：

```ts
// src/collectors/sitemap.ts：导出判定（content-enrichment 本就从本模块 import extractOgTag / MAX_BODY_BYTES）
export function isSiteBoilerplate(text: string): boolean { … }   // 首版硬编码该常量串

// src/collectors/sitemap.ts（per-article）
const content = isSiteBoilerplate(og) ? null : og;

// src/pipeline/content-enrichment.ts（写回前）
if (!description || isSiteBoilerplate(description)) { fail += 1; logError(…); continue; }
```

**单一定义、两处引用**。MUST NOT 各写一份——两份判定必然漂移（样板串变更时只改一处），洞会从漂移的那一侧重新打开。

M-1 的跳过条件是「`og:title` **与** `og:description` **双缺**」（`sitemap.ts:509` 是一个 AND，**不是**锚在 `og:title` 单侧），样板视同缺失后条目**照常发射**（仅 `content=null`）。

**故顺序 MUST 钉死：`isSiteBoilerplate` MUST 在 M-1 双缺检查【之后】作用于 `ogDescription`。** 反序（先把样板置 null、再判双缺）会让「缺 `og:title` + 样板 `og:description`」的页面从「发射 slug-title 条目」（`sitemap.ts:517-519` 既有的 slug 派生回退路径）**翻成「整篇跳过」**——一个没人授权过的可观测行为变化。

补全侧按失败计后 `content` 保持 `null` —— **这才是正确的降级方向**（下游退化仅标题、防幻觉护栏正常触发）。

### D5 — ReDoS：沿用本文件既有范式

`sitemap.ts` 的每一处正则都带反回溯设计——`parseSitemap` **正是从 lazy-capture 重写成 `indexOf` 线性切块**（实测 1MB 未闭合 `<url>` → **29s**，2MB → 60s；而 body 上限是 **5MB**）；`extractOgTag` 显式加界 `[\s\S]{0,10000}?`。

新的日期定位要在**同样 5MB 的文章 HTML** 上跑。整串匹配那条正则本身锚定、安全；**危险的是定位那一步**——`/<h1[^>]*>[\s\S]*?<\/h1>\s*<[^>]*>([^<]*)</` 在无匹配页面上就是二次方回溯。

**MUST**：`indexOf('<h1')` / `indexOf('</h1>')`（`-1` 立即 bail）+ **有界 slice**（如 300 字符）再在小串上跑锚定正则。

### D6 — 存量**不动**：不重采、不删 raw_items、不回填

早前版本要「按 `source='sitemap'` 删那 28 行 raw_items 使其重采」。**枪毙。**

**① 存量是死行，重采救不活**（见 Context）：那 21 条 `should_push=true` 的事件 `is_ai_related` 全为 NULL，被 fail-closed 的日报要闻闸排除，且**永不重判**；即便拿到正确日期也一律出 3 天时效窗。**可挽回价值 = 0。**

**② 而「按 `source='sitemap'` 删 `raw_items` 行」会造成真实损坏**：

```
schema.ts:134   ai_news_events.representative_raw_item_id 是【裸 bigint、零外键】→ DELETE 静默成功、不级联
collapse.ts     onConflictDoUpdate.set 【不含】representativeRawItemId（schema.ts:122 明文「禁止覆盖代表」）
                ⇒ 25 条事件的代表指针【永久悬空】，重采也补不回来
```

**③ 而验收 SQL 只读 `raw_items` ⇒ 恒绿，看不见事件层的损坏。**

> 早前这里还有第三条理由：「`published_at` 是单向 NULL-fill ⇒ 那 10 条已带 AI 推断日期的事件会丢掉新提取的页面日期」。**D8 已把该口径改为「权威高者胜出」，故这条理由不再成立**（重采的页面提取值 authority=2 会正确覆盖 authority=1 的推断值）。**结论不变**——①②③ 里任何一条都足以枪毙重采，而可挽回价值本就是 0。

**提取器的正确性由 tasks 3.1 的【线上字节 fixture 单测】证明**（在真实生产 HTML 上断言 `== 2026-07-09 / 2023-09-19 / 2023-03-08`）——重采不提供任何额外证据，只提供风险。

### D7 — sitemap 源**关掉 AI 推断兜底**（消除本设计自己的两套标准）

D2 枪毙子串搜索的论证是：**页面上的错误日期天然落在合理范围内** ⇒ 范围校验 / 时效窗口 / 基线水位**一道都挡不住** ⇒ 老文被当今日突发。故正则被要求「**只准干净失败**」。

**这段话逐字适用于本设计自己保留的 LLM 兜底。** `published-at-inference` 在本源上：

| | 子串搜索（已枪毙） | 本源的 AI 推断（原方案保留） |
|---|---|---|
| 信息来源 | 页面上一段含日期的杂文本 | **模型训练记忆**（该源 URL / 标题 / 正文**均无**日期线索） |
| 失效模式 | 抠出**错的**日期 | 报出**猜的**日期 |
| 错误值落在合理范围内？ | **是** | **是**（实测报出的都是合理的老日期） |
| 全部防线 | —— | 一道「拒未来值」的范围校验 + 一段 prompt |

**同一个失效模式，两套标准。** 二选一，取**与「宁可漏，绝不把改版老文洗成今日发布」一致**的那个：

**MUST：sitemap 源的事件不进 `published-at-inference` 的回填域。** 页面提取失败 ⇒ `published_at = NULL` ⇒ 不推送。

**本豁免的完整代价 MUST 一并读到（见 Risks 第一条）**：回填域不含本源 + 失败的 raw_item 进已见集后**永不重采** ⇒ 「提取失败」是一个**永久且不可恢复**的状态，**正则修好之后也回不来**。

落地：`backfill.ts` 的候选查询**已经** `innerJoin rawItems` 并 `select({ source: rawItems.source })`（`:163-171`）⇒ where 里加一个谓词即可。**不动推断能力的通用机制**——其余源的 URL / 标题 / 正文里确有日期线索，推断在那里是**有依据的语义补全**，不是猜。

> **存量那 10 条已推断的日期不清除**（见「回滚」）：它们碰巧是对的，且清不清都出时效窗、都被 fail-closed 闸挡住。**清它们的唯一效果是制造一次没有收益的写操作。**

### D8 — `published_at` 归集：从「先到者永久胜出」改为「权威等级高者胜出」

**没有这一条，D1–D7 全白做——页面提取【死于到达】。**

`published_at` 的归集今天是**无条件单向 NULL-fill**，且它有**两个副本**：

```
collapse.ts:162      publishedAt: sql`COALESCE(${aiNewsEvents.publishedAt}, EXCLUDED.published_at)`
semantic-dedup 规范   published_at = COALESCE(存活, 被吞)   （合并处，第二个副本）
```

**已设值绝不被覆盖**。而各源写入 `published_at` 的语义并不等价：

| 源 | 值 | 是文章发布日吗 |
|---|---|---|
| `hacker_news`（`toDate(item.time)`） | **投稿到 HN 的时刻** | ❌ 近似 |
| `rss`（`parseDate(item)`） | feed 的 `pubDate`（可能是重新生成/转载时刻） | ❌ 近似 |
| `github`（`toDate(pushed_at)`） | 仓库 push 时刻 | ❌ 近似 |
| `sitemap` 的 `lastmod` | 站点最后修改 | ❌ **本设计已枪毙它**（D1 前提） |
| **`sitemap` 的页面提取（本变更新增）** | **文章页面上自己印的发布日** | ✅ **全系统唯一一个** |

生产实测三条 Anthropic 官宣（`fable-mythos-access` / `introducing-claude-tag` / `claude-sonnet-5`），事件 `published_at` **全部来自 HN 的投稿时刻**；`fable-mythos-access` 的 RSS 日期**被 `COALESCE` 丢弃**（HN 先到、值已非 NULL）。⇒ **本变更落地后，页面提取的精确日期会在每一篇上了 HN 的文章上被同一个 `COALESCE` 丢弃**——而上 HN 的恰恰是重大模型发布。

#### 一条【不要做】的事

**MUST NOT 引入「rss / sitemap 比 hacker_news 权威」的源级排序。** 实测 HN 与 RSS 不一致的事件，`off_days` **大多是负的**（HN 比 RSS **更早**）：

```
Working With AI: A concrete example     hn=2026-06-29  rss=2026-07-11   -12 天
Inference Optimization for MiMo v2.5    hn=2026-07-07  rss=2026-07-11    -5 天
```

**哪个是文章真正的发布日，数据里根本没有。** 按「rss > hn」去「修」，会把这些事件的 `published_at` 往**后**推 1~12 天 ⇒ **让老文看起来更新** ⇒ 正是本设计（D1/D2）反复要防的方向。**存量 `published_at` 一行不动。**

#### 采用的口径（收窄且确定）

不是源级权威排序，只有两条覆盖关系：**页面提取 > 一切**；**程序取得的时间戳 > LLM 猜的日期**。近似源之间**不判高下**。

```sql
-- schema（迁移 drizzle/0013）
published_at_authority smallint NOT NULL DEFAULT 0
-- 0 无日期
-- 1 LLM 推断值（published-at-inference 的 AI 回填——【猜】的）
-- 2 程序取得的近似值（rss pubDate / hacker_news 投稿时刻 / github push 时刻——【真实时间戳】，只是不是发布日）
-- 3 页面确定性提取的发布日（sitemap——文章自己印的）
CHECK ((published_at IS NULL) = (published_at_authority = 0))

-- 推导（由 raw_items.source 得出，不给 raw_items 加列）
authority = CASE WHEN raw_items.published_at IS NULL THEN 0
                 WHEN raw_items.source = 'sitemap'   THEN 3   -- 恒为页面提取值（lastmod 已被禁止写入）
                 ELSE                                     2 END
-- 等级 1 不由塌缩产出：只有 published-at-inference 的 CAS 回填写它。

-- 归集（塌缩的 DO UPDATE、tombstone 改投、语义合并 —— 三处同口径）
published_at = CASE WHEN EXCLUDED.published_at_authority > ai_news_events.published_at_authority
                      THEN EXCLUDED.published_at ELSE ai_news_events.published_at END,
published_at_authority = GREATEST(ai_news_events.published_at_authority, EXCLUDED.published_at_authority)
```

**为何必须是四级、不能三级（LLM 推断绝不能与程序取得的事实同级）**：三级方案里 AI 回填置 `authority = 1`，**与 rss `pubDate` / HN 投稿时刻 / github push 时刻同级**；而口径又定死「同等级不覆盖」⇒

```
第 1 天  某事件 published_at = NULL（0）→ AI 回填猜一个日期 → 1
第 2 天  该文上了 HN → 塌缩进同一 dedup_key，HN 的【真实投稿时间戳】亦为 1
        1 > 1 不成立 → 不覆盖 ⇒ 【HN 的真实时间戳输给了 LLM 的猜测】
```

⇒ **一个 LLM 猜出来的日期会永久挡住一个真实的时间戳**，直接违反第一架构原则（「精确事实由程序与 DB 保障，绝不交 LLM」）。**故 LLM 推断独占最低的非零级：程序 > LLM。**

**为何这个排序是对的（三句话）**：真实时间戳（2）覆盖 LLM 猜测（1）——**程序 > LLM**；页面提取（3）覆盖一切——它是全系统唯一的真发布日；**近似值之间（2 vs 2）仍不覆盖** ⇒ rss / hn / github 三者之间**行为零变化**。

**为何这两行就够（不是漏了 NULL-fill）**：不变量 `published_at IS NULL ⟺ authority = 0` 使 **NULL-fill 成为「权威高者胜出」的一个特例**——已有 NULL ⇒ authority=0 ⇒ 任何非空来者（≥1）> 0 ⇒ 自动填入。归集运算取**上确界**（幂等、与顺序无关）⇒ 塌缩与合并的并发两序皆自洽（不需新锁）。

#### 迁移语句顺序（钉死；顺序错则生产迁移当场中止）

```sql
ALTER TABLE ai_news_events ADD COLUMN published_at_authority smallint NOT NULL DEFAULT 0;
UPDATE ai_news_events SET published_at_authority = 2 WHERE published_at IS NOT NULL;  -- 存量统一标【程序近似】
ALTER TABLE ai_news_events ADD CONSTRAINT ai_news_events_published_at_authority_check
  CHECK ((published_at IS NULL) = (published_at_authority = 0));                      -- 【最后】才加约束
```

drizzle-kit 从 schema 生成时会把 `ADD COLUMN` 与 `ADD CONSTRAINT` **一起**吐出，而手工插 `UPDATE` 的自然位置是**文件末尾** ⇒ 得到「先加 CHECK、再回填」⇒ 加约束的瞬间存量**每一行**（`published_at IS NOT NULL AND authority = 0`，列的 DEFAULT）**全部违反** ⇒ **迁移 abort、容器起不来**。**空库 CI 恒绿——只在生产炸。**

**存量回填值取 2（不是 1）**：存量的非空 `published_at` 里**确实混有** AI 推断写入的值（`backfill.ts` 已在生产跑），而该列不区分来源 ⇒ **无法把它们与程序值分开** ⇒ 保守统一置 **2**。**登记这个不精确性**：这些行会被误标为「程序近似」，代价是它们不会被真实的 rss/hn 日期覆盖——**与今天的 `COALESCE` 行为完全一致，零回归**。要修的那一格（页面提取 3 > 一切）不受影响。

**语义合并那半 MUST 一并改**：存活者按 `first_seen_at` 定，与「谁的日期更精确」毫无关系——HN 先塌缩出的事件吞掉一条带页面提取日期的事件时，旧口径会把精确值丢弃。**只改塌缩 = 修一半。**

#### 塌缩侧的两个落地陷阱（钉死）

1. **塌缩的 raw_item 视图没有 `source`**（候选 SELECT 也不投影它），而 authority 推导的**全部依据**就是 `raw_items.source`。字段 MUST 为 **required**（`source: string`）——写成 `source?: string | null`（与既有的 `publishedAt?: Date | null` 同风格）会让全部既有调用点/测试 seed **不改就编译通过** ⇒ `source` 为 `undefined` ⇒ sitemap 恒推导为 2 ⇒ **页面提取的日期永不覆盖 HN 的投稿时刻** ⇒ **整个变更对「上了 HN 的重大发布」是 no-op**，而 `CHECK` 满足、迁移正常、手工构造 item 的单测**全绿**。故验收 MUST 走**读真库的塌缩集成测试**。
2. **tombstone 改投分支今天完全不写 `published_at`**（只累加 `source_count` + 更新 `last_seen_at`），而它是那条 raw_item 的**唯一**写入路径 ⇒ 不改就把 authority=3 的精确日期整个丢掉。改投函数签名 MUST 加 `publishedAt` + `authority` 两参，按同一口径归集。

### D9 — 告警必须有一个出口：`AlertSink` 接真通道，限频交给 DB

**本仓今天没有告警出口。**

```
run-daily-workflow.ts:136   defaultAlert = (msg, detail) => console.error(`[pipeline][ALERT] ${msg}`, detail)
worker.ts                   不传 alert  ⇒  生产用的就是 defaultAlert
```

⇒ 规范反复建立的「`logError` 不是告警 / `classifySystemFailure` 才是」——**在代码里是同一个 `console.error`，只差一个前缀**。tasks 1.5b 白纸黑字写「**一个落 stdout 的计数器不是告警**」，若把它接进 `classifySystemFailure`，只是接进**另一条 stderr**。

**采用**：一个运维告警 sink，**限频状态住进 DB 的推送幂等唯一约束**。

```
createOpsAlertSink({ sender, dbh, channels, now }): AlertSink

alert(message, detail) →
  ① dedupKey = detail.dedupKey                       // 类型上必填（见下）
  ② push_date = dateInTimeZone(now())                // Asia/Shanghai，绝不可用 UTC 日（见下）
  ③ INSERT push_records (target_type='ops-alert', target_id=dedupKey,
                         channel, push_date, status='pending')
     ON CONFLICT DO NOTHING
     → 命中 0 行 ⇒ 今天已就该 dedupKey 告过警 ⇒ 【直接 return，不发】
  ④ 经 sender 发送（复用既有 createFeishuSender）
  ⑤ 成功 → status='success'；失败 → 【不得占用当日限频名额】（见下）
```

**三个白拿好处**（「限频状态存哪」的答案）：

- **零新状态**：不需要 Redis 键、不需要进程内 Map——后者会在每次 redeploy 复位 ⇒「今天已告过 / 连续 N 轮」永不达标 ⇒ **静默不告警**（正是本设计通篇在防的失效模式的翻版）。
- **跨进程 / 跨重启 / 跨两条链自动去重**：日报链与高频告警链用同一个 `dedupKey` ⇒ 一条先告了，另一条自动命中唯一键冲突而跳过。
- **与第一架构原则一致**：幂等由 DB 唯一约束保障（`UNIQUE(target_type, target_id, channel, push_date)`，`schema.ts:201`），绝不交给应用层自由发挥。

##### 引入 sink 会把【4 条既有告警】变成静默——除非 detail 收窄

`AlertSink` 今天是 `(message, detail?: unknown) => void`，而 `run-daily-workflow.ts` 有 **5 个** `alert()` 调用点，其中 **4 个不带任何 `dedupKey`**：

| 调用点 | dedupKey |
|---|---|
| `:499` 系统级故障 | ✅ 已有（`kind`）|
| `:531` 源陈旧度 | ❌ → **`source-staleness:<source>`（per-source！否则多源塌成一条）** |
| `:641` judge 熔断 | ❌ → `degrade-abort:value-judge` |
| `:783` digest 熔断 | ❌ → `degrade-abort:digest` |
| `:980` 租约已失 | ❌ → `digest-lease-lost` |

而 sink 的契约是「`dedupKey = detail.dedupKey`」，`push_records.target_id` 是 **`varchar(128) NOT NULL`**（`schema.ts:191`）⇒ `target_id = undefined` ⇒ **NOT NULL 违反** ⇒ 被 sink 自己的 best-effort catch 吞掉 ⇒ **这 4 条告警连 stderr 都不再有**（今天至少还进 stderr）。而 sink 的单测（都传 `dedupKey`）**全绿**。⇒ **为了让新告警落地而引入的 sink，会把 4 条已经存在的告警变成静默**，`add-per-source-staleness-alert` 那条能力当场作废。

**MUST**：

```ts
interface AlertDetail { dedupKey: string; [k: string]: unknown }
type AlertSink = (message: string, detail: AlertDetail) => void | Promise<void>;
```

**detail 必填、`dedupKey` 必填**——**枚举必漏，编译器不漏**：收窄会让全部 5 个调用点编译报错，逼人逐个分配 key。

**`AlertSink` MUST 可返回 `Promise<void>`，5 个调用点 MUST `await`**：sink 要做 DB INSERT + 网络发送 + 状态 UPDATE，全是异步；而 `:641 / :783 / :980` **紧接着就 throw**（`WorkflowAbortError` / lease-lost）⇒ 不 await 则告警是个游离 Promise、工作流已在栈上抛错、job 已失败 ⇒ **投递零完成保证**。

##### `push_date` 的时区口径（不钉死则「跨链去重」为假、天天双响）

仓内唯一正确口径是 `src/push/push-date.ts` 的 `dateInTimeZone(date, env.PUSH_TIMEZONE)`（`Asia/Shanghai`）。若实现成 UTC 日（`toISOString().slice(0,10)` 是最常见写法）：**UTC 日界 = 08:00 CST，而日报链恰在 08:03 CST 跑**——只差 3 分钟 ⇒ 07:49 那一轮高频链的告警落 `push_date = D-1`、日报链落 `push_date = D` ⇒ **唯一键不冲突** ⇒ **持续故障期天天双响**。

**MUST 用 `dateInTimeZone(now)`**；`createOpsAlertSink` MUST 支持注入 `now`（可测），两条链传同一口径的运行时刻。

##### 发送失败不得占用当日限频名额

失败若留下一行 `status='failed'`，同一 `dedupKey` 的下一次告警会命中 `ON CONFLICT DO NOTHING`（0 行）而跳过 ⇒ **一次发送失败 = 该告警当天彻底哑火**。**MUST 择一落地**：失败时**删除**该 pending 占位行（下轮可重新占位重试），**或**把限频判据改为「存在 `status='success'` 的行才算今天已告过」。不得留给实现者临时发明。

##### 通道选择与注入点

- **通道**：sink 的 channel 取「**已配置通道全集**」逐个发（与业务推送同口径）。**未配置任何通道时回落 `console.error`，且 MUST NOT 写 `push_records` 行**——否则限频键把「没通道可发」也算成「今天已告过」，通道配好之后当天仍然静默。
- **注入点是 `run(ctx)`，不是 `runDailyWorkflow`**：`worker.ts:52` 调的是 `run(ctx)`（`run-daily-workflow.ts:1118`，自称「生产默认补齐 DI」）。把注入写成「worker 把 sink 传进 `runDailyWorkflow`」会把人指到一个 worker 根本不经过的入口 ⇒ sink 照旧不生效。

##### `ops-alert` 命名空间的必然代价

`target_type='ops-alert'` 与推送用的 `alert`（P0 实时告警的**内容**推送）分属两个命名空间、绝不复用。但**任何不按 `target_type` 过滤的既有 `push_records` 查询会被污染**——已核实一处：`src/mcp/tools/get-today.ts:71-88` 只按 `push_date + status='success'` 取记录，一条 ops-alert 的 success 行会让 `records.length > 0` ⇒ 不再返回「今日尚未推送」，而返回**空要闻段 + 空产品段**、且 `channels` 被 sink 的通道污染。**MUST 同步给它加 `targetType IN ('event','product')`。**

本变更的告警调用方：`sitemap-date-extraction-zero`（D10 支路 1）、`source-health:<source>`（D10 支路 2 + 既有的 `loc_count=0` throw），并把既有 5 个调用点全部接上同一个 sink——它们今天也一样只进 stderr。

### D10 — 两条告警的判据落点：**都不能建立在「本轮这条链采到了什么」之上**

两条 sitemap 告警的谓词若都读「本轮采集结果」（`collected.items` / 本轮采集统计），则**依赖「谁采的」**——而这会让它们各自以不同的方式失效。

#### 失效一：日期归零告警会被高频链的采集抢跑到永不触发

若 `sitemap` 日后被纳入高频实时链的采集子集，高频链每轮先采走新文并入库 ⇒ **已见集**（`sitemap.ts:485-495`，读 `raw_items WHERE source='sitemap'`，**不分链**）已含该文 ⇒ 08:03 日报链再跑 sitemap 时 `emitted = 0` **每天恒成立** ⇒ 谓词「`emitted > 0 ∧ date_extracted = 0`」**永不触发**——而它守的正是本设计自陈「**永久且不可恢复**」的那个失效。

#### 失效二：窗内候选数根本没有回传管道

`sitemap.ts:551-556` 的计数器只是 `ctx.logError` 的一个**字符串**；`collectSitemaps(): Promise<CollectedItem[]>`；`CollectAllResult.perSource = {ok, count, error}`——**没有任何 per-source 计数器出口**。「零新成本、计数器已在记」这句话对**采集器内部**成立，对**编排层**不成立。而 `emitted = 0` 时 sitemap 一条 item 都没有 ⇒ 编排层只能填 0 ⇒ 该谓词**恒不触发**。

#### 采用：两条谓词各归其位

| 支路 | 判据 | 落点 |
|---|---|---|
| **① 日期提取归零** | **日报链的 DB 复算**（**链无关**）：`SELECT count(*) AS emitted, count(*) FILTER (WHERE published_at IS NOT NULL) AS date_extracted FROM raw_items WHERE source='sitemap' AND fetched_at >= <今日 00:00，按 PUSH_TIMEZONE>`；`emitted > 0 ∧ date_extracted = 0` → 告警（`dedupKey='sitemap-date-extraction-zero'`）| `run-daily-workflow`，**独立的 alert 调用，不经 `classifySystemFailure`** |
| **② 窗内有候选、零发射** | **采集器内直接 throw**（计数器就在那儿）：`window_candidate_count > 0 ∧ emitted_count = 0` → `logError` + **throw 使整源失败**（与既有的 `loc_count = 0` throw **同款**）→ `perSource.ok = false` → 源级健康告警（`dedupKey='source-health:sitemap'`）| `src/collectors/sitemap.ts`，计数器的原地 |

**这个设计的三个收益**（写清，否则后人会「优化」回去）：

1. 支路 1 的判据**不依赖哪条链采的**——DB 里的 `raw_items` 是两条链**共同的事实源**。
2. 支路 2 的判据**不需要任何新的回传管道**——计数器本来就在采集器内部，直接在那里 throw 即可。
3. ⇒ **本轮采集统计结构（`CollectStats`）完全不用扩**：不加 required 字段、`kind` 不扩取值域、「新增的 MUST 只活在 tasks/design 里、进不了主规范」的问题**自动消失**（两条谓词各自落在 `source-collectors` 的 spec delta 里）。

**支路 2 的 throw 不丢弃任何东西**：`emitted_count = 0` 意味着本轮该源**本来就一条都没发射**，throw 丢的是一个空集合——**throw 没有代价**。

#### 支路 2 需要一个真实存在的落点：源级健康告警

**已核实：`perSource` 今天没有任何消费者。** registry 产出 `perSource[source] = {ok:false, …}` 后，只有 `logError` + `console.error`；`run-daily-workflow` **从不读它**。⇒ 主规范里「`loc_count=0` → throw → **计入告警**」这句话**今天就是空的**，支路 2 若只 throw 也照样落空。

**故 MUST 补一条源级健康告警**：日报链对本轮 `perSource.ok = false` 的**每一个源**各发一条（`dedupKey = 'source-health:<source>'`，**per-source**，否则多源同时坏塌成一条）。它同时把既有那句空话变成真的。

## Risks / Trade-offs

- **正则脆性 —— 提取失败是【永久且不可恢复】的**：站点改版（h1 数 ≠ 1 / 日期格式变） → 提取率跌零 → 全部 `null` → **新文一律不推送**（因 D7 不再回落 AI 推断——而对**新公告**推断本就只能返 null，故推送面等价于本变更前）。**但这【不是】「修好正则就恢复」的降级**——把三条各自登记过的决策组合起来：① 失败的 raw_item 照常入库 ⇒ 进【已见集】⇒ **永不重采**（已见集前置过滤 + `ON CONFLICT DO NOTHING`）；② D7 关掉本源的 AI 兜底 ⇒ 回填域不含 sitemap；③ 再没有任何其它写路径会碰 `published_at`。⇒ **这批文章永远不可见，包括一周后把正则修好之后。** 叠加「观测本身是盲的」（没有新文的日子里，「提取率跌零」与「今天没新文」**不可区分**），**一次静默改版 = Anthropic 这条源永久且无声地从产品里消失。**

  **故失败 MUST 响**（不新建重采机制）：谓词为**日报链对 `raw_items` 的 DB 复算**——「今日入库的 sitemap 条目 > 0 且其中 `published_at` 非空者 = 0」→ 经运维告警 sink（D9）告警。**判据 MUST NOT 取自本轮采集结果**（理由见 D10：高频链抢跑会让它每天恒为 0 而永不触发）；**MUST NOT** 塞进 `classifySystemFailure`——后者的入参就是「本轮采集统计」。**只接日报链**——高频链有意不做系统级告警（`alert-scan.ts:334`，防刷屏）。**一个落 stdout 的计数器不是告警。**

  **可选补救（登记，不强制本期做）**：一个**确定性**重提取域——`source='sitemap' AND published_at IS NULL AND first_seen_at > now() - interval '3 days'` 重抓页面、重跑提取器。**MUST NOT 重新交 LLM 猜**（那正是 D7 枪毙的东西）。
- **D7 的代价（诚实登记）**：若某天 Anthropic 站点改版使提取失效，而某篇**老文**恰好在训练记忆里，本变更前的推断会给它一个正确的老日期（随后被时效闸正确挡掉——**净效果为零**）。**关掉推断的实际损失 = 0 条推送**，换到的是「这条源上永不出现一个猜出来的日期」。
- **样板串会变**：Anthropic 改了样板文案 → `isSiteBoilerplate` 失配 → 退回今日行为（三道护栏重新被绕过）。**登记，不加机制**——真变了会在补全/摘要里显形。
- **曾登记、现已不成立的一条**：早前担心「告警链**先摘要** → 日报的『已摘要守卫』永久跳过重生成 ⇒ P0 事件的 `summary_zh` 恒为无补全 grounding 的产物」。**该风险已被 `unify-judge-stage` 的补全内联解决**：补全折进 `scoreUnscoredEvents`（`alert-scan.ts:350`，阶段 3）之后，告警链的链序为 判分/补全 → `selectAlertCandidates`（`:236`，其 LEFT JOIN 在 `:231` 重读 `rawItems.content`）→ `digestEvent`（`:416,426`）⇒ **告警链的摘要拿得到补全后的正文**。故本条不顺延给任何下游变更。

## Migration Plan

1. 代码合并（日期提取 + 样板视同缺失 + 回填域排除 sitemap + `published_at` 权威等级归集 + 运维告警 sink），**CI 单测绿**（含**从线上字节捕获**的真实 fixture、补全侧的样板按失败计单测、权威等级归集单测、告警 sink 限频单测）。**这一步是本变更的权威验收**——见下。
2. 部署。**含一个 forward-only 迁移 `drizzle/0013`**（加 `published_at_authority` 列 + `CHECK` + 回填存量 authority=1；**不含任何写 `published_at` 的语句**，见 D8）。**无一次性数据脚本**（存量不动，见 D6）。
3. **生产核验（人工只读，不入 CI）——只对【部署后新采的文章】有证伪力**：

   ```sql
   -- 新采文章的日期提取
   SELECT left(r.title,40), r.metadata->>'lastmod' AS lastmod, r.published_at::date AS extracted
   FROM raw_items r WHERE r.source='sitemap' AND r.first_seen_at >= '<部署时刻>'
   ORDER BY r.first_seen_at DESC;
   -- 样板写回（任何新增 > 0 即 task 2.3 未生效）
   SELECT count(*) FROM raw_items WHERE source='sitemap'
     AND first_seen_at >= '<部署时刻>'
     AND content LIKE 'Anthropic is an AI safety and research company%';
   ```

   **为什么必须钉 `first_seen_at >= 部署时刻`**：存量 28 行**永不重采**（已见集前置过滤 + `ON CONFLICT DO NOTHING`）、且落回同一批**已评分**事件（`importance_score` 非 NULL ⇒ 永不进补全工作集）⇒ **不带这个谓词的样板 SQL 恒为 0，无论 task 2.3 有没有实现**。**一个恒绿的核验不是核验。**

4. **观察 7 天**（起算点见下）：新文的 `published_at` 是否正确、日报要闻段是否首次出现 Anthropic 新闻。

**观察窗起算点（硬门）**：**CI 单测绿**（权威证伪器）**且**生产 SQL 在观察期内**无新增违反**之后起算 7 天。**MUST NOT** 以「样板 SQL == 0」单独起算——那个 0 可以来自一个真空。

**回滚**：代码回滚（无 env 开关）。**数据一律不动，迁移不回滚**（`published_at_authority` 列留在库里——它 `NOT NULL DEFAULT 0` + `CHECK`，对回滚后的旧代码路径无害；drop 列是不必要的破坏性操作）。存量 `published_at` **绝不清洗**：按 `source='sitemap'` 清回 NULL 会**连那些正确的 AI 推断老日期一起清掉**，而不清的代价为零——代码回滚后不再产生新值，已有值全部出时效窗、且被 fail-closed 的 `is_ai_related` 闸挡住。**故回滚 = 只回代码。**

## Open Questions

- `isSiteBoilerplate` 的判定：硬编码该常量串，还是「与本源其他条目的 `og:description` 逐字相同」的启发式？**首版硬编码**（YAGNI；真变了会在补全里显形）。
- 日期元素的格式是否只有 `Mon D, YYYY`？30 页实测是。若出现其他格式 → 整串匹配失败 → `null` → 安全降级。
