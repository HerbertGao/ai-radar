## MODIFIED Requirements

### 需求:重大发布事件级实时告警

系统必须提供一条独立于每日日报的实时告警路径：当一个**已完成 Value Judge 评分**的事件满足告警闸时，比每日 08:xx 日报更早推送告警。判定必须由**确定性程序规则**决定，禁止由 LLM 决定是否触发告警。

**告警闸为「已评分 ∧ AI 相关」两项共用前提下的两条并列确定性支路（本需求修改点）**：

```
importance_score IS NOT NULL                                   -- ① 已评分：两支路共用前提，绝不可省
AND is_ai_related = true                                       -- ② AI 闸：两支路共用，fail-closed
AND (
      importance_score >= ALERT_IMPORTANCE_THRESHOLD           -- ③ 支路 A：重要性
   OR representative_title 命中「精确事实变更词表」              -- ④ 支路 B：纯标题谓词
)
```

**①「已评分」MUST 在 OR 之外（绝不可省），但它只保证「Judge 跑过」、不保证「Judge 认可」**：若写成 `(importance_score IS NOT NULL AND 支路A) OR 支路B`，则**评分失败 / claim 被日报链抢走 / LLM 降级**（`importance_score` 留 NULL）的事件，只要标题命中词表就**直接被推 P0**——绕过 Value Judge 阶段本身。极端情况：LLM 当轮全挂，所有含 `pricing` 的采集条目直接进推送。

**②「AI 闸」同为两支路共用前提，MUST 在 OR 之外（绝不可省）**：`is_ai_related = true` 是**两条支路共同的噪音下限**。两支路各自需要它的理由不同，但结论相同：

- **支路 A**：`importance_score` 衡量的是「这条新闻**有多重要**」，**不是「这是不是一条 AI 新闻」**——两根轴正交，高 importance **不蕴含** AI 相关。生产语料中的 KVM 客户机逃逸 CVE（`importance=95`）、从头合成的活细胞（95）、Linux LUKS 磁盘加密 bug（92）、癌症研究、土卫六探测器、PID 控制器——全是 Hacker News 头版的高 importance **非 AI** 新闻。日报正确地没推它们（其要闻闸带 `eq(is_ai_related, true)`）；无本闸，支路 A 会把它们全推到手机上。
- **支路 B**：**无 importance 地板**，一条与 AI 无关的随机 SaaS「Introducing our new pricing」帖只要标题命中词表就会被推送。

**极性 MUST 为 `= true`（fail-closed），MUST NOT 写成 `IS NOT FALSE`（绝不可省）**：`false` 与 `NULL` **一律排除**，与日报要闻闸 `eq(is_ai_related, true)` **同极性**（见 daily-intel-pipeline 的 Top N 选择；产品段亦为「`= true`，false/NULL 一律排除（宁可漏也不推非 AI）」）。

**本闸的实测拦截率极低——它是一道【尾部保险】，不是一道高频过滤器（诚实登记，MUST NOT 被夸大）**：在 `is_ai_related` 列**全天生效**的三个干净日（2026-07-11 / 07-12 / 07-13），支路 A 的 **11** 条候选里 `is_ai_related IS FALSE` 的为 **0 条**（**0 拦 / 11 过**；07-10 回填日挡掉 1/14）。**系统 MUST NOT 用任何「高频拦截率」的数字给本闸背书**——尤其 MUST NOT 引用「候选中 24.3% 被判为 `should_push = false`」这一数字：它测的是 **`should_push`**，不是 `is_ai_related`；其抽样中多数事件的 `is_ai_related` 为 **NULL**（该列写路径 2026-07-10 上线，此前评分的一律 NULL），被挡住靠的是 fail-closed 对 NULL 的排除，而**这一情形不会重演**。本闸仍 MUST 加：它 fail-closed、与日报要闻闸同极性，且生产语料中存在 `should_push = true ∧ is_ai_related = false` 的真样本，正说明 Judge 的分类维度是有效的——本闸挡的是**尾部**的高分非 AI 新闻，而尾部事件一旦命中就是一次手机震动。

**`NULL` 是历史遗留、不是「未判定」（登记 fail-closed 的召回代价）**：该列的写路径于 2026-07-10 上线，此后每条已评分事件都有值。存量 `NULL` 事件的 `published_at` 早已落在时效窗口之外、两条支路本就够不着它们——故 `= true` **零召回损失**，而 `IS NOT FALSE` 只会把一批不可能告警的历史事件放进谓词。

> **不构成「NULL 永不判分」的死锁**：Value Judge 的判分工作集按 `importance_score IS NULL` 选取、**不带** `is_ai_related` 闸，故该列为 NULL 的新事件照常被判分并写入该列；本闸只作用于**判分之后**的告警候选谓词与回填域。（产品链曾踩过「用 AI 闸门取判定工作集 → NULL 永不判分 → 永久 NULL」的死锁，其教训是「判定工作集须无闸门取」——本能力不重蹈。）

> **诚实边界（MUST 明写，不得含糊）**：**两条支路都不带 `should_push`**——「已评分」**不等于**「Judge 认可推送」。AI 闸与 `should_push` **性质不同**：`is_ai_related` 判的是「**这条是不是 AI 领域的事**」，`should_push` 判的是「**这条值不值得推**」。系统 MUST NOT 声称任一支路保留了 Judge 的 `should_push` 把关，亦 MUST NOT 以「已加 AI 闸」为由暗示 Judge 的价值判断仍在闸内。

**③ 支路 A** 语义不变：默认阈值 `importance_score >= 85`（严于日报候选 `should_push` 的 `importance >= 75` 与 Top N 下限闸 `>= 60`——实时门槛应更高以防告警刷屏），阈值经环境配置可调。**实测稳态量级 ≈ 3.67 条/天**（`is_ai_related` 列全天生效后的三个干净日：07-11 = **4** / 07-12 = **4** / 07-13 = **3**；**样本 n=3，MUST 标注**）；不带 AI 闸的 30 天窗为 **3.83 条/天**。**日间波动窄**：干净日极差 **[3, 4]**，约 **1.3×** ⇒ 以量级为准的回滚判据（≈ **26 条 / 7 天**）**有功效**，能区分信号与噪音。**此前登记的「日方差 3.5 倍」是错的，MUST NOT 再被引用**：它来自 **07-10**——而 07-10 是**回填日**、**已被排除出稳态均值**。**一天不能既被剔出均值、又用来算方差**（那是拿一个被判定为「不属于该分布」的点去度量该分布的离散度）。

**④ 支路 B（新增）**：事件的 `representative_title` 命中**精确事实变更词表**（价格 / 额度 / 限流 / 弃用；词表核心与 conversational-rag「价格/选型确定性前置闸」共享，其词表常量（四组 + 共现）的穷举表在该能力，是唯一 SOT）即取得告警资格，**不论其 `importance_score` 高低**。动因：厂商的额度 / 限流 / 定价 / 弃用变更直接决定开发者当日的用法与成本决策，但其 `importance_score` 天然低于重大发布阈值（非模型发布、非融资），单靠支路 A 对该类事件**结构性失明**。**实测量级 ≤ 1 条 / 30 天**（离线回放的成立上界）。

**④ 支路 B MUST NOT 附加 `should_push = true`（绝不可省的反向要求）**：`should_push` 是 Value Judge 的语义布尔——而**支路 B 存在的全部意义，正是推翻 Judge 对该类事件的低估**。生产实测：30 天生产语料内唯一一条经支路 B 命中的事件（「GPT-5.6 一发布，Claude 终于舍得重置 Fable 5 额度了」，`importance=30`、`is_ai_related=true`）其 **`should_push = false`**。若把 `should_push = true` 纳入支路 B，该支路将**恒为空**——等于把它要绕过的那个 LLM 否决权原样请回来。**支路 B 是一条有意的「LLM 否决覆盖」通道**，这是它的设计语义，MUST 被显式承认而非掩饰。

**该覆盖通道的边界（绝不可省——防先例被泛化）**：支路 B 是本系统**唯一**一处「确定性规则覆盖 LLM 否决」的通道（其余所有确定性闸都是 fail-closed 的 AND、只收紧不放宽）。新增任何同类覆盖通道 **MUST 另起提案**，且 **MUST 提供该类事件上 LLM 判断【系统性失效】的生产证据**（如本支路的 `importance=30` / `should_push=false` 真样本）；**MUST NOT** 以「确定性优于 LLM」的一般性理由开设——否则告警闸会被逐条 OR 稀释成一堆词表，`should_push` 名存实亡。

**④ 的匹配 MUST 为确定性程序判定**（纯字符串/模式匹配，可单测、可回放），MUST NOT 交由 LLM 判定。匹配口径 MUST 定死：对 `representative_title` 做**小写折叠**后匹配（词表全小写）；`representative_title IS NULL` **视为不命中**；词表内 MUST NOT 含 LIKE 元字符（`%` / `_` / `\`）。词表 MUST 全为**多字短语**，MUST NOT 含单字，且新增词 MUST 通过「常用词子串」自检（`用量` ⊂ `使用量`——双字词同样可能是高频无关词的子串）。

**④ MUST 带一个否定合取项 `NEGATIVE_PATTERNS`（器物名，本需求修改点，绝不可省）**：正向词表里的 `rate limit` / `限流` / `速率限制` 都是**器物名的子串**（`rate limit` ⊂ `rate limiter`；`限流` ⊂ `限流器`），而 HN 的工具帖在语料里是高频的 ⇒ 「`Show HN: A Rate Limiter for LLM APIs`」`is_ai_related=true` 且命中 `%rate limit%` ⇒ **直接推手机**。故支路 B 的谓词 MUST 为「正向命中 **∧ NOT** 命中器物名」。词表成员（**`rate limiting` MUST NOT 在内**——它是公告的常用动名词，挡它就是漏掉真的限流变更公告）与逐词裁决理由的唯一 SOT 见 conversational-rag 的「价格/选型确定性前置闸」，本需求 MUST NOT 抄第二份。

**否定谓词 MUST 复用与正向支路【同一个】 `lower(representative_title)` 表达式（绝不可省）**：词表全小写而 PG 的 `LIKE` **区分大小写**，HN 的真实标题是 **Title Case**（`Show HN: A Rate Limiter for LLM APIs`）⇒ 正向谓词因**用了 `lower()`** 而命中、否定谓词若写成裸 `representative_title LIKE ANY (…)` 则匹配不到 `%rate limiter%` ⇒ `NOT(false)` = `true` ⇒ **手机照震，否定项等于不存在**。生产语料里支路 B 的真命中（`Improved Batch Inference API: Enhanced UI, Expanded Model Support, and 3000× Rate Limit Increase`）**同样是 Title Case**——它能被正向谓词捕获，**只因为正向用了 `lower()`**。**该失效是静默的**：全小写的样例标题在两种写法下结果相同 ⇒ 测试会绿。故双出口一致性测试 MUST 含一条 **Title Case** 用例。

**④ 的闸判定 MUST 发生在 SQL 侧（绝不可省——正向与否定【两侧】都是）**：告警候选查询带 `ORDER BY published_at DESC LIMIT ALERT_MAX_PER_SCAN`，**LIMIT 先于任何应用层过滤执行**。若把词表匹配放到应用层对 SQL 结果做二次过滤，SQL 只会选出支路 A 的候选，**支路 B 的事件根本进不了结果集**——功能实现完、测试也写了，就是永远不触发。否定项同理 MUST 在 SQL 侧：放到应用层则它挡掉的候选**已经占用了 `LIMIT` 的名额**。

**④ 是纯 `representative_title` 谓词，本期不附加 source 谓词**：`ai_news_events` 的 source 全集当前即 `{rss, hacker_news, github, sitemap}`，与 `REALTIME_NEWS_SOURCES` 相等（arXiv / hf_papers / product_hunt / show_hn / blogger 的 `raw_type` 经 dedup-and-normalization 的塌缩候选谓词排除、永不成为事件，该塌缩不变量已有测试守护）。在该等式下源子集谓词**筛掉 0 行**，为它写闸属重复建坝，故**本期不加**。

> **但这条等式是两处手工维护的字面量、不是结构性保证（登记，防它被当成禁令）**。**该前向守卫的触发谓词 MUST 按事件塌缩的【实际闸】写**——塌缩候选闸是**黑名单**（`src/dedup/collapse.ts:445-447`：`raw_type IS DISTINCT FROM 'product' / 'paper' / 'experience'`），且 `raw_items.raw_type` **可空**（`src/db/schema.ts:85`，无 `.notNull()`；`IS DISTINCT FROM` 正是为**有意放行 NULL** 而选）。故：
>
> **任何人新增一个源，其产出的 `raw_type` 不在排除集 `{product, paper, experience}` 内（含 `raw_type` 为 NULL / 未设置），却不把该源加进 `REALTIME_NEWS_SOURCES`**，其条目就会进 `ai_news_events`、**直接取得支路 B 的 P0 资格**（支路 B **无 importance 地板、无 source 谓词**）——一条从未为 P0 审过的源，一命中就是一次手机震动。
>
> **MUST NOT 把触发谓词写成「产出 `raw_type='news'` 的源」**——那会让守卫对仓内现成的两个源判「不适用」：`hacker_news` 产出 `'post'`、`github` 产出 `'repo'`，**两者今天就在 `REALTIME_NEWS_SOURCES` 里**；未来的 `'changelog'` / `'video'` / 漏写（NULL）同理。**若该等式将来被打破，为支路 B 附加 source 谓词是正当补救**，本条 MUST NOT 被引用来阻拦它。

**告警闸 MUST NOT 绑定 `developer_relevance_score`（绝不可省）**：该轴衡量「是否开发者内容」，与「是否改变开发者当日决策」正交——生产语料中 `developer_relevance >= 85 且 importance < 85` 的事件量级为 **269 条 / 7 天**（开发者博客、教程、厂商 PR），把它并入告警闸等同于批量刷屏。系统 MUST NOT 为捕获精确事实变更而降低 `importance` / `developer_relevance` 任一分数线；该类事件的捕获**只**经支路 B 的确定性词表。同理，系统 MUST NOT 为此给 Value Judge 新增「即时决策影响」类 LLM 轴（闸须由程序判定）。

**支路 B MUST 继承全部其余告警候选条件（绝不可省，逐条列出——清单不得省略）**：OR 只作用于**分数闸**。命中词表的事件仍 MUST 满足以下**每一条**：

- `published_at` 时效窗口：下界 `>= lowerBound`、未来上界 `<= now`、`published_at IS NOT NULL` 排除；`ALERT_FIRST_SEEN_WINDOW_DAYS=0` 旁路只免下界 gte，**不免** NULL 排除与未来上界；
- **tombstone 排除 `merged_into IS NULL`**；
- **首次启用发布时间基线水位 `published_at >= ALERT_MIN_PUBLISHED_AT`**；
- Model B「一生一次」channel-agnostic 去重（**本能力既有的去重模型**，语义 = 尚未 alert-success 投递给所有已配置通道）；
- 单轮上限 `ALERT_MAX_PER_SCAN`；
- 与日报链并发评分的原子 claim；
- **`is_ai_related = true`**（两支路共用前提，见上）。

**告警闸与 `published_at` 回填域 MUST 由【同一个共享构造器】生成（绝不可省——这是结构保证，不是纪律要求）**：告警链在选候选**之前**调用 `published-at-inference` 回填 `published_at IS NULL` 的事件。回填查询带**固定单次上限** `LIMIT PUBLISHED_AT_INFERENCE_MAX_PER_RUN`（默认 20，`ORDER BY first_seen_at DESC`）——**有固定 LIMIT 就有饥饿**：

- 回填域**比告警闸宽**时，宽出去的那些（如高 importance 的**非 AI** 新闻）会**占掉 LIMIT 的名额**，把真正在闸内、`published_at IS NULL` 的事件**挤出本轮回填** → 保持 NULL → 被时效闸的 NULL 排除挡住 → **永不告警，且在可观测里不留任何痕迹**。这正是 published-at-inference 自己列为要防的危害（「饿死近期 NULL 事件」）。**故「回填域比闸宽只是浪费配额」的说法 MUST NOT 被采信。**
- 回填域**比告警闸窄**时，一条 `published_at IS NULL`、命中词表且 importance 低的**非豁免源**事件会被**静默丢弃**（永为 NULL → 被 NULL 排除踢出候选 → 永不告警）。

⇒ 两个方向都是缺陷。**唯一正确的形态是「相等」，且 MUST 由同一个构造器生成而非两处各写一份**（各写一份必然漂移）。作用域的权威定义见 published-at-inference 能力：

```
importance_score IS NOT NULL
AND is_ai_related = true                                    -- 与告警闸同一道共用 AI 闸
AND ( importance_score >= ALERT_IMPORTANCE_THRESHOLD
   OR representative_title 命中词表 )
```

> **「同构」仅指该共享谓词，两者并非完全等价（澄清，防 overclaim）**：回填域 = 该共享谓词 **∧** `published_at IS NULL` **∧** `first_seen_at` 未超窗剪枝 **∧** **源不在豁免名单内**（本期 `{sitemap}`，见 published-at-inference 的「确定性提取源豁免 AI 发布日推断」——该源的日期由确定性页面提取产出、提取失败即 NULL 且 MUST NOT 转 LLM 猜） **∧** 有代表 raw_item（回填查询用 **INNER JOIN**）；告警闸用 **LEFT JOIN**，故 `representative_raw_item_id` 为 NULL 的事件**进得了告警候选、进不了回填域**。这不构成缺陷——无代表 raw_item 即无线索可推断日期；且告警闸的 LEFT JOIN 正是「实时告警独立幂等口径」所要求的「绝不因回指失败丢候选造成漏告警」。**豁免源同理不构成上面那种「窄」缺陷**：那是被论证过的取舍（宁可漏、绝不把老文洗成今日突发），不是漂移。

**两支路共享 `ALERT_MAX_PER_SCAN` 的取序（如实登记，不作虚假承诺）**：OR 把两支路合进同一个 `ORDER BY published_at DESC LIMIT ALERT_MAX_PER_SCAN` 池。在该取序下，`published_at` 更新的支路 B 命中**可能**挤占同轮的支路 A 重大发布（该事件保留候选资格，下一轮由 Model B 的「未 success 投递」窗口自动补，延迟一个 cron 周期）。**本能力接受该行为、不设分支配额、不改 ORDER BY**——支路 B 实测量级 ≤ 1 条 / 30 天（对照支路 A 的 ≈ 3.67 条/天），挤占概率可忽略。**系统 MUST NOT 声称「重大发布不被挤出本轮」**（代码不提供该保证）。若上线后真观测到挤占，升级路径为 `ORDER BY (importance_score >= 阈值) DESC NULLS LAST, published_at DESC`。

**本闸不构成对「采集期不做关键词硬预过滤」约束的违反**（source-collectors「RSS 源分层与次级源噪音治理」）：该约束针对**采集期**按主题/质量**预筛并排除** news 内容。支路 B 的三点区别——① **位置**：位于告警闸，在 Value Judge 评分**之后**、作用于 `ai_news_events`，不在采集期；② **方向**：**只加不减**，OR 支路只**提升**告警资格、从不压制任何条目；③ **性质**：识别的是**事实域归属**（与 conversational-rag 前置闸同一域定义，两出口方向相反：`/advisor` 命中即拒答不猜、P0 命中即立刻推），非内容价值高低。价值判断仍完整留在 Value Judge 的语义 `should_push` 与既有 importance 阈值闸。

**告警候选必须带基于发布时间 `published_at` 的时效窗口（绝不可基于 `first_seen_at`）**：仅对 `published_at` 在近 N 天内的事件告警，复用现有窗口天数配置（`ALERT_FIRST_SEEN_WINDOW_DAYS`，默认 3）。时效闸**禁止基于抓取时间 `first_seen_at`**——`first_seen_at` 是 raw_item 入库时刻，冷启动/新增源时历史老文的 `first_seen_at` 恰为「今天」，以它做窗口会把老文误当重大发布刷屏告警。`published_at` 为 NULL 的事件必须先经 `published-at-inference` 能力的 AI 推断回填：推断成功则以回填后的 `published_at` 判定，AI 仍无法判定（保持 NULL）则**排除出告警候选**。单次扫描上限内的取序须以 `published_at` 衡量「最新」（不再以 `first_seen_at` 排序）。`first_seen_at` 语义不变，仅不再用于告警时效过滤。

> **该时效闸是支路 B 的主要噪音控制（实测）**：RSS 归档常把老文重新投递——生产语料中命中词表的 7 条 raw_item，其真实 `published_at` 分布于 2022–2026 年（如 HuggingFace 的 `Introducing our new pricing` 发布于 2022-11-08）。时效窗口把它们全部挡在候选之外；30 天内 `published_at` 新鲜的命中仅 1 条。

**告警时效闸同为闭区间 `lowerBound <= published_at <= now`，未来日期上界绝不可省**：与日报同口径，除下界外必须加未来日期上界 `published_at <= now`，拦住确定性来源（RSS/GitHub 等）与 AI 的任何未来值（未来值 `>= 下界` 恒真会绕过下界闸被当「重大发布」刷屏告警）。

**`published_at IS NULL` 与未来日期的排除不依赖窗口大小（绝不可省）**：`ALERT_FIRST_SEEN_WINDOW_DAYS=0` 表示「不限时效窗口」（旁路 `published_at >= 下界` 的下界 `gte` 闸）。即便处于该旁路，告警候选仍必须满足 `published_at IS NOT NULL AND published_at <= now`——`windowDays=0` 只免除**下界**「近 N 天」gte，**不免除** NULL 排除与未来日期上界（否则旧 NULL/未推断成功/未来日期的事件会绕过修复在告警链刷屏）。即：`windowDays>0` 时候选条件为 `下界 <= published_at <= now`（已隐含非 NULL）；`windowDays=0` 时候选条件为 `published_at IS NOT NULL AND published_at <= now`。

**不支持的配置组合 MUST 在启动期 fail-fast（本需求修改点，绝不可省）**：`ALERT_SCAN_ENABLED='true'` **且** `ALERT_FIRST_SEEN_WINDOW_DAYS=0`（旁路时效下界）**且** `ALERT_MIN_PUBLISHED_AT=''`（显式 opt-out 水位）三者同时成立时，告警候选域**扩成全表历史**——支路 B 尤甚（每条历史老公告都可能命中词表），直撞 `policy-push-timeliness`（禁上线后批量推旧消息）。仅在规范里写「MUST NOT 在生产使用」**不构成保证**：系统 MUST 在 env 校验（`superRefine`）里拒绝该组合并**启动即失败**，与既有的「启用告警而未显式给出基线 SHALL 快速失败」同源。**该守卫 MUST NOT 以新增 env 配置项的方式实现**（它是既有三个变量之间的跨字段不变量）。

**时区比较口径与日报同源**：`published_at` 为带时区发布绝对时刻，时效下界由 `startOfDayInTimeZone`（Asia/Shanghai，与日报 `push_date` 同源）换算为 UTC 绝对时刻，时效闸为两绝对时刻比较（见 daily-intel-pipeline「Top N 组合分选择」同口径说明）。

**判定时点与阶段序必须明确（绝不可写反）**：`importance_score` 由 Value Judge 写入，采集后、评分前该列为 NULL（`NULL >= 85` 恒假），故告警闸判定必须在评分**之后**——这对**两条支路同样成立**（由「已评分」共用前提兑现）。但若告警只被动等日报链评分，则告警退化为「日报后才触发」、失去实时性。因此实时告警由一个**更高频的轻量工作流**承载（频率 env 可配，默认保守如 15–30 分钟），按纯顺序确定性流执行：

```
采集 → 规范化/硬去重塌缩 → 判分阶段（正文补全 + Value Judge 评分，原子 claim）
     → published_at 回填（作用域 = 告警闸的同一构造器）→ 选候选（告警闸）→ 推送
```

**回填 MUST 在评分之后、选候选之前**——回填域以「已评分」为前提（与告警闸同构），若把回填排在评分之前，其 `importance_score IS NOT NULL` 前提恒假、回填域恒空。禁止把各阶段拆成相互投递的复杂队列图。所有外部推送调用必须带重试与错误日志。

**告警扫描 cron 的分钟展开集必须满足 feishu-push 的避整点判据；默认值与生产覆盖值同受该约束（绝不可省）**：告警链是走飞书发送的定时 cron 之一，其触发频率虽由 env 自由配置，但 `ALERT_SCAN_CRON` 的**分钟字段展开后的分钟集合**与 `{0, 30}` 的交集 MUST 为空（判据的完整定义、展开语法、fail-closed 语义与覆盖面见 feishu-push「飞书自定义机器人通道推送」）。默认值 SHALL 为 `4-59/15 * * * *`（分钟展开集 `{4,19,34,49}`，仍落在上述「15–30 分钟」的保守频率窗内）；步进式写法 `*/15`（展开 `{0,15,30,45}`）与 `*/20`（展开 `{0,20,40}`）的展开集含 `0`，**MUST NOT** 用作默认值或生产值——高频链每小时触发数次，一旦分钟展开集含整点/半点，撞飞书全网高压时刻的频次随之乘以每日触发轮数。**该约束同等约束生产覆盖值**：机械断言只能读到代码里的默认值，**部署 MUST 在启用告警的同一次变更里显式改写生产 env 的 `ALERT_SCAN_CRON`**——只改默认值而不改生产覆盖值时，断言全绿而生产照撞整点，判据在生产上失效。

**高频链路的采集源子集必须显式裁剪（绝不可省，本需求修改点）**：高频链路**不得复用日报的完整 registry**——它必须只采集**实时性新闻类源 `{rss, hacker_news, github, sitemap}`**（子集的权威定义在 source-collectors），**显式排除 arXiv**（非实时源；且 ≥3s 串行节流不适合高频）与 **Product Hunt**（产品源、GraphQL 复杂度配额受限，高频会与日报链争抢配额打满）。

**`sitemap` 进实时子集买到的是【采集延迟】，不是【告警资格】（MUST 写明，防因果被写反）**：告警候选谓词**没有 source 条件**——`REALTIME_NEWS_SOURCES` 的**唯一**运行时消费点是采集阶段。而 `sitemap` 本就在日报的全集 registry 里、日报链每天全量采 ⇒ **sitemap 事件早已在 `ai_news_events` 中，今天就具备告警资格**。把它纳入实时子集，收益是把一方厂商官方公告的**采集延迟从 ≤24 小时压到 ≤20 分钟**，仅此而已。**系统 MUST NOT 声称「sitemap 不在实时子集时其事件不会触发告警」**，亦 MUST NOT 把「首跑只有三源、故风险面只有三源」作为开闸的安全论证——**开闸瞬间的风险面已经是四个源的事件**。首跑核验的对象 MUST 为**告警候选的 `event.source` 分布**（它会包含 `sitemap`），MUST NOT 为「采集子集是三源」。

**告警链无熔断阶段（如实登记）**：告警链**不实现** `stageShouldAbort` 一类的熔断。站点批量重渲染（`lastmod` 全量刷新）把大量老文推回窗口、且 LLM 同时全挂时，单轮最坏耗时为「篇数 × (LLM 重试上限 × 单次 LLM 超时 + 单次补全 fetch 超时)」——按生产语料的 213 篇与各自的 env 默认值计：`213 × (3 × 60s + 15s) = 41,535s` ≈ **11.5 小时**（**不是 30–60 分钟**）。已见集在 fetch 之前过滤 ⇒ 风暴只发生**一轮**。**该数字 MUST 与其算式对齐**：一份通篇在纠正别人数字的规范，自己的数字同样要能被复算。

**并发堆积不成立，MUST NOT 被写成风险**：告警 worker 的 `concurrency: 1`（`src/pipeline/alert-queue.ts:116`）⇒ 长轮期间后续 cron 触发只会**排队**，绝不出现「数十轮并发跑」。**真实风险是另一件事：单轮长时阻塞 = P0 车道整段不可用。** 11.5 小时的单轮意味着 **P0 车道死大半天**——而这条车道的全部存在理由就是「大事发生时先从即时推送知道」。

**故告警侧的判分 MUST 有界（本需求修改点，绝不可省）**：

- 告警链调用 Value Judge 判分时 MUST 施加**每轮工作预算**——候选 SELECT 加 **确定性取序 + `LIMIT N+1`（只处理前 N 条）**。当前实现无界：候选 SELECT **既无 `ORDER BY` 也无 `LIMIT`**（`src/agents/value-judge/score-events.ts:242-266`，工作集谓词在 `:266`；全文仅 `:363` 有一个与候选集无关的 0 行回读 `.limit(1)`），告警链每轮直接全量送判（`src/pipeline/alert-scan.ts:350`）。
- **该预算 MUST 只对告警链生效：其默认值 MUST 为「无界」（`undefined` / 不加 `LIMIT`），MUST NOT 为那个模块常量 N（绝不可省——写反这一条，本条的目的与它下面「不饥饿」的论证会【一起】被打掉）**：预算是**调用方显式传入**的选项，日报链**不传** ⇒ 其判分**保持全量无界**。若把 N 写成模块常量的**缺省值**（`const limit = options.maxPerRun ?? N`），日报链会**一并被截到 N 条/天**（N ≤ 3）⇒ ① 日报要闻段瞬间枯竭；② 下面「告警链不饥饿」的**唯一依据**（「老的未评分事件由**无界的日报链**在 ≤24h 内排空」）**当场坍塌** ⇒ 老事件永久积压、永不评分。**该失效对测试完全不可见**：条数 ≤ N 的单测与集成测 fixture 在两条链上行为逐字相同 ⇒ **全绿**。故 MUST 有一条**回归钉**：日报链对 **> N** 条未评分事件（如 6 条）跑判分 → 断言**全部**被判（不截断）。
- **取序 MUST 定死为（绝不可只写 `LIMIT`）**：

  ```sql
  ORDER BY first_seen_at DESC NULLS LAST, event_id DESC   LIMIT N + 1
  --                          ^^^^^^^^^^  ^^^^^^^^^^^^ 二者【均必需】
  ```

  `event_id` 这一项 MUST 有：`first_seen_at` 同值（同一轮采集入库的事件常见同秒）时，只按它排序仍是**部分序**，PG 可返回任意一批。而**加 `LIMIT` 却不加 `ORDER BY` 更糟**——PG 返回**任意** N 行，「哪 N 条被判」每轮随物理扫描序漂移。

  **`NULLS LAST` 同样 MUST 有（它防的正是本条花整段论证要防的那个永久饥饿）**：`ai_news_events.first_seen_at` **可空**（`src/db/schema.ts:146` 无 `.notNull()`），而 PG 的 `ORDER BY x DESC` 默认是 **`NULLS FIRST`**（实测：`(1, NULL, 3)` 上 `ORDER BY x DESC LIMIT 1` 返回 **NULL**）。⇒ 只要有**一行** `first_seen_at IS NULL`，它就**恒排第一**、每轮吃掉 N 个名额中的一个、且**永不老化出局**（判分工作集无任何时间剪枝）——与上面「毒事件每轮吃满预算」是**同一个失效**，只是成因从「物理扫描序」换成「NULL 排序默认值」。仓内他处均已显式写 `DESC NULLS LAST`（如 `src/pipeline/experience-chain.ts:534`）。
  **该地雷今日处于休眠态，MUST 如实登记**：生产实测 `first_seen_at IS NULL` 的事件 = **0 / 3698** ⇒ 它今天不是活 bug。**修它的理由不是它正在爆，而是它的失效【是静默的】**——第一行 NULL 出现的那天，没有任何测试、日志或告警会变红。
- **「不加 `LIMIT`、循环内数到 N 就 break」这个所谓的等效变体 MUST NOT 被采用（它不等效，且能永久丢事件）**：不加 `LIMIT` 时 SELECT 是**全量无序**返回、break 前 N 条。**物理扫描序在轮与轮之间是稳定的** ⇒ 排在扫描序头部的 N 条**毒事件**（判分恒失败 → `releaseJudgeClaim` → `importance_score` 仍 NULL → 留在工作集 → 下一轮**又排在同一位置**）**每轮吃满整个预算**，其后**所有健康事件永久饿死**。而判分工作集**无任何时间剪枝**（谓词只有 `importance_score IS NULL AND merged_into IS NULL`），毒事件**永不老化出局**。⇒ 契约声称「绝不丢事件」，而该变体**能永久丢事件**。**MUST 落在候选 SELECT 的 `ORDER BY … LIMIT N+1`（只处理前 N 条）上。**
- **N MUST 有值，且 MUST 满足下式（只写「N 是模块常量、MUST 有界」不构成约束）**：

  ```
  N × (F + A × L + W)  <  ALERT_SCAN_CRON 的周期
  F = COLLECTOR_FETCH_TIMEOUT_MS = 15s（env）
  A = JUDGE_MAX_ATTEMPTS = 3（unify-judge-stage 把判分模块的 DEFAULT_MAX_ATTEMPTS 提为 config 侧的
      【导出常量】后的那一个——它【不是 env 变量】，MUST NOT 被表述成 env）
  L = LLM_TIMEOUT_MS = 60s（env）
  W = JUDGE_WRITE_BUDGET_MS = 60s（env——与 unify-judge-stage 落地的 T > F+A×L+W 回收阈值同一口径）
  ⇒ 每条最坏 255s（末次尝试成功 + 写分）⇒ 15 分钟一轮的 cron ⇒ 【N ≤ 3】
  ```

  **反例 MUST 一并读到**：取 `N = 20`（与 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 同量级的「自然」选择）⇒ 单轮最坏 `20 × 255s ≈ 85 分钟` = cron 周期的**近 6 倍** ⇒ 因 `concurrency: 1`（`src/pipeline/alert-queue.ts:116`）**队列只会越积越长** ⇒ **车道仍然不可用**，只是从「死大半天」变成「每轮 1 小时余且持续落后」。**一个不满足上式的 N 兑现不了本条的目的。**
  **口径区分（MUST 一并读到）**：预算口径的每条最坏 = `F + A×L + W`（末次尝试成功仍要写分）；而「重渲染风暴 11.5h」的每条 = `F + A×L = 195s`（LLM 全挂 = 全部尝试失败 ⇒ **无写分**）——两个口径各自正确，MUST NOT 互相替换。

- **该不等式 MUST 由启动期跨字段校验（`superRefine`）强制，MUST NOT 只写在文档里（绝不可省）**：上式五项里**有四项是 env**（`COLLECTOR_FETCH_TIMEOUT_MS` / `LLM_TIMEOUT_MS` / `JUDGE_WRITE_BUDGET_MS` / `ALERT_SCAN_CRON` 的周期），只有 `A` 是导出常量。⇒ 把 N 写成一个硬编码的 `3`、把约束留在散文里，则**生产上调高 `LLM_TIMEOUT_MS`（或把 cron 周期改短）时约束静默失效** ⇒ 单轮又超 cron 周期 ⇒ `concurrency: 1` 下队列积压 ⇒ **P0 车道回到不可用**，而没有任何东西会变红。

  **同一份变更对 `T > F + A×L + W`（claim 回收阈值）已要求「MUST 由启动期跨字段校验强制、**禁止**只写在文档里」**（见 daily-intel-pipeline 的「降级逐条容错」）——**对 N 不能是另一套标准**。故：N 的上式 MUST 同样落进 `env.ts` 的 `superRefine`（N 由 env 派生、或以常量 N 参与校验，两种形态择一并显式落地），不满足即**启动 fail-fast**；**错误消息 MUST 报出五项的当前值**（`N` / `F` / `A×L` / `W` / cron 周期），否则运维看到一条不可行动的报错。**该 superRefine MUST 以 `ALERT_SCAN_ENABLED === 'true'` 为合取门**（与既有「启用告警而未显式给出基线 SHALL 快速失败」同门控）：N 约束只对告警链有意义，纯日报部署（车道关）不得因 alert cron × LLM 超时组合被拒启动。（既有 `T > F+A×L+W` superRefine 不门控，因 claim 不变量对两条链都成立——本条不是。）
- **「不饥饿」MUST 被论证，不能默认（`DESC` 取序表面上会饿死老的未评分事件）**：告警链按 `first_seen_at DESC` 取 N 条 ⇒ 老的未评分事件在**告警链**里可能长期取不到。这**不是**饥饿，理由有两条、缺一不可：
  1. 老的未评分事件**过不了告警闸的时效地板**（`src/pipeline/alert-scan.ts:249` 的 `gte(publishedAt, lowerBound)` 与 `:258` 的 `gte(publishedAt, minPublishedAt)`）⇒ **判了也不会告警** ⇒ 告警链把预算花在它们身上是**纯浪费**；
  2. 它们由**无界的日报链**在 ≤24h 内排空（日报链每天全量判）。
- **⇒「MUST NOT 给日报链设界」现在承载【两个】理由，MUST 显式登记这条依赖**：除「一天一次、无界是它的正确形态」外，它还是**告警链取序不饿死老事件的唯一依据**。**将来任何给日报链也加预算的改动，MUST 先重新论证告警链的非饥饿性**——顺手加一个界，积压就永久饿死了。
- 触顶 MUST 发一条**结构化可观测事件**（复用既有 run-event 通道，MUST NOT 新建通道），**MUST NOT 静默截断**。
- **触顶事件的落点 MUST 定死（否则「复用既有通道」这条会被实现成新建通道）**：`emit` 挂在 `RunAlertScanOptions`（`src/pipeline/alert-scan.ts:126`），**不在** `ScoreEventsOptions` 上，而截断发生在 `scoreUnscoredEvents` **内部**。⇒ 唯一不新建通道的落法是：**`ScoreEventsResult` 增 `budgetExhausted` / `candidateCount`（= 本轮实际处理条数 ≤ N）字段，由 `alert-scan.ts` 读取后 emit**。**MUST NOT 给 `ScoreEventsOptions` 加 `emit`**——那就是新建一条通道，与本条自己的 MUST 相悖。触顶的**判定** MUST 用 `LIMIT N+1` 取候选、只处理前 N 条（`budgetExhausted = 取回行数 > N`）——单靠 `LIMIT N` 无法区分恰好 N 与超过 N。事件名定死为 **`p0.judge_budget`**（载荷 `{budgetExhausted, candidateCount}`），经既有 emit 通道发射。
- 触顶 MUST 保持既有 claim / 写 CAS 不变量：被预算挡在本轮之外的事件**留在工作集里**（`importance_score` 仍为 NULL），下一轮继续——预算只裁**单轮工作量**，绝不丢事件、绝不改「一事件只评一次分」。
- **界 MUST 施加在 claim 之前（绝不可省——写错这一条，预算本身就是新的饥饿源）**：`importance_score IS NULL` 只决定**工作集成员资格**，而**下一轮能不能取到该事件，由 `judge_claimed_at` 决定**。若预算在 claim **之后**才截断（先 `claimEventForJudging` 再判「超预算 → break」），被截的事件就是 **claimed 但未判分**——它确实「留在工作集里」，但下一轮 `claimSkipped++` 取不到它，**要等满整个 `T`（`JUDGE_CLAIM_RECLAIM_MS`）才能被回收**。候选 SELECT 的 `LIMIT N+1` 天然落在 claim 之前（第 N+1 行不 claim、只作触顶信号），本条即自动成立。
- **日报链 MUST 保持全量**（见上「不饥饿」的第 2 条理由与其登记）；**MUST 只对 P0 高频链设界**。
- **`ALERT_SCAN_ENABLED=false` MUST NOT 被列为唯一的运行时保护**：那是**人翻开关的事后止血**（发现时车道已经死了几个小时），不是上线前的保护。一条高频车道必须**有界**——这是基本属性，不是可登记的风险。

**预算只封【判分段】，MUST NOT 被表述为「单轮整体已有界」（登记）**：回填段在同一轮内，最坏 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN（env，默认 20）× A×L（180s）= 3600s = 4× 周期`。把它折进 superRefine 在默认值下无解（会迫使上限为 0），故不设不等式；其真实的界是**结构性的**——非豁免源实测 0 条 NULL `published_at`、`sitemap` 已整源豁免 ⇒ 回填池近乎空（见 published-at-inference 的登记），负缓存是池变大时的既定升级路径。**若日后出现产 NULL 条目的非豁免源，MUST 先重新论证回填段时长（或给该上限设界）再扩源。**

**与日报链的并发评分必须原子 claim（绝不可省）**：高频告警链路与日报链路可能**同时**对同一未评分事件跑 Value Judge。仅靠「只处理未评分」不防并发双评分，必须用 daily-intel-pipeline「降级逐条容错」定义的**原子 claim**（`UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING` / `FOR UPDATE SKIP LOCKED`，含超时回收防僵尸 claim 永久漏评），只有 claim 成功的链路送 LLM——保证「一事件只评一次分、永不覆写、崩溃不致永久漏评」跨两链路成立。

**高频链路不套用日报的「全源返回 0」系统级告警**：高频轮询全源返回 0 / 无新内容是常态，若套用日报的全失败告警会每天数十次误告警刷屏；故高频告警链路的全源 0 / 无新事件按正常空轮处理、不告警（见 daily-intel-pipeline）。

**但「不做全源 0 告警」MUST NOT 被扩大为「不做源级健康告警」——两条链 MUST 都消费 `perSource`（本需求修改点，绝不可省）**：这是两条不同的判据（前者判「整轮全挂」，后者判「某一个源结构性失败」）。

- **本需求的缺口 MUST 精确表述：`perSource.ok=false` 【只有高频链无告警消费者】，不是「两条链都没有」。** 后 `fix-sitemap-published-at` 基线（该前置变更已归档）下，**日报链已消费 `collected.perSource`**（`run-daily-workflow.ts:526` 的消费循环对 `ok=false` 发 `dedupKey='source-health:<source>'` 告警，生产经 `run(ctx)` 注入 `buildOpsAlertSink`）。**缺口只在高频链**：`alert-scan.ts` 不读 `collected.perSource`、且按设计不调 `classifySystemFailure`（防刷屏），亦无 `AlertSink` 注入口。（`classifySystemFailure` 的入参「本轮采集统计」结构**不含** `perSource`——但那是「全源 0」系统判据，与源级 `perSource` 消费是两条不同链路；日报链直接读 `perSource`、不经此函数。**此处 MUST NOT 写成对该结构字段数的现在时断言**——本需求只依赖「它不含 `perSource`」。）
- **⇒ 系统 MUST NOT 声称「护栏只是退化为日频、日报链最长 24h 后会补上告警」，亦 MUST NOT 反向声称「日报链永远不会告警」**：日报链的源级告警**今天就在**——`source-collectors` 里那句「throw → `perSource.ok=false` → **计入告警**」在**日报链上已兑现**，只在**高频链上尚是空头支票**。站点改版把某源打成结构性失败时，**高频链**会静默丢该源最长 24h——那正是本需求要为高频链补的出口。
- **缺口的准确表述是【高频链无告警消费者】，MUST NOT 被夸大成「两条链都没有」或「连信号都没留下」**：`runRegistry` 对每个被隔离的源失败**都记**（`src/collectors/index.ts:229-231`：`perSource[source]={ok:false}` + `logError` + `console.error`）——高频链缺的是**出口**，不是记录。往两个方向夸大（说成「两条链都无消费者」，或「连信号都没留下」），都与「恒绿的守卫等于没有守卫」是同一种失真。
- **该缺口恰好打掉本车道唯一的收益**：sitemap 进实时子集买到的是「采集延迟 ≤20min」，而站点改版后本车道会**静默丢掉这个源最长 24 小时**。
- **故：高频链与日报链 MUST 都读 `collected.perSource`，对 `ok=false` 的结构性失败产出【源级健康告警】**（典型：`sitemap` 站点改版致 `loc_count=0` → 整源 throw）。该告警 MUST 经 platform-foundation 的**运维告警 sink**（`createOpsAlertSink`）落**真实通道**，幂等键 **`dedupKey = 'source-health:<source>'`**。**MUST NOT 登记后继续吞**——一条被写进采集器契约却在新车道上落空的承诺是缺陷，不是可登记的取舍。
- **告警链 MUST 有 `AlertSink` 的注入口，且生产入口 MUST 真的注入它（绝不可省——没有这一条，上面整段 MUST 在生产上是空的，而测试恒绿）**：日报链的运行选项**已有** `alert?: AlertSink`（`run-daily-workflow.ts:203`，未注入时回落 stderr 的 `consoleAlertSink`，**生产经 `run(ctx)` 已注入 `buildOpsAlertSink`**）；**告警链的运行选项没有**（`RunAlertScanOptions`，`src/pipeline/alert-scan.ts:82-127`：`log` / `emit` / `judge` / `collect` / `publishedAtInfer` / `publishedAtLock` / `threshold` / `windowDays` / `maxPerScan` / `dbh` 等——**无 `alert`**），其 worker 工厂 `createAlertScanWorker({connection, concurrency})`（`alert-queue.ts:97`）**亦无透传口**。⇒ 高频链即便写了源级告警，生产也只能回落 `console.error` ⇒ **静默**。故：
  - `RunAlertScanOptions` MUST 增 `alert?: AlertSink`；
  - **生产装配路径 MUST 真的接线：告警链自身的 `run(ctx)` 包装 MUST 注入 `buildOpsAlertSink(...)`**（与日报链同型；`buildOpsAlertSink` 自发现并懒构造生产通道，裸 `createOpsAlertSink` 需预构造 senders、不作为装配入口）——只加字段不接线，等于把注入口留给测试自己填；
  - **MUST 有一条「未注入即回落 stderr」的显式回归断言**。**理由 MUST 一并读到**：源级告警的单测**自己注入 sink** ⇒ **无论生产有没有接线，那些用例都恒绿**。一个只能被「测试自己传进来的东西」满足的契约，不构成对生产的任何保证——这与本能力反复指认的「恒绿的守卫等于没有守卫」是同一个失效。
- **限频 MUST 由 DB 唯一约束承载，MUST NOT 用 Redis 键或进程内 Map**：状态住在推送幂等的 `UNIQUE(target_type, target_id, channel, push_date)` 里，判据 = **仅 `status='success'` 行算今天已告过**（`ON CONFLICT DO UPDATE … WHERE status <> 'success'`，权威见 platform-foundation；**MUST NOT 写成 `ON CONFLICT DO NOTHING`**——失败残行会挡死当天重试 = 当天彻底哑火）⇒ **零新状态、跨进程、跨重启、跨两条链自动去重**（首个 success 轮后其余轮跳过、发送失败不占名额可重试）。**进程内 Map 每次 redeploy 复位** ⇒ 「连续 N 轮失败」永不达标 ⇒ **静默不告警，比刷屏更糟**。
- **源级健康告警 MUST 同时落在日报链，与高频链共用【同一个判定与同一个 `dedupKey`】（结构性要求，绝不可省）**：整条 P0 车道的回滚路径是 `ALERT_SCAN_ENABLED=false`（worker 完全跳过告警链）⇒ **只把源级告警放在高频链，一回滚唯一的告警出口就随之消失**。共用 `dedupKey` ⇒ 两条链经同一个唯一键**自动互相去重、不会双响**。判定 MUST 含日报链既有的**良性限流豁免**（arXiv/PH 429 背压不告警），豁免谓词提为共享函数、两链同用。
- **MUST NOT 套用日报的「全源返回 0」系统级告警**——高频链空轮是常态，那道闸会每天数十次误告警。

> 此设计同时满足：① 两条支路的判定都在 `importance_score` 写入之后（「已评分」共用前提，不 `NULL >= 85` 误判、亦不让未评分事件绕过语义闸）；② 告警由高频小链路提前评分触发、不等日报，保留实时性；③ 原子 claim 防与日报链双评分；④ 时效窗口基于 `published_at`，冷启动/新增源不把历史老文误当重大发布告警；⑤ fail-closed 的 `is_ai_related = true` 闸挡住高 importance 的非 AI 新闻（KVM CVE / 癌症研究 / 探测器一类）；⑥ 闸与回填域由同一构造器生成，两个方向的漂移（饥饿 / 静默丢弃）都在结构上不可能发生；⑦ 支路 B 使「importance 低但改变当日决策」的精确事实变更不再结构性失明，且不以降低任何分数线或新增 LLM 轴为代价。

**P2 局部不变量声明**：本能力的「一事件对每个通道一生只 success 告警一次」依赖「`importance_score` 一经评分即稳定（Value Judge 不重判已评分）」。这是 **P2 局部不变量**；P3 若引入事件合并/重评分（分数可回填重算），必须重新评估告警幂等口径（届时「跨天再次达阈值」可能变为可达，需重新设计 alert 候选窗口）。支路 B 不引入新的重评分风险——词表匹配为纯函数、对同一 `representative_title` 恒定。

#### 场景:高频小链路评分后达阈值的事件被实时告警
- **当** 高频告警工作流采集/塌缩新事件并经 Value Judge 评分后，某事件 `importance_score IS NOT NULL AND >= 阈值`（默认 85）、**`is_ai_related = true`**、`published_at` 在近 N 天窗口内且尚未告警
- **那么** 系统不等每日 08:xx 日报，在该高频链路内即通过配置通道推送该事件告警（**不因 Judge 的 `should_push = false` 而漏推**——告警闸不含 `should_push`）

#### 场景:高 importance 的非 AI 新闻不触发告警
- **当** 某已评分事件 `importance_score >= 阈值`（如 KVM 客户机逃逸 CVE 的 95、从头合成活细胞的 95、Linux LUKS 磁盘加密 bug 的 92——Hacker News 头版的高分**非 AI** 新闻），但其 `is_ai_related` 为 `false`，**或**为 `NULL`（2026-07-10 该列写路径上线前的历史事件）
- **那么** 该事件**不**触发实时告警——AI 闸是**两支路共用**的 fail-closed `= true`，`false` 与 `NULL` **一律排除**（与日报要闻闸 `eq(is_ai_related, true)` 同极性）。`importance` 高只说明「这条新闻重要」，不说明「这是一条 AI 新闻」

#### 场景:低 importance 的精确事实变更经支路 B 被实时告警
- **当** 某已评分事件 `importance_score` 低于告警阈值（如 30 < 85）、**`is_ai_related = true`**，且 `representative_title` 命中精确事实变更词表（如「Claude 终于舍得重置 Fable 5 额度了」「周用量上限提升 50%」「Beyond rate limits: scaling access to Codex」「deprecation of older models」），并满足时效窗口与 Model B 去重
- **那么** 该事件经支路 B 取得告警资格、被实时推送（不因 importance 低而漏推）

#### 场景:未评分事件即使命中词表也不告警
- **当** 某事件因 Value Judge 评分失败 / claim 被日报链抢走 / LLM 降级而 `importance_score` 仍为 NULL，但其 `representative_title` 命中精确事实变更词表
- **那么** 该事件**不**触发实时告警（「已评分」是两支路共用前提，位于 OR 之外）——绝不允许未经 Value Judge 语义闸的事件被推送

#### 场景:非 AI 相关的事实变更帖不告警
- **当** 某已评分事件的 `representative_title` 命中精确事实变更词表（如某随机 SaaS 的「Introducing our new pricing」），但 `is_ai_related` 为 `false`，**或**为 `NULL`
- **那么** 该事件**不**触发实时告警——AI 闸是**两支路共用**的 fail-closed `= true`。支路 B 无 importance 地板，这道闸是它的噪音下限

#### 场景:Judge 判定不推送的事实变更仍经支路 B 告警
- **当** 某已评分事件 `importance_score = 30`、`should_push = false`（Value Judge 认为不值得推）、`is_ai_related = true`，但 `representative_title` 命中精确事实变更词表（如「Claude 终于舍得重置 Fable 5 额度了」——生产实测的真实样本）
- **那么** 该事件**仍然**触发实时告警——支路 B 是有意的「LLM 否决覆盖」通道，`should_push` **绝不**作为其候选条件；否则该支路恒为空

#### 场景:开发者相关性高但非事实变更的事件不告警
- **当** 某事件 `developer_relevance_score` 很高（如 95，典型如厂商开发者博客、Agent 教程、GPU 性能文章）但 `importance_score` 低于阈值，且 `representative_title` 未命中精确事实变更词表
- **那么** 该事件**不**触发实时告警（`developer_relevance_score` 绝不作为告警闸的判据），仅按常规进入日报候选流程

#### 场景:RSS 归档重投的老公告命中词表但不告警
- **当** RSS feed 重新投递一篇旧的定价/弃用公告（如 `Introducing our new pricing`，真实 `published_at` 为 2022-11-08），其 `first_seen_at` 为今天、`representative_title` 命中词表
- **那么** 该事件**不**触发实时告警——时效闸按 `published_at`（真实发布日）判定其早于近 N 天窗口。**这是支路 B 的主要噪音控制**：命中词表的历史老文由时效窗口挡住，而非由任何源级或词级过滤

#### 场景:支路 B 命中但发布时间为空或未来的事件不告警
- **当** 某事件命中词表，但其 `published_at` 经 AI 推断后仍为 NULL，或为未来日期
- **那么** 该事件不触发实时告警——支路 B 只放宽分数闸，NULL 排除 / 未来上界 / tombstone / 基线水位 / Model B 去重 / `ALERT_MAX_PER_SCAN` 一条不减

#### 场景:发布时间过旧的高分事件不告警
- **当** 某事件 `importance_score >= 阈值`，但 `published_at` 早于近 N 天窗口（如历史老文因新增源今日才首次抓到，`first_seen_at` 为今天）
- **那么** 该事件不触发实时告警（按 `published_at` 判定不在近 N 天），不被误当重大发布刷屏

#### 场景:发布时间为未来的事件不告警
- **当** 某达阈值事件 `published_at` 晚于当前时刻（未来日期，无论来自确定性来源还是 AI）
- **那么** 该事件被时效闸上界 `published_at <= now` 排除、不触发告警

#### 场景:不限窗口时仍排除发布时间为空或未来的事件
- **当** `ALERT_FIRST_SEEN_WINDOW_DAYS=0`（不限时效窗口），某达阈值事件经推断后 `published_at` 仍为 NULL，或 `published_at` 为未来日期
- **那么** 该事件仍被排除出告警候选（候选条件退化为 `published_at IS NOT NULL AND published_at <= now`，`windowDays=0` 只免下界 gte、不免 NULL 排除与未来上界）

#### 场景:不支持的窗口与水位组合启动即快速失败
- **当** `ALERT_SCAN_ENABLED='true'`、`ALERT_FIRST_SEEN_WINDOW_DAYS=0`（旁路时效下界）、`ALERT_MIN_PUBLISHED_AT=''`（显式放弃基线水位）三者**同时**配置
- **那么** 系统在启动/注册阶段 **fail-fast**、拒绝注册告警链——该组合使告警候选域（尤其支路 B）扩成**全表历史**，直撞 `policy-push-timeliness`。该守卫由既有三个变量之间的跨字段 `superRefine` 承载，**不新增任何 env 配置项**

#### 场景:告警候选发布时间缺失经 AI 推断或排除
- **当** 某达阈值事件 `published_at` 为 NULL
- **那么** 系统先经 `published-at-inference` AI 推断：推断出明确日期则以回填后的 `published_at` 判定时效窗口；AI 仍无法判定则该事件被排除出告警候选（不告警）

#### 场景:评分前不以 NULL 误判为不达标
- **当** 事件在告警工作流的 Value Judge 评分阶段之前 `importance_score` 仍为 NULL
- **那么** 阈值判定发生在评分之后、不以 `NULL >= 阈值` 恒假误判为「不达标」，确保达阈值事件不被漏告警

#### 场景:低于阈值的已评分事件不触发告警
- **当** 某已评分事件 `importance_score` 低于实时告警阈值（如 80 < 85），**且**其 `representative_title` **未**命中精确事实变更词表、**或**命中词表但 `is_ai_related` 不为 `true`（即支路 A 与支路 B **均不满足**）
- **那么** 该事件不触发实时告警，仅按常规进入日报候选流程
- **场景名「低于阈值…不触发告警」为历史命名**（单支路时期，低于阈值曾是不告警的充分条件），**以正文为准**：本变更后低于阈值**不再单独**构成不告警的理由——还须同时不满足支路 B

#### 场景:高频链路只采实时新闻源排除 arXiv 与 PH
- **当** 高频告警工作流执行采集阶段
- **那么** 只采集 `{rss, hacker_news, github, sitemap}` 实时新闻源（其成员由 source-collectors 权威定义），不采 arXiv（非实时、≥3s 节流）与 Product Hunt（产品源、配额受限）。**该子集只裁剪采集、不裁剪告警资格**——告警候选谓词无 source 条件，`sitemap` 事件（日报链每天全量采）在其进入本子集之前就已具备告警资格；纳入本子集的收益是把采集延迟从 ≤24 小时压到 ≤20 分钟

#### 场景:器物名工具帖不触发支路 B（Title Case 同样挡住）
- **当** 某已评分事件 `is_ai_related = true`、`importance` 低、`representative_title` 为 HN 的真实标题「**Show HN: A Rate Limiter for LLM APIs**」（**Title Case**）——它命中正向词表的 `rate limit`（`%rate limit%` 无词边界）
- **那么** 该事件**不**触发告警——支路 B 的谓词带 `NEGATIVE_PATTERNS` 否定合取项（器物名 `rate limiter` / `限流器` / `速率限制器`），且**该否定项与正向支路复用同一个 `lower(representative_title)` 表达式**。**写成裸 `representative_title LIKE ANY (…)` 绝不可用**：词表全小写、PG `LIKE` 区分大小写 ⇒ 否定项匹配不到 Title Case 的 `Rate Limiter` ⇒ `NOT(false)` = true ⇒ **手机照震**，而全小写样例的测试恒绿、无人察觉
- **且** 真的限流变更公告「Improved **rate limiting**」「**Beyond rate limits**: scaling access to Codex and Sora」「… and 3000× **Rate Limit** Increase」**照常告警**——**`rate limiting` MUST NOT 入否定项**（公告常用动名词，非器物名）。方向不对称是有意的：**漏一条真变更**正是支路 B 要防的失效，**误震一次博文**只是烦人、可恢复

#### 场景:每轮工作预算只裁告警链、日报链保持全量
- **当** 未评分事件数**大于**告警链的每轮预算 N（如 6 > N，默认 3），日报链跑判分阶段（**不传**该预算选项）
- **那么** 日报链**全部判完**（判分保持无界）——预算的默认值 MUST 为「无界」，**MUST NOT** 把模块常量 N 写成缺省值（`options.maxPerRun ?? N`）。写反这一条会把日报链一并截到 N 条/天 ⇒ 要闻段枯竭，且**告警链「不饥饿」的唯一依据**（老事件由无界的日报链在 ≤24h 内排空）**当场坍塌** ⇒ 老事件永久积压。**该失效对 fixture ≤ N 条的测试完全不可见**，故 MUST 有此回归钉

#### 场景:是否告警由程序阈值决定
- **当** 判定某事件是否触发实时告警
- **那么** 判定完全依据程序阈值与确定性规则（支路 A 的数值比较 / 支路 B 的词表匹配），禁止由 LLM 决定是否触发

#### 场景:告警扫描 cron 的分钟展开集不落整点半点
- **当** 检视 `ALERT_SCAN_CRON` 的默认值与生产覆盖值，把各自的分钟字段按 `*` / `*/n` / `a-b` / `a-b/n` / `a/n` / `a,b,c` / 纯数字**展开为分钟集合**
- **那么** 两者的展开集与 `{0, 30}` 的交集均为空（默认值 `4-59/15 * * * *` → `{4,19,34,49}`）；步进式 `*/15`（→ `{0,15,30,45}`）与 `*/20`（→ `{0,20,40}`）因展开集含 `0` 被判违反，不得用作默认值或生产值——生产覆盖值不在代码里，故其改写是部署步骤的强制项

### 需求:P0 实时告警质量可观测

系统必须为实时告警提供可观测口径,支撑「精确/召回、噪音率」的人工抽检——这是「大事发生时先从即时推送知道、噪音可忍」这一上线判据的验证信号。每次高频扫描完成后,系统必须以结构化日志/事件记录本次:达阈值并推送的告警计数、命中事件的 `importance_score`（供分布/边界抽检）、以及各告警事件的 `event_id` 与命中的 `channel`。记录必须为**确定性程序输出**（非 LLM 判断质量）,不得引入新的对外副作用（只记录、不额外推送）。

**上线/回滚判据必须可由数据库复算，绝不可只依赖上述结构化日志（本需求修改点）**：上述结构化记录经 console.error 落进程 stderr 输出（仓内未装 pino），而系统**不落库 run 事件、也不做日志聚合**——把「观察 N 天的告警质量」建立在它之上，判据在证伪任何东西之前就已**不可执行**（无处查询、无留存保证）。故告警质量的**观察判据与回滚判据 MUST 定义为 `push_records` ⋈ `ai_news_events` 上的确定性复算**。复算是 DB 列（＋同一词表构造器的纯函数出口）的**纯函数**，**不需要任何新表、新列或日志聚合基建**，且可随时重跑。结构化日志保留为实时旁路信号，但 **MUST NOT** 作为判据的唯一载体——**包括支路 B 的回滚判据**（它 MUST NOT 去数只落在 stdout 的告警候选事件）。

**噪音口径 MUST 逐项定死（写错任一项都会让判据静默失效）**：噪音 = 观察窗内的推送中，同时满足下列**全部**条件的条数——

1. `target_type = 'alert'` **且 `status = 'success'`**——**`status` 谓词绝不可省**：dispatcher 先写 `pending`、失败置 `failed`，不带 `status` 的复算会把未送达的记录也算成「已推送」；
2. 其事件**两条支路皆不满足**告警闸——即 `importance_score` 为 NULL、**或 `is_ai_related` 不为 `true`**、或（`importance_score < ALERT_IMPORTANCE_THRESHOLD` **且【支路 B 判定不为真】**）。**支路 B 判定 = `representative_title` 命中词表 ∧ 不命中 `NEGATIVE_PATTERNS`**——只写「未命中词表」会把「命中词表却被否定项挡下、仍被推送」的工具帖漏出噪音口径；且 `representative_title` 为 NULL 时该判定按【不为真】计（SQL 侧 MUST 用 `(…) IS NOT TRUE` 承载，防三值逻辑把 NULL 行漏出口径）。

**支路 B 的低分命中是【设计内的低分告警】，MUST NOT 被计入噪音**——否则回滚判据会把本能力自己当噪音关掉。**阈值 MUST 从 `ALERT_IMPORTANCE_THRESHOLD` 读取，MUST NOT 在判据 SQL 里硬编码字面量**（生产改阈值时硬编码的判据会静默失灵）。

**触发支路必须可归因，且取值 MUST 定死为三元 `{'importance', 'fact-change', 'unknown'}`（本需求修改点）**：可观测记录 MUST 为**每条告警候选**额外标注其**由哪条支路取得资格**：

```
trigger = (importance_score >= ALERT_IMPORTANCE_THRESHOLD) ? 'importance' : 'fact-change'   -- 支路 A 优先
```

**支路 A 优先（绝不可省）**：`matchedKeywords` MUST **仅在 `trigger='fact-change'` 时记录**。词表匹配的 TS 出口是**纯标题函数**，一条经支路 A 正常入选的高分事件若标题恰含词表词，该函数会返回非空——故实现 MUST NOT 以 `matchedKeywords.length > 0` 反推 `trigger`，否则该条会被误标 `fact-change`、**误触发上线核验的回滚判据**（把一个正常工作的功能当噪音关掉）。

**`importance_score` 为 `NULL` 的候选按构造不可达（「已评分」前提已在闸中排除），实现 MUST 走显式的 NULL 分支**：记一条 **error 级结构化日志**并把该候选标为 `trigger='unknown'`。

- **MUST NOT 抛错中止 P0 车道**：可观测记录在**全部 dispatch 之后**发射、且不在 try/catch 内——抛错会让整轮扫描 fail、经 BullMQ 重试**整轮重跑**（采集 / 补全 / 评分 / 回填），且此时告警的对外副作用**已经发生**。为一个不可达分支付这个代价，远重于它防的错。
- **陷阱在三元表达式本身，不在缺省值**：`null >= 85` 在 JS 中**静默求值为 `false`**——**无需任何 `?? 0` 之类的兜底**，上面那行三元自己就会把 NULL 候选静默归成 `'fact-change'`，污染以 `trigger='fact-change'` 计的回滚判据。`'unknown'` 这个取值的全部意义就是让这条静默路径**在日志里显形**。

归因 MUST 由与告警闸**同一个**词表构造器的 TS 出口对该候选的 `representative_title` 复算得出（≤ 单轮上限条，成本可忽略），MUST NOT 另写一份词表。归因为**纯附加字段**：MUST 经既有结构化日志/事件通道输出，MUST NOT 新建通道，MUST NOT 改变告警行为。

> 口径说明：现有可观测记录在 dispatch **之后**以**候选**（含 `skipped-locked` / `failed` 结局）为单位发射，故归因的单位是「告警**候选**」而非「已成功推送的告警」——如此可零语义改动地附加字段。

**结构化记录不含 `is_ai_related`（诚实边界，MUST 写明）**：告警闸的 AI 闸在旁路信号里是**盲的**——`hits[]` 不带该列，故「AI 闸是否失效」**无法从日志看出**，只能由上述 DB 复算得出。本期接受（复算能兜），如实登记。

**可观测只能校准误报、校准不了漏词（诚实边界，MUST 写明）**：未命中词表的事件**不产生任何记录**，故「真实变更被漏推」在本可观测口径下**恒不可见**。词表的漏词只能靠人工发现「某条该推的没推」或离线全量回放来暴露；系统 MUST NOT 声称本可观测能迭代出漏词。**鉴于支路 B 的实测量级仅为 ≤1 条 / 30 天，漏召是本能力的主要残余风险**（而非误报）。

**可观测无法区分「支路 B 在工作」与「支路 B 已损坏」（诚实边界，MUST 写明）**：支路 B 的期望值就是「几乎什么都不出现」，故「上线后什么都没看到」既是正常、也是恒空失效的表征。**任何观察期或开关都区分不了这两者**——唯一能区分的是**上线前在最终词表上跑的离线历史回放**（三列对照：不带闸的词表命中集 / 加全部支路 B 谓词的真实命中集 / 高分命中词表的单独计数）。系统 MUST NOT 以「观察 7 天没噪音」为由声称支路 B 已验证生效。

**该回放的强制重跑触发条件 MUST 为「改词表 _或_ 改采集源集合」之后**，MUST NOT 只写「改词表后」：假阳/命中面是**语料**的函数，而语料由 P0 车道的采集源集合决定（本变更自己就在改它——`sitemap` 进 `REALTIME_NEWS_SOURCES`）。

**回放的【分辨率上限】MUST 一并登记（否则它会被当成一道它当不起的守卫）**：回放能证伪的只有「**整表恒空**」——**它证伪不了「除某一个词之外全部失效」**。30 天生产语料上它的**唯一命中样本**（「…重置 Fable 5 **额度**了」）是由 **`额度`** 一个词命中的 ⇒ **删掉除 `额度` 外的全部 23 个词，回放依然「① = ② = 1」、验收判据依然全绿**。故：系统在把它称作「唯一能证伪恒空的东西」时，MUST 同时声明这条上限；**逐词的召回不由回放守护，只能由「改核心词 MUST 对两个出口逐一裁决」这条纪律守护**（见 conversational-rag「已知代价二」）。

#### 场景:每次扫描记录 P0 告警质量口径
- **当** 一次高频告警扫描完成并推送了 N 条 P0 告警（N ≥ 0）
- **那么** 系统结构化记录本次告警计数 N、各命中事件的 `importance_score` 与 `event_id`/`channel`,供人工抽检精确/召回与噪音率,且不产生额外对外推送

#### 场景:可观测记录不改变告警行为
- **当** 记录 P0 告警质量口径
- **那么** 该记录为纯旁路观测,不影响是否告警的确定性阈值判定、不重复推送、不阻塞或改变告警链其余阶段

#### 场景:告警质量判据由数据库复算而非日志留存
- **当** 观察期内需核验 P0 告警质量（噪音率 / 命中分数分布 / 支路归因）或判定是否回滚，而结构化日志只落在进程 stderr（console.error）、无落库无聚合
- **那么** 判据仍可执行——由 `push_records`（`target_type='alert'` **且 `status='success'`**）与 `ai_news_events` 的连接**确定性复算**得出（噪音 = 两条支路皆不满足的条数：`importance_score` 为 NULL，或 `is_ai_related` 不为 `true`，或低于阈值且支路 B 判定不为真（命中词表 ∧ 不命中否定项，NULL 标题按不为真计）；**支路 B 的低分命中不计入噪音**；阈值从 `ALERT_IMPORTANCE_THRESHOLD` 读取、不硬编码），不依赖日志的留存或聚合，且复算为纯读、不产生任何对外副作用

#### 场景:P0 告警候选记录其触发支路与命中词
- **当** 某告警候选 `importance_score` 低于阈值、经支路 B（精确事实变更词表）取得告警资格
- **那么** 可观测记录标注 `trigger='fact-change'` 及命中的具体词条，供事后校准词表的误报

#### 场景:高分事件标题恰含词表词时归因仍为 importance
- **当** 某事件 `importance_score = 90 >= 阈值`（经支路 A 取得资格），且其 `representative_title` 恰含词表词（如「OpenAI 发布新模型并调整 pricing」）
- **那么** 可观测记录标注 `trigger='importance'`（支路 A 优先）、**不**记录 `matchedKeywords`——绝不因标题含词而误标为 `fact-change`、误触发回滚判据

#### 场景:归因遇 NULL importance 记 error 但不中止车道
- **当** 某告警候选的 `importanceScore` 为 `null`（按构造不可达）
- **那么** 归因走**显式 NULL 分支**：标 `trigger='unknown'`、记一条 error 级结构化日志，且**不抛错**——可观测记录的发射在全部 dispatch 之后且不在 try/catch 内，抛错会在副作用已发生的情况下炸掉整轮扫描并触发 BullMQ 整轮重跑
