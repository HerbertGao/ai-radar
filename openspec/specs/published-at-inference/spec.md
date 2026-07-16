# published-at-inference 规范

## 目的
待定 - 由变更 fix-push-recency-by-published-at 同步创建。归档后请更新目的。
## 需求
### 需求:缺失发布时间的 AI 语义推断

系统必须提供一个独立能力：对 `ai_news_events.published_at` 为 NULL 的事件，由 Agent 从其代表 raw_item 的可得线索（标题、`canonical_url`、正文/摘要、源标识等）**语义推断**文章发布日期。该能力的定位等同现有 Value Judge 评分 Agent——**只填补 `published_at` 这一语义空缺**，禁止参与「是否够新 / 是否推送」的状态判断（状态与最终过滤由程序和 DB 确定性保障）。

Agent 输出必须为**结构化 JSON 并经 Zod schema 校验**：至少包含「推断出的发布时间」（可为「无法判定」）与可选的置信度/依据。无法判定时必须显式返回「无法判定」，系统据此保持该事件 `published_at` 为 NULL（不得回填臆造时间）。

**推断结果必须经合理范围校验，越界等同「无法判定」（绝不可省）**：推断日期必须满足 `合理下限 <= 推断日期 <= now`——**不接受未来日期**（晚于当前时刻），也不接受荒谬过早日期（早于合理下限，如早于 1990 或早于该源域上线年份）。越界的推断结果必须按「无法判定（NULL）」处理、不得回填。此约束是本能力的命门：若放任未来/荒谬日期回填，`gte(published_at, lowerBound)` 时效闸对未来日期恒为真，会让被推断错的事件**绕过时效闸**，反而放大本提案要堵的漏洞。Zod schema 必须以 refine 表达该范围；回填 SQL 必须再以 `WHERE 推断日期 <= now()` 兜底（双层防御）。

所有外部 LLM 调用必须带**重试与错误日志**。推断调用失败 / 超时必须按「无法判定（NULL）」**降级**处理：不得阻塞或中止整条流水线，**绝不得**把失败误回填为「现在 / 抓取时间 / 任意默认时间」。

推断成功（返回通过范围校验的明确日期）时，系统必须把该日期回填到 `ai_news_events.published_at`，供下游候选窗口的确定性时效过滤使用。

**确定性来源必须优先于 AI（绝不可违背第一架构原则：DB 控事实、不交 LLM）**：AI 推断只是**最后手段**。任一与该事件关联的 `raw_item` 若带确定 `published_at`，该确定值必须优先落库、**禁止**改由 LLM 推断。本变更在去重塌缩层以 identity-preserving 的 `COALESCE` NULL-fill 保证此点（见 `dedup-and-normalization` 的「再次塌缩」MODIFIED：`ON CONFLICT DO UPDATE` 在事件 `published_at IS NULL` 时用后到 `raw_item` 的非 NULL `published_at` 补值，绝不覆盖已设值、不动身份/代表/`first_seen_at`）。因此进入 AI 推断阶段的事件，必是**所有**关联 `raw_item` 均无发布时间者；AI 推断结果绝不得覆盖任何确定来源的值。

**回填必须并发安全：以 DB 层 CAS 保证「不覆盖已非 NULL」（绝不可省）**：日报链与实时告警链是各自独立的定时/触发任务，可能**并发**对同一 NULL `published_at` 事件触发回填。回填写入必须为条件更新 `UPDATE ai_news_events SET published_at = ? WHERE event_id = ? AND published_at IS NULL`（DB 层 compare-and-set）——先写者落值，后写者 `WHERE` 不命中自动空操作，**绝不覆盖**已非 NULL 的值（无论该值来自采集解析、塌缩 COALESCE 还是另一链路的先一步回填）。为避免两链路对同一事件**重复调用 LLM**（浪费 + 配额），推断前必须以**独立的 Redis per-event 单例锁** `published-at-infer:{event_id}` 抢占后再调。该锁**复用** `alert-lock.ts:acquireAlertLock` 的获取/释放语义、并在其外加一层降级（不落库），职责分层须明确：① 获取：`SET key <token> NX PX <ttl>` 原子获取（同 `acquireAlertLock`）；② TTL 必须覆盖「单次推断 + 单次 CAS 写」最坏时长（锁键不含时间，无 TTL 且崩溃未释放会永久死锁该事件回填，故 TTL 不可省）；③ 释放：**调用方**在 `finally` 中经核对 token 的脚本释放（同 `acquireAlertLock` 返回 handle 的 `release()`，由 caller 的 `finally` 调用），防误删他人锁；④ 未抢到锁 → 跳过本事件、由 CAS 兜底正确性；⑤ **Redis 自身异常**（`acquireAlertLock` 在 SET 出错时**会抛**，故新模块必须 try/catch **把该抛错降级**为「跳过本事件回填」、记日志、**不抛断流水线**——这是新模块在 `acquireAlertLock` 之外**额外加的**一层，非 `acquireAlertLock` 本体行为）。**禁止复用评分链的 `judge_claimed_at` 列**：该列条件绑定 `importance_score IS NULL`、语义为「未评分 claim」，而回填发生在评分之后（目标事件 `importance_score` 已非 NULL），复用会与评分 claim 争用同列、语义冲突；且新建 claim 列会与「本期不加列、无 DB 迁移」（design D3）冲突。故回填防重复一律走 Redis 锁、不碰 DB claim 列。

**回填阶段自身的失败（含 DB 写异常）必须降级、不得中止流水线**：回填 CAS 的 **DB 写异常**（连接挂 / 死锁等）与 LLM 调用失败同样必须被 catch、按该事件「未回填」降级处理（遵项目既有「写库异常计降级、不抛」口径，同 Value Judge 评分阶段），绝不冒泡中止 `runDailyWorkflow()` / `runAlertScan()` 的其余阶段。

**回填规模必须受独立上限约束、且不对「注定出窗」的积压做无效推断（绝不可省）**：回填阶段在「选 Top N / 应用单次告警上限」**之前**执行，其作用域由 `should_push=true`（日报）/ 达阈值（告警）+ `published_at IS NULL` 决定，**可能远大于** Top N 条数或单次告警上限——故 Top N / `ALERT_MAX_PER_SCAN` **限不住**回填的 LLM 调用量。系统必须为回填设独立的单次上限（`PUBLISHED_AT_INFERENCE_MAX_PER_RUN`），回填查询须 `ORDER BY first_seen_at DESC LIMIT <上限>`（优先最近首见的），超出者下轮补填。回填作用域还必须加 `first_seen_at >= 时效窗口下界`：`first_seen_at` 已超出时效窗口的存量 NULL 老事件——即便推断出发布时间也必被时效闸排除——不再纳入回填，避免冷启动积压老事件每轮占满 LIMIT 配额、饿死近期 NULL 事件并做无效 LLM 推断。窗口内仍判不出的事件随 `first_seen_at` 滑出窗口自然停止重试（有界，无需持久 attempt 状态列、契合「不加列」）。

#### 场景:对缺失发布时间的事件回填推断结果
- **当** 某事件 `published_at` 为 NULL，且 AI 从标题/URL/正文等线索推断出明确发布日期并通过 schema 校验
- **那么** 系统把推断日期回填到该事件 `published_at`，使其可参与下游基于 `published_at` 的时效窗口过滤

#### 场景:AI 无法判定时保持 NULL
- **当** 某事件 `published_at` 为 NULL，AI 推断后仍无法判定发布时间（显式返回「无法判定」）
- **那么** 系统保持该事件 `published_at` 为 NULL，不回填任何臆造时间；该事件随后在候选窗口中被排除（不推送）

#### 场景:推断调用失败按 NULL 降级且不阻塞流水线
- **当** AI 发布时间推断调用在重试后仍失败或超时
- **那么** 系统记录错误日志，将该事件按「无法判定（NULL）」处理（候选窗口排除），继续执行流水线其余阶段，绝不把失败误当「现在」回填

#### 场景:不覆盖已有发布时间
- **当** 某事件 `published_at` 已为非 NULL（采集阶段已解析得到）
- **那么** 系统不对其调用 AI 推断、不覆盖其既有 `published_at`

#### 场景:推断出未来或荒谬日期按无法判定排除
- **当** AI 推断返回的日期晚于当前时刻（未来日期）或早于合理下限（荒谬过早）
- **那么** 系统按「无法判定（NULL）」处理、不回填该越界日期；Zod refine 与回填 SQL 的 `WHERE 推断日期 <= now()` 兜底共同阻止越界值落库，该事件随后在时效闸被排除

#### 场景:确定性来源优先不调 AI
- **当** 某事件 `published_at` 为 NULL，但有关联 `raw_item` 带确定 `published_at`
- **那么** 系统经塌缩层 `COALESCE` NULL-fill 用该确定值落库、不调 AI 推断；只有当全部关联 `raw_item` 均无发布时间时才进入 AI 推断阶段

#### 场景:并发回填以 Redis 锁防重复 + CAS 防覆盖
- **当** 日报链与告警链并发对同一 NULL `published_at` 事件回填
- **那么** 二者经独立 Redis 单例锁 `published-at-infer:{event_id}` 抢占，仅抢到者调 LLM（不复用 `judge_claimed_at` 列、不与评分 claim 争用）；写入经 `UPDATE ... WHERE published_at IS NULL` CAS，后写者空操作不覆盖

#### 场景:超出时效窗口的积压老事件不做无效推断
- **当** 某 `published_at IS NULL` 事件其 `first_seen_at` 已早于时效窗口下界（推断出来也必被时效闸排除）
- **那么** 该事件不纳入回填作用域，不消耗 LLM 单次上限配额，不饿死窗口内的近期 NULL 事件

#### 场景:Redis 锁未抢到或 Redis 异常时降级跳过
- **当** 回填对某事件未抢到 Redis 单例锁，或 Redis 自身连接异常
- **那么** 系统跳过该事件本轮回填、记日志、不抛断流水线；锁经 TTL 自动释放、`finally` 核对 token 删除，绝不永久死锁该事件回填

#### 场景:回填 DB 写异常降级不中止流水线
- **当** 回填 CAS 的 `UPDATE` 遇 DB 写异常（连接挂 / 死锁等）
- **那么** 系统 catch 该异常、按该事件「未回填」降级处理、记日志，不冒泡中止 `runDailyWorkflow()` / `runAlertScan()` 其余阶段（遵既有「写库异常计降级不抛」口径）

#### 场景:回填规模受独立单次上限约束
- **当** 冷启动存量有大量 `published_at IS NULL` 且 `should_push=true`（或达阈值）的事件，远多于 Top N / 单次告警上限
- **那么** 单轮回填按 `ORDER BY first_seen_at DESC LIMIT PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 只处理最近首见的若干条，超出者下轮补填，不触发一次性 LLM 成本尖峰

### 需求:确定性提取源豁免 AI 发布日推断

系统必须支持**按源关闭** AI 发布日推断：对**已有确定性页面日期提取、且不存在任何页面外日期线索**的源，其事件**禁止**进入本能力的回填域——页面提取失败即 `published_at` 保持 NULL，**不得**转由 LLM 推断。

**首个（且本期唯一）豁免源：`sitemap`**（Anthropic News）。回填候选查询**必须**排除代表 raw_item `source='sitemap'` 的事件。该查询已 `innerJoin raw_items` 并选出 `source`，故落地为一个谓词，**不新增列、不新增 env、不改本能力的通用机制**。

**为何必须豁免（这是本项目第一架构原则的直接推论，不是偏好）**：

- 本能力的推断依据是「代表 raw_item 的可得线索（标题、`canonical_url`、正文/摘要）」。**而 `sitemap` 源这三样全部无日期线索**：URL 为 `/news/<slug>`、标题不含日期、`content` 是全站样板文案（见 source-collectors 的「全站样板 `og:description` 视同缺失」）。⇒ 该源上 Agent 唯一的输入是**模型的训练记忆**。**这是猜，不是推断。**
- 生产实测证实它确实会猜：该源 25 条事件中 **10 条**被推断出了日期，全部是模型认得的老文（如 `Golden Gate Claude → 2024-05-21`）——**而恰恰是我们真正要救的【新公告】（必在训练截止之后）它永远沉默。** 这台机器只认得旧世界。
- **失效模式与「日期子串搜索」完全同构**（后者已被 source-collectors 明令枪毙）：猜错的日期**天然落在合理范围内** ⇒ 本能力的「拒未来值」范围校验挡不住、下游时效窗口挡不住、`ALERT_MIN_PUBLISHED_AT` 基线水位也挡不住（**它们只拒未来值**）⇒ **一篇老文被当成今日突发推送**。确定性提取器被要求「只准干净失败」，LLM **不能**只被要求「读一段 prompt」。
- 正确的降级方向为**「宁可漏，绝不把改版老文洗成今日发布」**：提取失败 ⇒ 无发布日 ⇒ 不推送。

**豁免的边界（禁止扩大化）**：本需求**只**关闭被列入豁免名单的源，**禁止**改动本能力对其余源的任何行为——RSS / Hacker News / arXiv 等源的 URL、标题、正文里**确有**日期线索，推断在那里是**有依据的语义补全**，其既有约束（范围校验、Redis 锁、CAS 回填、单次上限、时效窗口下界）**全部不变**。

**存量不回滚**：豁免生效前已由 AI 推断写入的 `published_at` 值**保持原样**，**禁止**批量清回 NULL——该列不区分值的来源（页面提取 / AI 推断），按源清洗会连同**正确的**存量推断值一起清掉；而保留它们的代价为零（一律出时效窗口、且被下游 fail-closed 的过滤闸排除）。

**回填值的权威等级 MUST 为 1（非页面提取档）**：本能力的 CAS 回填在写 `published_at` 的同时 MUST 把 `published_at_authority` 置 **1**——它既不能留在 0（会破坏不变量 `(published_at IS NULL) = (authority = 0)`、被 DB `CHECK` 拒绝），也**不是**一个「最低档」：**1 是与 rss `pubDate` / hacker_news 与 show_hn 的投稿时刻 / github 的 push 时刻【同一档】的等级，档内互不覆盖（先到者胜出）**。**两级非空**的取值域（0 无日期 / 1 非页面提取 / 2 页面确定性提取）与归集口径以 dedup-and-normalization「基于 dedup_key 的硬去重塌缩」为权威。

**MUST NOT 把本能力的推断值排到程序取得的时间戳【之下】**（即 MUST NOT 在第 1 档内部再排序）：该阶梯排的是「**这个值离【文章的发布日】有多近**」，**不是**「这个时间戳的来源有多可信」。HN 的投稿时刻是一个**真实**的时间戳，但它测的是**错误的事件**（谁在何时把链接贴上 HN）；本能力的推断是**猜**的，但它猜的是**正确的事件**（文章何时发布）——**对错误事物的精确测量，比对正确事物的粗略估计更坏**。若让程序时间戳覆盖推断值：一篇 2023 年的老文（其发布日已被本能力**正确**推断出）在被发上 HN 的当天，`published_at` 会被改写成**今天** ⇒ 过时效闸 ⇒ 当成今日重大发布推出去，直接违反 `policy-push-timeliness`。**「一个 LLM 猜出来的日期会永久挡住一个真实的时间戳」这条反对意见据此被驳回**：它挡住的不是「真相」，是**另一个近似值**。

#### 场景:回填值标为非页面提取档（1），只被页面提取取代
- **当** 本能力对某非豁免源事件 CAS 回填出一个推断日期
- **那么** 写 `published_at` 的同时把 `published_at_authority` 置 **1**（非页面提取档）；此后同 `dedup_key` 的 raw_item 带来 HN 投稿时刻 / rss `pubDate` / github push 时刻（**亦为 1**）时**不覆盖**（`1 > 1` 不成立，先到者胜出 = 引入该列之前的行为，零回归）；**只有**页面确定性提取的发布日（authority = 2）才取代它。**绝不可**把程序取得的时间戳排到推断值之上——那些时间戳测的是**投稿 / push**、不是**发表**，让它们覆盖一个已被正确推断出的老文发布日，会把老文的日期推成今天

#### 场景:豁免源的 NULL 事件不进回填域
- **当** 某事件 `published_at` 为 NULL、其代表 raw_item 的 `source` 在豁免名单内（本期：`sitemap`）
- **那么** 回填候选查询**不返回**该事件——不调用推断 Agent（不耗配额）、不占用 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 名额、`published_at` 保持 NULL，该事件随后被下游时效闸正确排除（不推送）

#### 场景:非豁免源不受影响
- **当** 某事件 `published_at` 为 NULL、其代表 raw_item 的 `source` 不在豁免名单内（如 `rss` / `hackernews` / `arxiv`）
- **那么** 该事件照常进入回填域，按本能力既有的全部约束（范围校验、Redis 单例锁、CAS 不覆盖、单次上限、时效窗口下界）执行 AI 推断——**豁免绝不可扩大为对本能力通用机制的削弱**

