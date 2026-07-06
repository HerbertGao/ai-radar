## 为什么

生产每日日报出现两类可复现问题，二者同一根因：

- **要闻混入非 AI 内容**：如 `Qualcomm Linux 2.0`（嵌入式 Linux 发行版，dev=90）、`Physical disc production ending … PlayStation`（游戏发行，dev=85）被当要闻推送；「新品」段更彻底——Product Hunt / Show HN 产品**完全不过价值判断**，扫雷游戏、通用日志库照推。
- **简介明显错误**：如 `Claude Sonnet 5` 的摘要断言「Anthropic 尚未发布 Claude Sonnet 5，最新为 Claude 3.5」、`Leanstral 1.5` 摘要脑补出「256K 上下文 / HumanEval +12~18%」整套不存在的参数。

根因（生产库实锤：这些条目 `raw_items.content` 长度全为 0）：**链接帖只有标题 + URL，全流程从不抓取正文**（仅 Anthropic sitemap 一个采集器抓 og:description）。于是——

1. Value Judge **只拿标题**打分，`should_push` / `importance` 信号质量低；且它**已经算出的 `is_ai_related` 布尔被 `mapping.ts` 直接丢弃**、落库与 `selectTopN` 从不据此过滤。
2. 摘要器同样**只拿标题**，无原文时用**过期的训练知识**填空——于是把真实新发布纠正成「不存在」、把产品脑补出整页假规格。
3. 产品段绕过判分，**无任何 AI 相关性闸门**。

现在修：因为这是每天推给用户、正在损害情报可信度的正确性缺陷，且 `is_ai_related` 本是模型现成输出、丢弃它纯属浪费。

## 变更内容

三处止血，共享「先抓正文再判分/摘要 + 用好已有 AI 相关性判定」一条主线：

1. **不再丢弃 `is_ai_related`，并据此闸门要闻**：Value Judge 输出的 `is_ai_related` 落库到 `ai_news_events` 新列；`selectTopN` 候选窗口新增 `is_ai_related = true`。非 AI 要闻不再进日报。
2. **判分/摘要前补抓正文（治本，同修错误简介）**：新增确定性正文补全步骤——对代表 raw_item 「`content` 为空且有可抓 URL」的链接帖，复用 `extractOgTag` 与 sitemap 的校验逻辑抓 og:description/正文写回 `raw_items.content`，**但抓取须走带 SSRF 出网守卫的受控 fetch（`redirect:'manual'`/逐跳 host 重校验），不裸调 `defaultFetchArticle` 随访**（提交者可控 URL，见 §影响 / spec）；Value Judge 与摘要器改为**吃到正文 + 来源**。补抓 best-effort、逐条隔离、永不拖垮流水线。
3. **摘要器加「无正文不编造」硬护栏**：正文缺失/稀薄时，摘要器**只依据标题概括**，禁止编造标题未出现的版本/参数/发布状态，**禁止基于训练知识断言产品是否存在**（注入当前日期抵消陈旧知识）。这是补抓失败时对错误简介的兜底。
4. **产品段补 AI 相关性闸门（名判，不经补抓）**：复用产品已有的中文化 LLM 调用（`product-chinese-digest` 的 `summarizeProduct`）**同一次调用**扩产 `is_ai_related`，经产品持久化（`updateProductZh`）落 `ai_products` 新列；`selectProductCandidates` 最终推送候选新增 `is_ai_related = true`。**产品按名判定 + 采集器已存正文（若有），不经步骤 2 补抓**——步骤 2 只作用于新闻事件代表 raw_item 且运行在产品塌缩之前（产品行此时不存在），产品无补抓 grounding 路径；无正文时按名判定并受与新闻同类的「不编造 + 注入当前日期 + 不据训练知识断言存在」护栏。判定工作集须取自「AI 闸门之前」的候选集且以 `is_ai_related IS NULL` 纳入（防死锁，见 design D5）；`assertProductZhColumns` 启动探针扩展断言新列存在（防缺列静默假绿）。非 AI 产品不再进新品段。

### 非目标（明确不做）

- **不把确定性状态交给 LLM**：是否 AI 相关由 LLM **语义判定**并落库为**事实**，但推送名单/幂等/去重/排序仍由程序 + DB 唯一约束保障（与第一架构原则一致）；`is_ai_related` 只作候选**过滤谓词**，不改 `selectTopN` / `selectProductCandidates` 的排序、幂等、跨天不重推口径。
- **不做全文正文抽取/可读性解析**：正文补全只取 og:description（或有限正文），复用既有 `defaultFetchArticle` 的 5MB/content-type 防护；不引 readability/jsdom 等新依赖。
- **不改语义去重阈值、不改 Model Radar、不动推送状态机与幂等四元组**。
- **不追溯回填历史事件的 `is_ai_related`**：闸门只作用于候选窗口内（近 N 天、未全投递）的事件；历史老事件不重判、不重推。
- **不新增采集源、不启用 browser egress**。
- **不改实时告警链（`alert-scan`）**：告警链与日报共用 `scoreUnscoredEvents`（一生一次评分）但**本期不前置补全**（告警先判的事件得到仅标题 `is_ai_related`，日报补全无法回灌），且告警推送候选**本期不加 `is_ai_related` 闸门**。本变更只硬化**日报**要闻/新品段；告警链的 grounding 缺口与非 AI 事件经告警泄漏属独立后续，如需另起提案（对告警候选加同一 fail-closed 闸门或告警链前置补全）。
- **产品不做正文补抓 grounding**：产品判定为**名判**（+ 采集器已存正文），不引入产品侧 enrichment（产品行在补全阶段尚不存在）。
- **新闻侧不加 `is_ai_related` 重判路径**：迁移落列后已评分但 `is_ai_related` NULL 的事件不自动重判（守「不追溯回填」），接受其 fail-closed 排除（含窗口内未投递全通道者），必要时人工重置 `importance_score=NULL` 触发。

## 功能 (Capabilities)

### 新增功能
- `source-content-enrichment`: 判分/摘要前对「`content` 为空且有可抓 URL」的代表 raw_item 补抓正文（复用 `extractOgTag` + sitemap 的 size/content-type/timeout 校验逻辑，**抓取走带 SSRF 出网守卫的受控 fetch，不裸调 `defaultFetchArticle`**），best-effort、逐条 try/catch 隔离、绝不覆盖已有非空 content、绝不拖垮流水线；为 Value Judge 与摘要器提供 grounding。

### 修改功能
- `value-judge-agent`: 落库 `is_ai_related` 到 `ai_news_events`（映射 + UPDATE set 补该列）；判分输入由「仅标题」改为「标题 + 正文 + 来源」（吃补抓后的 `content`）。
- `daily-intel-pipeline`: 流水线在判分之前运行正文补全步骤；`selectTopN` 候选窗口新增 `is_ai_related = true` 谓词（非 AI 事件不入选）。
- `chinese-digest-agent`: 摘要器消费补抓正文；正文缺失/稀薄时加「无正文不编造 + 不据训练知识断言发布事实 + 注入当前日期」护栏，防幻觉简介。
- `product-discovery`: 产品经 `product-chinese-digest` 的 `summarizeProduct` 同调用扩产 `is_ai_related`，经 `updateProductZh`（`set` 补该列、COALESCE 保留既有译名）落库；`selectProductCandidates` 参数化 AI 闸门（`applyAiGate`，判定工作集取 `false` 无闸门集、以 `is_ai_related IS NULL` 纳入防死锁，最终推送候选取 `true` 加 `eq(is_ai_related,true)`），非 AI 产品不进新品段（不改 merge_conflict 排除 / 跨天不重推 / order / limit 口径）；`assertProductZhColumns` 探针扩断言新列。

## 影响

- **数据模型（一次 forward-only 迁移，next=0011）**：`ai_news_events` + `is_ai_related boolean`（可空，NULL=未判/不推）；`ai_products` + `is_ai_related boolean`（可空）。`src/db/schema.ts` 补两列。
- **代码**：新增正文补全模块（`src/pipeline/` 或 `src/collectors/` 复用 sitemap 导出，**含 SSRF 出网守卫**——`defaultFetchArticle` 无 host/IP 守卫，须自加私网/环回/链路本地/元数据拒绝 + 跳转处理）；`src/agents/value-judge/{mapping.ts,score-events.ts}`（落 is_ai_related；`score-events` 候选 SELECT 须 left join `raw_items` 载入 content/source，非仅改签名）；`src/selection/top-n.ts`（加 `eq(is_ai_related,true)` 谓词）；`src/agents/digest/index.ts`（prompt 护栏 + 日期注入）；`src/agents/product-digest/{index.ts,schema.ts}`（扩产 is_ai_related）+ **`src/agents/product-digest/persistence.ts`（`updateProductZh` 补 `isAiRelated` 入参与 `set`、COALESCE 保译名）**；`src/pipeline/product-digest.ts`（`selectProductCandidates` 参数化 `applyAiGate`、工作集谓词改 `is_ai_related IS NULL`、call-site 透传 is_ai_related、**`assertProductZhColumns` 扩断言两列**）；`src/pipeline/run-daily-workflow.ts`（在语义合并后判分前插补全步骤、`loadCanonicalUrls`/`forDigest` 须加载并透传 content/source 给 digest）。
- **不变量对齐**：所有 Agent 输出仍走 Zod 校验；补抓外部调用带 timeout/重试语义与错误日志 + **SSRF 出网守卫**（提交者可控 URL 非一方 URL）；产品段失败隔离、不进新闻熔断分母的既有契约不变；`is_ai_related` 仅作候选过滤谓词、不触排序/幂等（确定性不变量守住）。
- **可观测**：补抓命中/失败计数（失败含被 SSRF 守卫拒绝数）、被 `is_ai_related`（false 或 NULL）过滤掉的要闻/产品计数，随日报日志暴露。
