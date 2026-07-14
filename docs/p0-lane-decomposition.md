# P0 车道：已验证的事实与量级基线

> **状态**：决策已定，实现在三个 OpenSpec 变更里。
> **实现的权威文档是变更本身**：`openspec/changes/{fix-sitemap-published-at,unify-judge-stage,p0-alert-lane}`（**必须按此顺序归档**）。
> **不要照本文重做提案**——下面列的修复在三个变更里已全部落地。本文只留它们不含的东西：**可复算 SQL 与生产量级基线**。
> 数字为 2026-07-13 生产实测（`ai-radar-postgres-1` on ts.mac-mini，只读 SELECT）。

## 变更 × capability

| 变更 | 改动的 capability |
|---|---|
| `fix-sitemap-published-at` | `source-collectors` / `source-content-enrichment` / `semantic-dedup` |
| `unify-judge-stage` | `daily-intel-pipeline` / `source-content-enrichment` / `value-judge-agent` |
| `p0-alert-lane` | `realtime-alerts` / `feishu-push` / `source-collectors` / `published-at-inference` / `model-radar-ingestion` / `conversational-rag` |

`p0-alert-lane` 是三合一（旧 `enable-p0-lane` + `sitemap-into-realtime` + `fact-change-alert-branch`）。**为何合并**：`realtime-alerts` 的实时告警需求约 200 行；`openspec-cn` 的 MODIFIED 是**整条替换**、归档守卫**只比场景名不比正文** ⇒ 碰它的每一环都得整条重抄，**静默回滚已真实发生过一次**。规则见 `openspec/config.yaml` 的「归档纪律」。部署序列（三源开闸 → 第四源 → 支路 B）由该变更的 tasks 分阶段兑现，不再拆成多个变更。

## 结论（每条自带 `file:line`，自己重跑）

**F1 — 补全会把全站样板 `og:description` 原样写回 `content`**（`src/pipeline/content-enrichment.ts:289,299`，零样板感知）。空 content 是**诚实降级**（`src/agents/digest/index.ts:94` 的 `hasContent` 防幻觉护栏触发）；样板 content 是**构造性欺骗**（护栏不触发、语义合并拿同一串比对、样板进 KB 不可撤）。三道下游闸对「空」的极性都对，对「非空但错」一道都没有。⇒ 正确性 bug，阻断一切。

**F2 — 补全工作集是判分工作集的真子集**（`content-enrichment.ts:263-278` ⊂ `src/agents/value-judge/score-events.ts:196`，同键于 `importance_score IS NULL`）。评分一生一次 ⇒ 只要告警链先判分，日报链的补全阶段就**永久空转**。招牌用例是 hacker_news（`src/collectors/hacker-news.ts:73` content 恒 NULL，30 天 838 事件），**不是** sitemap 的 25 条。

**F3 — `judge_claimed_at` 结构化不了「先补全再判分」**（`score-events.ts:115-126` 是**互斥量**，不是 happens-before：其 claim 条件在「正在补全」期间恒为真）。唯一结构化手段是**组合**——补全内联进 `scoreUnscoredEvents` 开头，让工作集的拥有者同时拥有它的前置。

**F4 — sitemap 今天就有告警资格**。它今天就在 `buildRegistry`（`src/collectors/index.ts:162`），日报链每天全量采；而 `selectAlertCandidates`（`src/pipeline/alert-scan.ts:236-258`）**没有 source 谓词**，`REALTIME_NEWS_SOURCES` 只裁剪**采集**（`alert-scan.ts:336`）。⇒ 把 sitemap 加进实时子集买到的只是**采集延迟压缩**（≤24h → ≤20min），**不是**告警资格。

**F5 — 支路 A 会推非 AI 新闻**（最重要的发现）。它的闸只有 `importance >= 阈值`，而 importance 衡量「多重要」、不是「是不是 AI 新闻」——两根轴正交。实测高分非 AI 命中：KVM 逃逸 CVE / 合成活细胞 / Linux LUKS bug / 土卫六探测器 / PID 控制器。日报没推它们**是判对了**（要闻闸带 `eq(is_ai_related, true)`，`src/selection/top-n.ts:269`）。⇒ 支路 A **必须**加 `is_ai_related = true` 闸（`= true`，**不是** `IS NOT FALSE`；fail-closed，与 top-n 同极性）。

**F6 — 但 AI 闸是【尾部保险】，不是高频过滤器**。干净日实测拦截率 **0/11**（三个干净日累计；07-10 是 1/14）。**流传的「24.3%」测的是 `should_push`，不是 `is_ai_related`**——那 6 条样本里 5 条是 `is_ai_related = NULL`（该列 2026-07-10 才上线，历史产物，**不会重演**），挡住它们的是 fail-closed 对 NULL 的排除。**任何用 24.3% 给 AI 闸背书的说法都是错的**；闸仍要加，理由是 F5 的极性正确性，不是拦截量。
```sql
-- AI 闸的真实拦截率（上线前该跑而没人跑的那条）
SELECT count(*) FILTER (WHERE is_ai_related IS FALSE) AS blocked, count(*) AS total
FROM ai_news_events
WHERE merged_into IS NULL AND importance_score >= <threshold>
  AND first_seen_at >= date '2026-07-11';   -- 该列全天生效之后
```

## 量级基线（可复算）

```sql
-- 支路 A 会告警的量。分子分母必须【同域】：is_ai_related 列 2026-07-10 上线，
-- 只统计它已全天生效的日子（首个干净日 = 2026-07-11）——否则分子按【评分时钟】删失、
-- 分母按【采集时钟】测量，跑出来的 0.70 条/天是个假数。
SELECT count(*) AS total,
       round(count(*)::numeric / (max(first_seen_at)::date - min(first_seen_at)::date + 1), 2) AS per_day
FROM ai_news_events e
WHERE e.merged_into IS NULL AND e.importance_score >= <threshold> AND e.is_ai_related IS TRUE
  AND e.first_seen_at >= date '2026-07-11'
  AND e.published_at IS NOT NULL AND e.published_at <= now()
  AND e.published_at >= e.first_seen_at - interval '3 days';
```
> 这条时效闸是**逐行相对**窗口，而代码里的真闸是**墙钟**窗口（`startOfDayInTimeZone`），且 SQL 省略了 Model B 反连接与基线水位 ⇒ **它是「会告警」的上界，不是闸的逐字复刻。**

| 量 | 值 | 说明 |
|---|---|---|
| 支路 A 稳态 | **3.67 条/天** | 07-11(4) + 07-12(4) + 07-13(3) 三个干净日，**n=3**。07-10 是回填日（14 条，混合了列上线前后两批评分），**排除** |
| 支路 A 不带 AI 闸（30 天窗） | 115 条 / 30 天 = **3.83 条/天** | 无删失，自洽 |
| 支路 B | **≤ 1 条 / 30 天** | 词表本身不带闸也只命中 1 条，**未被删失**，是成立的上界 |
| 日方差 | **极差 [3, 4]，约 1.3×** | **不是 3.5×**——那个数来自 07-10 的 14 条，而 07-10 已因回填被排除出均值。**一天不能既被剔出均值、又用来算方差。** 真实日间波动很小 ⇒ 7 天窗 ≈ **26 条**，量级回滚判据**有统计功效** |
| AI 闸拦截率（干净日） | **0 拦 / 11 过** | 三个干净日累计。与 F6 一致：**尾部保险，不是高频过滤器** |

## F7 —— `published_at` 的「先到者胜出」，让页面提取死于到达

塌缩（`src/dedup/collapse.ts:162`）与语义合并（`semantic-dedup` 规范）都用单向 NULL-fill：`COALESCE(已有, 来者)` ⇒ **已设值绝不被覆盖**。而各源的 `published_at` 语义**没有一个是文章发布日**：

| 源 | 值的真实语义 | 是发布日 |
|---|---|---|
| `hacker_news`（`hacker-news.ts:74`） | **投稿到 HN 的时刻** | ❌ |
| `rss`（`rss.ts:135`） | feed 的 `pubDate`（可能是重新生成/转载时刻） | ❌ |
| `github`（`github.ts:119`） | 仓库 push 时刻 | ❌ |
| sitemap 的 `lastmod` | 站点最后修改（重渲染会刷新） | ❌ |
| **sitemap 的【页面提取】** | **文章页面上自己印的日期** | ✅ **全系统唯一** |

⇒ HN 总是先到（持续轮询，官宣几分钟内上榜），故它的**投稿时刻**永久占住 `published_at`；后到的、更准的日期一律丢弃。实测三条 Anthropic 官宣全部如此：

```sql
-- 同一 canonical_url 被多源采到时，事件的 published_at 来自谁
SELECT substring(r.canonical_url from 'news/(.*)$') AS slug, r.source AS representative,
       e.published_at,
       (SELECT string_agg(r2.source||'='||COALESCE(r2.published_at::text,'NULL'), ' | ' ORDER BY r2.source)
          FROM raw_items r2 WHERE r2.canonical_url = r.canonical_url) AS all_source_dates
FROM ai_news_events e JOIN raw_items r ON r.id = e.representative_raw_item_id
WHERE e.source_count > 1 AND r.canonical_url LIKE '%anthropic.com/news/%';
```
```
fable-mythos-access     hacker_news  2026-06-13 00:51:30   hn=00:51:30 | rss=03:33:10 | sitemap=NULL
introducing-claude-tag  hacker_news  2026-06-23 17:09:18   hn=17:09:18 | sitemap=NULL
claude-sonnet-5         hacker_news  2026-06-30 17:59:52   hn=17:59:52 | sitemap=NULL
```

⇒ 修法是 `published_at_authority` **两级非空**（0 无 / 1 一切非页面确定性提取的值：rss 的 pubDate、hacker_news 与 show_hn 的投稿时刻、github 的 push 时刻、AI 推断 / 2 页面确定性提取的发布日：sitemap 从文章 HTML 抽取的、文章自己印的日期），塌缩与语义合并均改「权威高者胜出 + `GREATEST`」。不变量 `(published_at IS NULL) = (authority = 0)` 使 **NULL-fill 成为该口径的特例**，同档不覆盖 ⇒ 非页面提取源之间维持先到者胜出、行为零变化。

> **这个阶梯排的是「值离【文章的发布日】有多近」，不是「时间戳的来源有多可信」**：HN 的投稿时刻是**真实**时间戳，但测的是**错误的事件**；LLM 的推断是**猜的**，但猜的是**正确的事件**。对错误事物的精确测量，比对正确事物的粗略估计更坏 ⇒ 二者同档、互不覆盖。**MUST NOT 在第 1 档内部再排序**：任何档内排序都会引入一条能把日期**往后推**的覆盖关系（如让 rss 转载时的今日 pubDate 覆盖 LLM 正确推断出的 2023 年发布日）⇒ 老文又看起来是新的。页面提取读的是文章自己印的日期，结构上不可能让老文看起来新——故只有它有资格覆盖。

> **一条【不要做】的事**：MUST NOT 引入「rss/sitemap 比 hacker_news 权威」的**源级排序**。实测那 5 条 HN 与 RSS 不一致的事件，`off_days` **大多是负的**（HN 比 RSS **更早**，最大 -12 天）——**哪个是真发布日，数据里没有**。按「rss > hn」去修，会把 `published_at` 往**后**推、**让老文看起来更新**，正是要防的方向。**存量 `published_at` 一行都不许动。**

## 三条推翻过判断的实测（都很短，都值得重跑）

```sql
-- ① 支路 B 的【真实】命中长什么样（决定否定词表怎么写）
SELECT representative_title, importance_score, is_ai_related, should_push
FROM ai_news_events WHERE merged_into IS NULL
  AND (lower(representative_title) LIKE '%rate limit%'
    OR lower(representative_title) LIKE '%限流%');
```
30 天全语料只有 **2 条**，且**一条 `rate limiter` 工具帖都没有**。真命中是
`Improved Batch Inference API: … and 3000× Rate Limit Increase` ——**Title Case**。
⇒ 支路 B 的 SQL 谓词**两侧都必须 `lower()`**（正向有、否定漏掉就恒不触发）；
⇒ 否定项收 `rate limiter`（器物名）**但 MUST NOT 收 `rate limiting`**（公告常用动名词，会漏掉真变更）。

```sql
-- ② 开闸时的未评分积压（决定告警侧判分预算 N 会不会被积压吃满）
SELECT count(*) FROM ai_news_events WHERE importance_score IS NULL AND merged_into IS NULL;
```
= **0**。日报链持续排空，闸开在**空工作集**上 ⇒ 「冷启动积压吃满预算」不成立。

```sql
-- ③ ORDER BY first_seen_at DESC 的 NULLS FIRST 地雷是活的还是休眠的
SELECT count(*) FILTER (WHERE first_seen_at IS NULL) FROM ai_news_events WHERE merged_into IS NULL;
```
= **0 / 3698**（列**可空**、PG 的 `DESC` 默认 `NULLS FIRST`）⇒ **休眠地雷**：一旦出现一行 NULL，它恒排队首、每轮吃掉一个预算名额且**永不老化**。⇒ MUST 写 `DESC NULLS LAST`（仓里他处已是此写法）。

## 决定排序的那条 SQL（已跑，结论出人意料）

支路 A 的 115 条，买的是**覆盖**还是**延迟**？
```sql
SELECT count(*) AS total, count(*) FILTER (WHERE p.id IS NULL) AS never_pushed
FROM ai_news_events e
LEFT JOIN push_records p ON p.target_id = e.event_id AND p.status = 'success'
WHERE e.merged_into IS NULL AND e.importance_score >= <threshold>
  AND e.published_at > now() - interval '90 days';
```
**实测 `total=115` / `never_pushed=40` ⇒ 覆盖增量 34.8%。** 按旧判据这该读作「日报确实在漏重大发布 ⇒ 赶紧开 P0」。**那是错的读法**——去看那 40 条的**内容**（F5）：它们是高 importance 的**非 AI** 新闻，日报没推不是「漏」，是判对了。

⇒ 真正的动作不是「赶紧开 P0」，而是「先给支路 A 加 `is_ai_related` 闸」。

> **教训**：一个只看条数、不看内容的门限判据，会把「下游正确地过滤掉了噪音」读成「下游在漏东西」。**任何 `never_pushed / total` 型判据都必须配一句「逐条看标题」**，否则它会把你推向反方向。
