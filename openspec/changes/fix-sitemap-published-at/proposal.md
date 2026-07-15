## Why

**未来每一篇 Anthropic 官方新公告都会被我们采集、判分，然后静默丢弃**——因为它拿不到发布日。这是一条 live bug，且**它的损害在未来、不在存量**。

**存量救不回来，本变更 MUST NOT 拿存量给自己背书。** 生产实测（2026-07-13）：

| | |
|---|---|
| 采集到的 Anthropic 官方新闻事件 | **25 条** |
| 其中 `should_push = true` | **21 条**（最高 `importance = 88`） |
| **曾被推送成功的** | **0 条** |
| 那 21 条里 `is_ai_related` 为 **NULL** 的 | **21 条（全部）** |

这 21 条被**两把锁**永久锁死，**与 `published_at` 修得多正确无关**：

1. **`is_ai_related` 全为 NULL**（该列的写路径 2026-07-10 才上线，此前评分的事件一律 NULL），而日报要闻闸 `top-n.ts:269` 是 `eq(is_ai_related, true)`——**fail-closed**，`false` 与 `NULL` 一律排除；而判分工作集按 `importance_score IS NULL` 取（`score-events.ts:196`）⇒ 这些事件**永不重判** ⇒ `is_ai_related` **永远是 NULL**。**日报侧与 P0 侧双向永久不可见。**
2. 它们的真实发布日是 2023-09 / 2024-05 / 2026-07 等，**即便提取出正确日期也一律出 3 天时效窗**（这是**正确**的，守 `policy-push-timeliness`）。

⇒ **存量的可挽回价值 = 0。本变更的全部真实收益是【未来新文】（约 1–2 篇/天）。**

### 根因一：新公告的 `published_at` 拿不到值，而 AI 推断在这个源上结构性失败

`sitemap` 采集器**从不提取页面日期**（既有决策：`lastmod` ≠ 发布时间，交 `published-at-inference` 推断）。但该源**不提供任何 AI 可用的日期线索**：

- URL 无日期（`/news/claude-opus-4-launch`）；
- 标题无日期；
- `og:description` **是全站样板文案**（见根因二）；
- **而新公告必在模型训练截止之后**。

而推断 Agent 的 prompt 明令「无把握则返回 null、**绝不猜 now、绝不编造日期**」。→ **对新公告，合规的模型只能返回 null** → `published_at` 保持 NULL → 被 `top-n.ts` / `alert-scan.ts` 的每一道时效闸排除。

> **`published_at` 并非恒 NULL——恰恰相反，这才是更危险的一半**：生产实测 25 条里 **10 条已有值**，全部是**推断 Agent 从训练记忆里报出的老文日期**（`Golden Gate Claude → 2024-05-21`，**而且是对的**）。即：**AI 推断只对它「已经知道」的老文有效**，而**新公告**恰恰是它不可能知道的那些。这条源上的 AI 推断是一台「只认得旧世界」的机器——对我们真正要救的那一半永远沉默，对我们不需要的那一半凭训练记忆开口。**它是猜，不是提取**（见「根因三」）。

**但真实发布日一直印在页面上。** 实测 **30 个** live `/news/` 页面：

| 事实 | 实测 |
|---|---|
| `<h1>` 数量 == 1 | **30 / 30** |
| `</h1>` 后**紧邻元素整串匹配**日期（`Mon D, YYYY`） | **30 / 30** |
| `og:title` 文本 == `<h1>` 文本 | **18 / 30** ← **不可作锚点** |

而采集器**已经在下载那张 HTML**（取 `og:title` / `og:description`），只是**从未去取那个日期**。

### 根因二：`og:description` 是样板文案，且它**非空** —— 三道护栏被构造性绕过

实测 14 篇最新 `/news/`：**6 篇**的 `og:description` 逐字相同：

> `Anthropic is an AI safety and research company that's working to build reliable, interpretable, and steerable AI systems.`

该常量串直接落进 `raw_items.content`。**因为它非空**，三道本该保护我们的闸全部失效：

| 护栏 | 为什么失效 |
|---|---|
| **摘要防幻觉护栏**（`agents/digest`：`hasContent = Boolean(content?.trim())`） | 样板非空 → `hasContent=true` → 「无正文不编造」的护栏**不触发** → LLM 拿着「正文：Anthropic is an AI safety and research company…」去给 `Claude's extended thinking` 写摘要。**比「无正文」更糟**——无正文会触发护栏，样板则理直气壮地把无关内容当 grounding |
| **正文补全工作集**（`content-enrichment`：`content IS NULL OR content !~ '\S'`） | 样板非空 → 这些行**永久排除在补全域外**（主规范甚至明文祝福了这件事：「已有正文（如 …**sitemap 已抓**）保持不变」） |
| **语义合并灰区判**（`semantic-judge`：`if (input.contentA) parts.push('Content: …')`） | **两篇不同的** Anthropic 文章，双方 `Content:` 是**同一个字符串** → 系统性推高「同一事件」判定 → **误并成 tombstone**（`semantic-dedup` 自己称过合并为「危险方向」，其「空文本兜底」只测 `trim()===''`，**常量非空样板整个漏过**） |

叠加：KB 的 `long_term_value`（≥70 准入闸）与 entities 也基于样板生成，**而 KB 是持久存储**。

### 根因三：这个源上的 AI 推断兜底，正是本变更花整节论证要杀死的东西

本变更的第一条论证是：页面上的**错误日期天然落在合理范围内** ⇒ 范围校验 / 时效窗口 / 基线水位**一道都挡不住** ⇒ 老文被当今日突发。故子串搜索被枪毙、正则被要求「**只准干净失败**」。

**这段话逐字适用于 `published-at-inference` 自己**：它在本源上的唯一信息来源是**模型的训练记忆**（该源无 URL / 标题 / 正文日期线索），它的全部防线也只有一道「拒未来值」的范围校验 + 一段 prompt。**同一份设计里，正则被要求「只准干净失败」，LLM 却只被要求「读一段 prompt」——同一个失效模式，两套标准。**

⇒ **本变更给 sitemap 源关掉 AI 推断兜底**：页面日期提取失败 ⇒ `published_at = NULL`，且该事件**不进 `published-at-inference` 的回填域**。宁可漏，绝不把一个从训练记忆里猜出来的日期当精确事实用。（**只关这一个源，不动推断能力的通用机制**——其余源的 URL / 标题 / 正文里确有日期线索，推断在那里是有依据的语义补全，不是猜。）

### 根因四：`published_at` 的「先到者永久胜出」让页面提取【死于到达】

塌缩的 `published_at` 归集是**单向 NULL-fill**（`COALESCE(已有, EXCLUDED)`，`collapse.ts:162`；`semantic-dedup` 主规范的合并处是**第二个副本**）——**已设值绝不被覆盖**。而各源写入 `published_at` 的语义**并不等价**：`hacker_news` 是**投稿到 HN 的时刻**、`rss` 是 feed 的 `pubDate`（可能是重新生成/转载时刻）、`github` 是仓库 `pushed_at`——全是**近似值**；而本变更新增的**页面提取**是**全系统唯一一个**「文章自己印的发布日」。

生产实测三条 Anthropic 官宣，事件的 `published_at` **全部来自 HN 的投稿时刻**（`fable-mythos-access` / `introducing-claude-tag` / `claude-sonnet-5`；`fable-mythos-access` 的 RSS 日期**被 `COALESCE` 丢弃**——HN 先到、值已非 NULL）。⇒ **本变更落地后，sitemap 精确提取的发布日会在【每一篇上了 HN 的文章】上被同一个 `COALESCE` 丢弃**。而上 HN 的恰恰是重大模型发布——**P0 车道存在的全部理由**。**本变更对它最想服务的那批文章是死的。**

**修法（收窄且确定）**：新增 `ai_news_events.published_at_authority smallint`，归集口径改为「**权威等级高者胜出**」+ `GREATEST`；不变量 `(published_at IS NULL) = (published_at_authority = 0)` 由 `CHECK` 兜底，使 **NULL-fill 成为该口径的一个特例**（authority=0 < 任何非空来者）。塌缩与语义合并**两处**同口径（只改一处 = 修一半）。

**等级 MUST 为两级非空——第 1 档内部 MUST NOT 再排序**：

```
0 = 无日期
1 = 一切【不是页面确定性提取】的日期值
    （rss 的 pubDate / hacker_news 与 show_hn 的投稿时刻 / github 的 push 时刻 / AI 推断）
    —— 【同档互不覆盖】，先到者胜出 = 与引入本列之前完全一致的行为，零回归
2 = 页面确定性提取的发布日（sitemap 从文章 HTML 抽取的、文章自己印的那个日期）—— 覆盖一切
```

**这个阶梯排的是「离【文章的发布日】有多近」，不是「时间戳的来源有多可信」。** `hacker_news` 的 `item.time` 是**投稿到 HN 的时刻**——**真实**的时间戳，但它测的是**错误的事件**（投稿，不是发表）；`show_hn` 的 `created_at_i`、`github` 的 `pushed_at` 同理；`rss` 的 `pubDate` 是 feed **声明**值（转载/重生成会漂）。而 **AI 推断是【猜】的，但它猜的是【正确的事件】**（发表）。⇒ **对错误事物的精确测量，比对正确事物的粗略估计更坏。**

**「程序 > LLM」的四级阶梯（0/1 LLM/2 程序/3 页面）是错的，且是【相对现状的净回归】**——它按「谁不是 LLM」排，而不是按「谁更接近发布日」排。`sitemap.ts:535` 明写「置 null、走既有 published-at-inference 推断真实发布日」⇒ **sitemap 那一族文章的日期按设计就住在第 1 档**（生产实测：28 个 sitemap 事件里 10 个有日期，其 `raw_item.published_at` **全为 NULL** ⇒ 那 10 个日期**全部来自 AI 回填**）。于是四级阶梯下：

```
1. sitemap 采到 anthropic.com/news/x   → published_at=NULL, authority=0
2. AI 回填推断出【真实发布日】(2023)   → authority=1
3. 同一 URL 被发上 HN → 同 dedup_key ⇒ 塌缩
   → EXCLUDED.authority=2 > 1 ⇒ published_at := 【HN 投稿时刻】= 今天
⇒ 2023 年的老文 published_at 变成今天 ⇒ 过时效闸 ⇒ 当成今日重大发布推出去
⇒ 直接违反 policy-push-timeliness
```

**而引入本列【之前】的 `COALESCE(已有, 来者)` 单向 NULL-fill 会保住第 2 步的真日期。** 「一个 LLM 猜出来的日期会永久挡住一个真实的时间戳」（四级阶梯的原始理由）**被驳回**：那个「真实的时间戳」测的是**投稿 / push**，不是**发表**——它挡住的不是「真相」，是**另一个近似值**；而放它进来的代价是把老文推成今日突发。**只有页面提取有资格覆盖**——它读的是文章自己印的日期，**结构上不可能让老文看起来新**。

**MUST NOT 引入「rss / sitemap 比 hacker_news 权威」的源级排序**：实测 HN 与 RSS 不一致的事件 `off_days` **大多是负的**（HN 比 RSS **更早**，最多差 12 天）——**哪个是真发布日，数据里根本没有**。按「rss > hn」清洗会把 `published_at` 往**后**推 ⇒ **让老文看起来更新** ⇒ 正是本变更要防的方向。**存量 `published_at` 一行不动**（迁移只加列 + 回填 **authority=1**「非页面提取」——页面确定性提取这条采集路径**在本变更之前根本不存在**，故存量的一切非空值必然落在第 1 档，回填 1 是**精确的**；**MUST NOT 回填 2**，那会给存量行一个它们没有的覆盖权、使后到的真页面提取值因「同档不覆盖」被丢弃）。

**迁移语句顺序 MUST 钉死**：`ADD COLUMN` → `UPDATE` 回填 → **最后**才 `ADD CONSTRAINT ... CHECK`。drizzle-kit 会把 `ADD COLUMN` 与 `ADD CONSTRAINT` 一起吐出、而手工插 `UPDATE` 的自然位置是文件末尾 ⇒ 「先加 CHECK 再回填」⇒ 存量每一行「有日期但等级为 0」全部违反 ⇒ **迁移 abort、容器起不来**。**空库 CI 恒绿——只在生产炸。**

### 根因五：本仓没有告警出口 —— 所有「MUST 告警」都是空的

`run-daily-workflow.ts:136` 的 `defaultAlert = (msg, detail) => console.error('[pipeline][ALERT] …')`，而 `worker.ts` **不传 alert** ⇒ **生产用的就是它**。规范反复建立的「`logError` 不是告警 / `classifySystemFailure` 才是」——**在代码里是同一个 `console.error`，只差一个前缀**。本变更「日期提取归零 MUST 告警」若接进它，等于**把一个落 stdout 的计数器接进另一条 stderr**。

**修法**：新增运维告警 sink（`createOpsAlertSink`），经既有 sender 落**真实通道**；**限频状态住进 DB 的 `UNIQUE(target_type, target_id, channel, push_date)`**（`target_type='ops-alert'`、`target_id=dedupKey`、`ON CONFLICT DO NOTHING` 命中 0 行即当天已告过 → 不发）。零新状态（进程内 Map 会在 redeploy 复位 ⇒「今天已告过 / 连续 N 轮」永不达标 ⇒ 静默不告警）、跨进程 / 跨重启 / 跨两条链自动去重、幂等由 DB 唯一约束保障（第一架构原则）。**注入点是 worker 实际调用的 `run(ctx)`**（`run-daily-workflow.ts:1118`，自称「生产默认补齐 DI」）——**不是** `runDailyWorkflow`（worker 根本不经过它）。

**⚠️ 引入 sink 反而会把【4 条既有告警】变成静默——必须同时收窄 detail**：`run-daily-workflow.ts` 有 **5 个** `alert()` 调用点，其中 **4 个不带 `dedupKey`**（源陈旧度 `:531` / judge 熔断 `:641` / digest 熔断 `:783` / 租约已失 `:980`）。sink 契约是「`dedupKey = detail.dedupKey`」，而 `push_records.target_id` 是 **`varchar(128) NOT NULL`** ⇒ `target_id = undefined` ⇒ **NOT NULL 违反** ⇒ 被 sink 自己的 best-effort catch 吞掉 ⇒ **这 4 条告警连 stderr 都不再有**（今天至少还进 stderr），而 sink 的单测（都传 `dedupKey`）**全绿**。

故：① `AlertSink` 的 detail **MUST 收窄为必填 `dedupKey`**（`interface AlertDetail { dedupKey: string; [k: string]: unknown }`）——**枚举必漏、编译器不漏**，收窄会逼出全部 5 个调用点；② 逐个分配 key（`source-staleness:<source>` **per-source** / `degrade-abort:value-judge` / `degrade-abort:digest` / `digest-lease-lost`）；③ `AlertSink` MUST 可返回 `Promise<void>` 且 5 个调用点 MUST **`await`**——sink 全是异步 IO，而其中三个调用点**紧接着就 throw**，不 await 则告警是个游离 Promise、job 已失败 ⇒ **投递零完成保证**；④ **`push_date` MUST 用 `dateInTimeZone(now, PUSH_TIMEZONE)`（`Asia/Shanghai`）、MUST NOT 用 UTC 日**——**UTC 日界 = 08:00 CST，而日报链恰在 08:03 CST 跑**，用 UTC 日会让高频链 07:49 的告警落 `D-1`、日报链落 `D` ⇒ 唯一键不冲突 ⇒ **「跨两条链自动去重」当场为假、持续故障期天天双响**；⑤ **发送失败 MUST NOT 占用当日限频名额**（否则一次发送失败 = 该告警当天彻底哑火）；⑥ **通道取「已配置通道全集」**，未配置任何通道时回落 `console.error` 且 **MUST NOT 写 `push_records` 行**（否则限频键把「没通道」也算成「今天已告过」）。

### 根因六：两条告警的判据若建立在「本轮采到了什么」之上，则各自失效

已核实的第三种改版形态：`loc_count > 0`（sitemap 本身健康、**不 throw**）+ 文章 URL 改版致 per-article fetch 全 404（`sitemap.ts:546` 逐篇 `continue`、不拖垮该源）⇒ `emitted = 0` ⇒ 日期归零告警**按定义不触发** ⇒ **整源静默死亡、零告警**；且这些文章**从不入库** ⇒ **不进已见集** ⇒ **每轮重抓一遍**。

而两条告警的谓词若都读「本轮采集结果」，则**依赖「谁采的」**，各自以不同方式失效：

- **日期归零告警会被高频链抢跑到永不触发**：`sitemap` 若被纳入高频实时链的采集子集，高频链每 15 分钟先采走新文并入库 ⇒ 已见集（`sitemap.ts:485-495`，读 `raw_items WHERE source='sitemap'`，**不分链**）已含该文 ⇒ 日报链跑 sitemap 时 `emitted = 0` **每天恒成立** ⇒ 「`emitted > 0 ∧ date_extracted = 0`」**永不触发**——而它守的正是本变更自陈「**永久且不可恢复**」的那个失效。
- **窗内候选数根本没有回传管道**：`sitemap.ts:551-556` 的计数器只是 `ctx.logError` 的一个**字符串**；`collectSitemaps(): Promise<CollectedItem[]>`；`CollectAllResult.perSource = {ok, count, error}`——**没有任何 per-source 计数器出口**。

**修法（两条谓词各归其位）**：

| 支路 | 判据 | 落点 |
|---|---|---|
| **① 日期提取归零** | **日报链的 DB 复算**（**链无关**）：今日入库的 sitemap 条目 > 0 且其中 `published_at` 非空者 = 0 → 告警（`dedupKey='sitemap-date-extraction-zero'`）| `run-daily-workflow`，**独立的 alert 调用，不经 `classifySystemFailure`** |
| **② 窗内有候选、零发射** | **采集器内直接 throw**（计数器就在那儿）：`window_candidate_count > 0 ∧ emitted_count = 0` → `logError` + **throw 使整源失败**（与既有 `loc_count = 0` 的 throw 同款）→ `perSource.ok = false` → 源级健康告警（`dedupKey='source-health:<source>'`）| `src/collectors/sitemap.ts`，计数器的原地 |

**三个收益**：① 支路 1 的判据**不依赖哪条链采的**——`raw_items` 是两条链共同的事实源；② 支路 2 **不需要任何新的回传管道**——计数器本来就在采集器内部；③ ⇒ **本轮采集统计结构（`CollectStats`）完全不用扩**（不加 required 字段、`kind` 不扩取值域），且两条谓词都落在 spec delta 里、归档后不会凭空消失。

**支路 2 的 throw 不丢弃任何东西**：`emitted_count = 0` 意味着本轮**本来就一条都没发射**，throw 丢的是空集合——**throw 没有代价**。

**支路 2 需要一个真实存在的落点**：已核实 **`perSource` 今天没有任何消费者**（registry 产出后只有 `logError` + `console.error`，`run-daily-workflow` 从不读它）⇒ 主规范里「`loc_count=0` → throw → **计入告警**」这句话**今天就是空的**。故 MUST 补一条**源级健康告警**：日报链对本轮 `perSource.ok = false` 的**每一个源**各发一条（`dedupKey='source-health:<source>'`，**per-source**）。它同时把那句既有的空话变成真的。

## What Changes

- **`published_at` 由页面**确定性提取**产出**（程序判定，**不经 LLM**——符合第一架构原则「精确事实由程序与 DB 保障」）：
  - **锚定**：MUST 要求**文档中有且仅有一个 `<h1>`**（实测 30/30），取其后**紧邻元素**。**MUST NOT 用「`og:title` 文本相等」作锚点**——实测仅 18/30 成立，会**丢弃 40% 有日期的页面**。h1 数量 ≠ 1 → `null`（干净失败；站点日后加 nav / 卡片 h1 时，正是这条守住）。
  - **整串全匹配**：对该元素的文本做 `^\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*$`。**MUST NOT 做子串搜索**——子串搜索的失败模式**不是「找不到」，是「找到错的」**（`By Jane · Mar 2, 2025 · 5 min` 照样被抠出日期、`Updated Jan 5, 2024` 会抠出**修订日**），而**页面上的错误日期天然在范围内** → 范围校验 / 时效窗口 / 基线水位**一道都挡不住**（它们只拒未来值）→ **老文被当今日突发**。**整串全匹配把「提取到错的」变成「什么都没提取到」——脏失败转干净失败。**
  - **解析口径**：`Jul 9, 2026` **无时区** → MUST 用 `Date.UTC(y, m, d)` 显式构造 UTC 零点，**MUST NOT** `new Date(str)`（V8 按**运行时本地时区**解析非 ISO 串 → 容器 TZ 变化会让下游时效窗口边界漂 ≤1 天）。合理下限取常量 **`2015-01-01`**。
  - **提取失败 / 越界 → `null`，且【不回落 AI 推断】**（见「根因三」）：本源的推断只能靠训练记忆猜，与被枪毙的子串搜索是同一个失效模式。**降级方向 = 无日期 = 不推送**（宁可漏）。
  - **ReDoS**：定位 `<h1>` MUST 沿用本文件既有范式（`indexOf` 线性切块 + **有界 slice** 再跑锚定正则）。该文件的 `parseSitemap` **正是为此从 lazy-capture 重写成 `indexOf`**（实测 1MB 未闭合 `<url>` → 29s，而 body 上限是 5MB）。

- **全站样板 `og:description` 视同缺失 —— 采集器与正文补全【两处】，共享同一个 `isSiteBoilerplate` 判定**：
  - 采集器：`content = isSiteBoilerplate(og) ? null : og`。
  - **正文补全：写回前判样板，命中则按抓取失败计（`content` 保持 `null`）。只改采集器是不够的——补全会把它写回来**：采集器置 null 的行**恰因此**进入补全工作集（`EMPTY_CONTENT`），补全重抓**同一张页面**、`extractOgTag` 拿回**同一段样板**——**它非空，是 `extractOgTag` 的成功路径**（`content-enrichment.ts:289` 抽 og → `:299` 原样写回，零样板感知）→ `content` 变回样板 → 三道护栏原样恢复被绕过的状态。
  - **单一定义、两处引用**（`content-enrichment.ts` 本就从 `sitemap.ts` import `extractOgTag` / `MAX_BODY_BYTES`）。**MUST NOT 两处各写一份**——必然漂移。
  - 两处都落地后，三条路一次修好：摘要走「无正文」护栏、补全不再把样板写成该 raw_item 的**终身正文**（写回后 `content` 非空 ⇒ 该行永久离开补全工作集）、语义合并不再拿同一串比对。
  - **顺序 MUST**：`isSiteBoilerplate` MUST 在 M-1 双缺检查（`ogTitle === null && ogDescription === null`，一个 **AND**）**之后**作用于 `og:description`，条目照常发射（仅 `content=null`）。**MUST NOT 反序**——先置 null 再判双缺，会把「缺 `og:title` + 样板 `og:description`」的页面从「发射 slug-title 条目」翻成「整篇跳过」。

- **`published-at-inference` 增设一条 source 级豁免**：回填域 MUST 排除代表 raw_item `source='sitemap'` 的事件（该查询已 `innerJoin raw_items` 并选出 `source`，落地是一个谓词）。**通用机制不动。**

- **`published_at` 归集改为「权威等级高者胜出」**（根因四）：新增 `ai_news_events.published_at_authority`（**两级非空**：0 无日期 / 1 一切非页面提取的日期值（rss / hn / show_hn / github / AI 推断，**同档互不覆盖**）/ 2 页面确定性提取），塌缩（含 tombstone 改投分支）与语义合并**同口径**；第 1 档内部行为零变化；**存量 `published_at` 一行不动**。塌缩的 raw_item 视图 MUST 新增**必填** `source`（推导 authority 的唯一依据；写成可选 ⇒ sitemap 恒推导为第 1 档 ⇒ **整个变更对「上了 HN 的重大发布」是 no-op**，而测试全绿）。「是否页面提取源」的判定 MUST 用 `Object.hasOwn(...)` + `=== true`（`in` 与 truthy **都走原型链** ⇒ `toString` / `constructor` 等键会**既不告警、又拿到覆盖权**）。
- **运维告警 sink**（根因五）：`AlertSink` 接真实通道、detail 收窄为**必填 `dedupKey`**、可返回 `Promise` 且调用点 `await`，限频状态住进 `push_records` 的唯一约束（`target_type='ops-alert'`、`push_date` 用 `Asia/Shanghai` 日）；注入点是 `run(ctx)`。
- **两条告警的判据各归其位**（根因六）：日期归零走**日报链的 DB 复算**（链无关）、窗内零发射走**采集器内 throw** → 源级健康告警。**`CollectStats` 完全不动。**

- **存量【不动】**：不重采、不删 raw_items、不回填、**不清洗 `published_at`**。存量是死行（见 Why 的双重锁），而清 `raw_items` 会**悬垂事件层的 `representative_raw_item_id`**（裸 bigint、零外键，塌缩层的 `onConflictDoUpdate.set` 明文禁止覆盖代表），换来的仍是一批被 `is_ai_related` fail-closed 闸挡死、且一律出时效窗的死行。提取器的正确性由**线上字节 fixture 的单测**证明（tasks 3.1），不靠重采。
  （**注**：根因四把 `published_at` 从「单向 NULL-fill」改为「权威高者胜出」后，**重采不再会丢弃新提取的页面日期**——但那从来不是唯一理由，可挽回价值仍然是 0，故结论不变。）

- **`lastmod` 仍绝不作为发布日来源、亦绝不作为推断线索**（既有红线不变）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `source-collectors`（「sitemap 增量采集」）：① `published_at` 由**页面确定性提取**产出（锚定唯一 h1 + 整串全匹配 + UTC 解析 + 下限 2015-01-01 + ReDoS 有界定位）；提取失败 → `null`，**且不回落 AI 推断**（本源豁免，见下）。② 全站样板 `og:description` **视同缺失**（`content=null`）。③ `lastmod` 红线不变。
- `published-at-inference`（新增一条 source 级豁免需求）：回填域 MUST 排除代表 raw_item `source='sitemap'` 的事件。**该源无任何页面外日期线索**（URL / 标题 / 正文皆无），推断只能从模型训练记忆里猜——与本变更枪毙的「子串搜索」是**同一个失效模式**（错误日期天然在合理范围内 ⇒ 范围校验 / 时效窗口 / 基线水位一道都挡不住）。**通用推断机制不变**（其余源不受影响）。
- `source-content-enrichment`（「判分与摘要前的确定性正文补全」）：补全的正文来源同为 `og:description` 且**零样板感知**——采集器置 null 的行**恰因此**进入补全工作集，补全重抓同一张页面拿回同一段样板，**非空即成功路径 → 原样写回**，把 `content` 变回样板。故补全 MUST 在**写回之前**把已知全站样板**视同缺失**（**按抓取失败计**、`content` 保持 `null`、不写回），并**与采集器共享同一个 `isSiteBoilerplate` 判定**（单一定义、两处引用，MUST NOT 各写一份）。
- `semantic-dedup`（**两条需求**）：
  - 「事件 embedding 生成」：「空文本兜底」只测 `trim()===''`，**常量非空样板按构造整个漏过** → 两篇不同文章的 embedding 文本共享同一段 `content` 摘录、灰区 LLM 的两侧 `Content:` 亦为同一串 → 系统性推高相似度、过合并。登记「上游把样板视同缺失」为本能力反过合并保证的**前置条件**（语义层不自行识别样板、也捕获不到非空样板）。
  - 「确定性事件合并」：`published_at = COALESCE(存活, 被吞)` 是「先到者胜出」的**第二个副本**（存活者按 `first_seen_at` 定，与「谁的日期更精确」毫无关系）→ 改为「权威等级高者胜出 + `GREATEST`」，与硬去重塌缩同口径。**只改塌缩不改这里 = 修一半。**
- `dedup-and-normalization`（「基于 dedup_key 的硬去重塌缩」）：`published_at` 归集由无条件单向 NULL-fill（`COALESCE(已有, EXCLUDED)`，**先到者永久胜出**）改为**权威等级高者胜出**（`published_at_authority` **两级非空**：0 无日期 / 1 一切非页面提取的日期值 / 2 页面确定性提取；`GREATEST` 归集；authority 由 `raw_items.source` 推导，**不给 `raw_items` 加列**）。**该阶梯排的是「离文章发布日有多近」，不是「时间戳来源有多可信」**——HN 的投稿时刻是真实时间戳但测的是**错误的事件**，AI 推断是猜的但猜的是**正确的事件**；**MUST NOT 在第 1 档内部再排序**（任何档内排序都会引入一条能把日期**往后推**的覆盖关系 ⇒ 老文被推成今日突发）。不变量 `(published_at IS NULL) = (authority = 0)` 使 **NULL-fill 成为该口径的特例**；**同档不覆盖** ⇒ 第 1 档内部行为零变化；**页面提取（2）> 一切**是唯一新增的覆盖关系。塌缩的 raw_item 视图 MUST 新增**必填** `source`、候选 SELECT MUST 投影它；页面提取源的判定 MUST 用 `Object.hasOwn(...)` + `=== true`（防原型链键窃取覆盖权）；**tombstone 改投分支今天完全不写 `published_at`**（而它是那条 raw_item 的唯一写入路径）⇒ 签名 MUST 加 `publishedAt` + `authority` 两参、同口径归集。下游 CAS 回填须同置 authority=1（与 rss / hn / github **同档**）。
- `platform-foundation`（**两条 ADDED 需求**）：
  - 「published_at 权威等级列可迁移」：forward-only 迁移加 `ai_news_events.published_at_authority smallint NOT NULL DEFAULT 0` + 回填存量 **authority=1**（页面提取这条采集路径在本变更之前不存在 ⇒ 存量的一切非空值必然落在第 1 档；**MUST NOT 回填 2**，那会给存量行一个它们没有的覆盖权）+ **最后**加 `CHECK` 兜底不变量（**语句顺序钉死**：CHECK 先于回填 ⇒ 存量全违反 ⇒ 迁移 abort，而空库 CI 恒绿）；**MUST NOT 触碰任何一行 `published_at`**（HN 与 RSS 不一致时真值未知，清洗等于瞎猜且方向错了会让老文看起来更新）。该 `CHECK` 会打挂 14 处既有测试 seed（fail-loud，方向正确但**须纳入工作量**）。
  - 「运维告警落真实通道并由 DB 唯一约束限频」：`AlertSink` 的生产实现今天就是 `console.error`（注入点不传）⇒ 规范里所有「MUST 告警」都是空的。新增 `createOpsAlertSink`（经既有 sender 落真实通道，限频状态住进 `push_records` 的 `UNIQUE(target_type='ops-alert', target_id=dedupKey, channel, push_date)`）；detail 收窄为**必填 `dedupKey`**、可返回 `Promise` 且调用点 `await`；`push_date` 用 `Asia/Shanghai` 日；发送失败不占当日名额；无通道时不写 `push_records`；**注入点是 `run(ctx)`**。新 `target_type` 的必然代价：不按 `target_type` 过滤的既有 `push_records` 查询（MCP 的「今日已推送」）MUST 同步加 `target_type IN ('event','product')`。

## 非目标

- **不碰 P0 车道**（`ALERT_SCAN_ENABLED` 保持 `false`）——本变更的风险敞口仅限「日报里多/少几条」，**绝不会震手机**。P0 实时告警车道属**另一系列变更**，其开闸决策应**看着本变更落地后 7 天的真实日期分布**来做（该观察窗须在样板修复两处均落地后重新计时，见 tasks 5.6）。
- **不改 `REALTIME_NEWS_SOURCES`**（sitemap 进实时子集属 P0 变更的范围）。
- **不用 `lastmod` 当发布日或推断线索。**
- **不引入 HTML 解析库 / 无头浏览器**（既有红线）。
- 不动推送幂等、去重分层、时效窗口口径、时间源。

## Impact

- **代码**：`src/collectors/sitemap.ts`（页面日期提取 + 样板 `og:description` 视同缺失 + 导出共享的 `isSiteBoilerplate` + **「窗内有候选零发射」时 throw**）；`src/pipeline/content-enrichment.ts`（写回前判样板，命中按失败计）；`src/agents/published-at-inference/backfill.ts`（回填域排除 `source='sitemap'`——该查询已 `innerJoin raw_items` 并选出 `source`；CAS 回填同置 `published_at_authority=1`）；`src/dedup/collapse.ts`（`RawItemForCollapse` 加**必填** `source`、候选 SELECT 投影 `source`、`published_at` 归集改「权威高者胜出」、`rerouteToSurvivor` 加 `publishedAt`+`authority` 两参）+ 语义合并的第二个副本；`src/db/schema.ts`（`published_at_authority` 列）；`src/pipeline/run-daily-workflow.ts`（`AlertSink` 收窄为必填 `dedupKey` + 可返回 `Promise`、5 个既有调用点各配 `dedupKey` 并 `await`、日期归零的 **DB 复算**告警、**源级健康告警**读 `perSource`、`run(ctx)` 注入 sink）；**新增运维告警 sink** + `src/push/targets.ts`（`target_type` 扩 `ops-alert`）+ `src/mcp/tools/get-today.ts`（加 `target_type IN ('event','product')` 谓词）；14 处测试 seed 改写 `(published_at, published_at_authority)` 二元组。**`src/pipeline/circuit-breaker.ts` 完全不动**（`CollectStats` / `SystemFailureVerdict` 不扩）。**无一次性数据脚本。**
- **迁移**：`drizzle/0013_*.sql`（forward-only），**语句顺序钉死**——① `ADD COLUMN ai_news_events.published_at_authority smallint NOT NULL DEFAULT 0` → ② `UPDATE ... SET published_at_authority = 1 WHERE published_at IS NOT NULL` → ③ **最后** `ADD CONSTRAINT ... CHECK ((published_at IS NULL) = (published_at_authority = 0))`。**CHECK 排在回填之前会让存量每一行当场违反约束、迁移 abort、容器起不来（空库 CI 恒绿，只在生产炸）。迁移中 MUST NOT 出现任何写 `published_at` 的语句。**
- **行为变化（用户可见）**：
  - **【未来新文】的 Anthropic 官方新闻首次具备进入日报要闻段的资格**（约 1–2 篇/天）。推送成功者随后进入 KB。
  - **存量 25 条【一条也救不回来】，且本变更不去救**：① 那 21 条 `should_push=true` 的事件 `is_ai_related` **全为 NULL**，被日报要闻闸 `top-n.ts:269`（`eq(is_ai_related, true)`，fail-closed）排除，而判分按 `importance_score IS NULL` 取工作集 ⇒ **永不重判 ⇒ 永远 NULL**；② 它们的真实发布日是 2023-09 / 2024-05 / 2026-07 等，**即便拿到正确日期也一律出 3 天时效窗**（这是**正确**的，守 `policy-push-timeliness`）。**本变更 MUST NOT 用「存量会被救活」为自己背书。**
  - **sitemap 事件不再拿到 AI 推断的日期**：今日那 10 条靠训练记忆推断出的老文日期是**存量**，不受影响（不回填、不清除）；**新事件**若页面提取失败则 `published_at` 保持 NULL（不推送）。**该失败【永久且不可恢复】**：失败的 raw_item 照常进已见集 ⇒ **永不重采**，回填域又已排除本源 ⇒ 没有任何写路径会再碰它的 `published_at`——**这些文章永远不可见，包括正则修好之后**。故 MUST 有一条**日报链对 `raw_items` 的 DB 复算**告警（今日入库的 sitemap 条目 > 0 且其中带日期者 = 0），**MUST NOT** 把判据建在「本轮这条链采到了什么」之上（会被高频链抢跑到永不触发，见根因六）——否则一次静默改版 = 这条源永久且无声地消失。
  - 样板 `og:description` 视同缺失后：这些条目的摘要走「无正文不编造」护栏（**只出 headline、不编内容**）；它们重新进入正文补全工作集；语义合并不再因同一串样板而误并。
- **不受影响**：P0 车道（`ALERT_SCAN_ENABLED` 未开）；`published-at-inference` 对**其余源**的通用行为。
- **Model Radar 会被扩面（MUST 登记）**：其事件复核的候选闸是**裸 `published_at` 闭区间**（无 source / importance / `is_ai_related` 闸）——sitemap 事件今天靠 `published_at IS NULL` 被**结构性排除**，日期转真值后会落进其复核窗口。**门控 `MR_EVENT_REVIEW_ENABLED` 默认关、当前无 live 影响，但该门开启前 MUST 重新评估**（其 `REVIEW_TRIGGER_KEYWORDS` 命中面极宽，且重放会重开已 resolve 的 plan）。
