## MODIFIED Requirements

### 需求:缺失发布时间的 AI 语义推断

系统必须提供一个独立能力：对 `ai_news_events.published_at` 为 NULL 的事件，由 Agent 从其代表 raw_item 的可得线索（标题、`canonical_url`、正文/摘要、源标识等）**语义推断**文章发布日期。该能力的定位等同现有 Value Judge 评分 Agent——**只填补 `published_at` 这一语义空缺**，禁止参与「是否够新 / 是否推送」的状态判断（状态与最终过滤由程序和 DB 确定性保障）。

Agent 输出必须为**结构化 JSON 并经 Zod schema 校验**：至少包含「推断出的发布时间」（可为「无法判定」）与可选的置信度/依据。无法判定时必须显式返回「无法判定」，系统据此保持该事件 `published_at` 为 NULL（不得回填臆造时间）。

**推断结果必须经合理范围校验，越界等同「无法判定」（绝不可省）**：推断日期必须满足 `合理下限 <= 推断日期 <= now`——**不接受未来日期**（晚于当前时刻），也不接受荒谬过早日期（早于合理下限，如早于 1990 或早于该源域上线年份）。越界的推断结果必须按「无法判定（NULL）」处理、不得回填。此约束是本能力的命门：若放任未来/荒谬日期回填，`gte(published_at, lowerBound)` 时效闸对未来日期恒为真，会让被推断错的事件**绕过时效闸**。Zod schema 必须以 refine 表达该范围；回填 SQL 必须再以 `WHERE 推断日期 <= now()` 兜底（双层防御）。

所有外部 LLM 调用必须带**重试与错误日志**。推断调用失败 / 超时必须按「无法判定（NULL）」**降级**处理：不得阻塞或中止整条流水线，**绝不得**把失败误回填为「现在 / 抓取时间 / 任意默认时间」。

推断成功（返回通过范围校验的明确日期）时，系统必须把该日期回填到 `ai_news_events.published_at`，供下游候选窗口的确定性时效过滤使用。

**确定性来源必须优先于 AI（绝不可违背第一架构原则：DB 控事实、不交 LLM）**：AI 推断只是**最后手段**。任一与该事件关联的 `raw_item` 若带确定 `published_at`，该确定值必须优先落库、**禁止**改由 LLM 推断。去重塌缩层以 identity-preserving 的 `COALESCE` NULL-fill 保证此点（见 `dedup-and-normalization` 的「再次塌缩」：`ON CONFLICT DO UPDATE` 在事件 `published_at IS NULL` 时用后到 `raw_item` 的非 NULL `published_at` 补值，绝不覆盖已设值、不动身份/代表/`first_seen_at`）。因此进入 AI 推断阶段的事件，必是**所有**关联 `raw_item` 均无发布时间者；AI 推断结果绝不得覆盖任何确定来源的值。

**回填必须并发安全：以 DB 层 CAS 保证「不覆盖已非 NULL」（绝不可省）**：日报链与实时告警链是各自独立的定时/触发任务，可能**并发**对同一 NULL `published_at` 事件触发回填。回填写入必须为条件更新 `UPDATE ai_news_events SET published_at = ? WHERE event_id = ? AND published_at IS NULL`（DB 层 compare-and-set）——先写者落值，后写者 `WHERE` 不命中自动空操作，**绝不覆盖**已非 NULL 的值（无论该值来自采集解析、塌缩 COALESCE 还是另一链路的先一步回填）。为避免两链路对同一事件**重复调用 LLM**（浪费 + 配额），推断前必须以**独立的 Redis per-event 单例锁** `published-at-infer:{event_id}` 抢占后再调。该锁**复用** `alert-lock.ts:acquireAlertLock` 的获取/释放语义、并在其外加一层降级（不落库），职责分层须明确：① 获取：`SET key <token> NX PX <ttl>` 原子获取（同 `acquireAlertLock`）；② TTL 必须覆盖「单次推断 + 单次 CAS 写」最坏时长（锁键不含时间，无 TTL 且崩溃未释放会永久死锁该事件回填，故 TTL 不可省）；③ 释放：**调用方**在 `finally` 中经核对 token 的脚本释放（同 `acquireAlertLock` 返回 handle 的 `release()`，由 caller 的 `finally` 调用），防误删他人锁；④ 未抢到锁 → 跳过本事件、由 CAS 兜底正确性；⑤ **Redis 自身异常**（`acquireAlertLock` 在 SET 出错时**会抛**，故新模块必须 try/catch **把该抛错降级**为「跳过本事件回填」、记日志、**不抛断流水线**——这是新模块在 `acquireAlertLock` 之外**额外加的**一层，非 `acquireAlertLock` 本体行为）。**禁止复用评分链的 `judge_claimed_at` 列**：该列条件绑定 `importance_score IS NULL`、语义为「未评分 claim」，而回填发生在评分之后（目标事件 `importance_score` 已非 NULL），复用会与评分 claim 争用同列、语义冲突。故回填防重复一律走 Redis 锁、不碰 DB claim 列。

**回填阶段自身的失败（含 DB 写异常）必须降级、不得中止流水线**：回填 CAS 的 **DB 写异常**（连接挂 / 死锁等）与 LLM 调用失败同样必须被 catch、按该事件「未回填」降级处理（遵项目既有「写库异常计降级、不抛」口径，同 Value Judge 评分阶段），绝不冒泡中止 `runDailyWorkflow()` / `runAlertScan()` 的其余阶段。

**回填规模必须受独立上限约束、且不对「注定出窗」的积压做无效推断（绝不可省）**：回填阶段在「选 Top N / 应用单次告警上限」**之前**执行，其作用域由**该链路的候选资格条件** + `published_at IS NULL` 决定，**可能远大于** Top N 条数或单次告警上限——故 Top N / `ALERT_MAX_PER_SCAN` **限不住**回填的 LLM 调用量。系统必须为回填设独立的单次上限（`PUBLISHED_AT_INFERENCE_MAX_PER_RUN`），回填查询须 `ORDER BY first_seen_at DESC LIMIT <上限>`（优先最近首见的），超出者下轮补填。回填作用域还必须加 `first_seen_at >= 时效窗口下界`：`first_seen_at` 已超出时效窗口的存量 NULL 老事件——即便推断出发布时间也必被时效闸排除——不再纳入回填，避免冷启动积压老事件每轮占满 LIMIT 配额、饿死近期 NULL 事件并做无效 LLM 推断。窗口内仍判不出的事件随 `first_seen_at` 滑出窗口自然停止重试（有界，无需持久 attempt 状态列）。

**回填作用域必须与其所服务链路的候选闸同构（本需求修改点，绝不可省）**：回填的**唯一目的**是让「本会成为该链路候选、却因 `published_at IS NULL` 被时效闸排除」的事件重获资格。故其作用域 MUST **逐链路**与该链路的候选闸**同构**：

| 链路 | 回填作用域 |
|---|---|
| 日报链 | `should_push = true`（不变） |
| **实时告警链** | **`importance_score IS NOT NULL AND is_ai_related = true AND ( importance_score >= ALERT_IMPORTANCE_THRESHOLD OR representative_title 命中「精确事实变更词表」 )`** |

告警链的作用域**由「达阈值」扩为「已评分 ∧ `is_ai_related = true` ∧（达阈值 **或** 精确事实变更词表命中）」**——与 realtime-alerts 的两支路告警闸**共享同一个分数/词表/AI 谓词构造器**（非「完全同构」，见下方澄清）。`is_ai_related = true` 是**两支路共用**的 fail-closed 前提（由 realtime-alerts 权威定义），落在 OR 之外。

**动因：回填域与告警闸不等 ⇒ 两个方向都会静默丢事件**。告警链的「精确事实变更」支路按定义捕获**低 importance** 事件：若回填作用域只覆盖支路 A（达阈值），一条 `published_at IS NULL`、命中词表且 importance 低的**非豁免源**条目就会被**静默丢弃**——`published_at` 永为 NULL → 被时效闸的 NULL 排除踢出候选 → **永不告警**，且该漏推按 realtime-alerts 的可观测口径**不可见**。反向偏离同样是缺陷（见下「两个偏离方向」）。故闸与回填域 MUST **同源扩展**。

**今日流量口径（如实登记，防把零流量当收益）**：本次改域**今天就有实收益**的那一半是 `is_ai_related` 合取项——它把「高 `importance` 的非 AI 新闻」（按告警闸**永不告警**）移出回填域、不再占 LIMIT 名额。**词表支路那一半当前零流量**：rss / hacker_news / github 的 `published_at` 实测 0 条 NULL；而唯一会因**采集期页面日期提取失败**产出 NULL 的 `sitemap` **已被整源豁免**（见本能力的「确定性提取源豁免 AI 发布日推断」需求——豁免源的 NULL 事件 MUST NOT 进回填域）。故词表支路的扩域是**结构正确性储备**，规定的是「日后某个**非豁免**源出现无发布时间条目」时的行为；**MUST NOT 被表述为「让 `sitemap` 的提取失败条目取得被推断的机会」**——那与豁免需求直接矛盾。

**告警链的回填域谓词与其告警闸谓词 MUST 由【同一个构造器】生成，且 MUST 恰好相等——两个偏离方向都是缺陷（绝不可省）**：

- **回填域比告警闸【宽】——不是「浪费配额」，是【饥饿】。** 回填查询带**固定单次上限** `LIMIT PUBLISHED_AT_INFERENCE_MAX_PER_RUN`（默认 **20**）+ `ORDER BY first_seen_at DESC`。**有固定 LIMIT 就有饥饿**：宽出去的那些事件（如**高 importance 的非 AI 新闻**——它们被 AI 闸挡住、**永不告警**）会**占掉 LIMIT 的名额**，把真正在闸内、`published_at IS NULL` 的事件**挤出本轮回填** → 保持 NULL → 被时效闸的 NULL 排除挡住 → **永不告警、且在可观测里不留任何痕迹**。**这正是本需求上一段自己列为要防的危害（「饿死近期 NULL 事件」）。** 故「回填域比闸宽只是浪费配额、属安全方向」的说法 **MUST NOT 被采信**。
- **回填域比告警闸【窄】——静默丢弃候选**（见上「动因」：提取失败 + 命中词表 + 低 importance 的事件连被推断的机会都没有）。

⇒ 两个方向都会导致「本该告警的事件永不告警且无痕迹」。**唯一正确的形态是相等**，而保证相等的方式 MUST 是**结构**（同一个构造器），MUST NOT 是**纪律**（两处各写一份 + 一段「不要写歪」的警告——那必然漂移）。

> **「同构」仅指该共享谓词（澄清，防 overclaim）**：回填域另有自己的合取项——`published_at IS NULL`、`first_seen_at` 超窗剪枝、**豁免源排除**（`source` 不在豁免名单内，本期名单 = `{sitemap}`，见「确定性提取源豁免 AI 发布日推断」）、以及**代表 raw_item 存在**（回填查询用 **INNER JOIN** `raw_items`，而告警闸用 **LEFT JOIN**）。故 `representative_raw_item_id` 为 NULL 的事件**进得了告警候选、进不了回填域**——这不构成缺陷（无代表 raw_item 即无线索可推断日期），但 MUST NOT 被描述为「完全同构」。回填域扩大后的量仍由 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 封顶；取序 `first_seen_at DESC` 对两支路无偏，且非豁免源在采集期均产出确定 `published_at`（实测 0 条 NULL）、豁免源的 NULL 事件根本不入池 ⇒ 回填域里 `published_at IS NULL` 的池**近乎空**，两支路不构成互相饿死。

> **豁免源排除是该等式的【显式例外】，MUST NOT 被当作上面那种「窄」缺陷**：豁免谓词使回填域在 `sitemap` 上**严格窄于**告警闸。这看似踩中「回填域比告警闸窄 ⇒ 静默丢弃候选」，但两者性质相反：那里的「窄」是**无人论证的漂移**（本该有机会被推断的事件连机会都没有）；这里的「窄」是**被论证过的取舍**——该源的标题 / URL / 正文**全无日期线索**，推断 = 从模型训练记忆里猜，而猜错的日期**天然落在合理范围内** ⇒ 范围校验 / 时效窗口 / 基线水位**一道都挡不住** ⇒ **老文被当今日突发推送**。豁免后的降级方向是**「无发布日 ⇒ 不推送」**（宁可漏），不是静默错推。**「同一个构造器」的约束只作用于「分数 / 词表 / AI 谓词」这一段**；豁免谓词是它之外的独立合取项——两条需求**不冲突**。

> **稳态成本（登记）**：判不出（`undetermined`）的事件保持 `published_at = NULL`，会在 `first_seen_at` 滑出时效窗口前**每轮被重新推断一次**（告警链每天数十轮，直至滑窗停止，有界）。本次改域对该循环的净效应为**不增、略减**：词表支路带进来的「NULL + 命中词表 + 低分」条目**当前零流量**（唯一会产出提取失败 NULL 的 `sitemap` 已整源豁免、不入池；其余源实测 0 条 NULL），而 `is_ai_related` 合取项**移出**了一批永不告警的非 AI 事件、把 LIMIT 名额还给闸内事件。**站点改版致 `sitemap` 页面日期提取批量失败时亦不产生 LLM 成本**（豁免 ⇒ 那批 NULL 事件根本不进回填域，其降级方向是「不推送」）。量级仍由 `PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 封顶，MUST 显式登记、不得成为惊喜。
>
> **开闸把该重试循环的放大系数抬到 72–96×/天（MUST 显式登记，不得沉默）**：「判不出」**不写任何标记**——`src/agents/published-at-inference/backfill.ts:230-238` 只 `undetermined += 1; continue;`，**无 attempt 计数、无负缓存**，Redis 锁在 `finally` 即释放。⇒ 同一条判不出的事件**下一 tick 仍在候选集里**，每 15–20 分钟被重新推断一次，直到 `first_seen_at` 滑出时效窗（默认 3 天）——最坏约 **288 轮 × 每轮至多 LLM 重试上限次调用**。**这与本变更登记的「每天 72–96 次 `sitemap.xml` GET」是同一个放大系数**，只是落在 LLM 调用上；对每 tick 成本登记到那种细度，就 MUST NOT 对这一条沉默。
>
> **实际域很小，故本期不强制修**：`rss` / `hacker_news` / `github` 的 `published_at` 实测 0 条 NULL，`sitemap` 已整源豁免出回填域 ⇒ 当前池近乎空、钱不多。**廉价闸作为可选补救**（本期不做，日后池变大时 MUST 先做它、而不是加 LIMIT）：给「判不出」写一个负缓存标记（如 `infer_attempted_at` 列或一个带 TTL 的 Redis 键），使同一事件在窗内不被反复送判。**MUST NOT** 以「反正现在零流量」为由把这个放大系数从成本登记里省掉。

**回填 MUST 在 Value Judge 评分之后、选候选之前执行**：告警链的回填作用域以 `importance_score IS NOT NULL` 为前提（与告警闸同构），若把回填排在评分之前，该前提恒假、回填域恒空。告警链的阶段序权威表述见 realtime-alerts。

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
- **当** 冷启动存量有大量 `published_at IS NULL` 且落在某链路回填作用域内的事件，远多于 Top N / 单次告警上限
- **那么** 单轮回填按 `ORDER BY first_seen_at DESC LIMIT PUBLISHED_AT_INFERENCE_MAX_PER_RUN` 只处理最近首见的若干条，超出者下轮补填，不触发一次性 LLM 成本尖峰

#### 场景:命中词表的低分 NULL 事件（非豁免源）仍落入告警链回填作用域
- **当** 一条**非豁免源**（`source` 不在豁免名单内）的事件 `published_at = NULL`、经 Value Judge 评分为低 `importance`（如 60 < 85）且 `is_ai_related = true`、其 `representative_title` 命中精确事实变更词表
- **那么** 该事件**落入**告警链的回填作用域（作用域 = 已评分 ∧ `is_ai_related = true` ∧（达阈值 **或** 词表命中）∧ 非豁免源）——**这是本场景要守的唯一不变量：作用域若只覆盖支路 A，该事件连被推断的机会都没有，会被静默丢弃**。推断能否成功**不作断言**：线索不足时 Agent 返回「无法判定」、`published_at` 保持 NULL、该事件**不告警**——**这是正确的失败方向**（宁可漏，绝不把老文洗成今日发布）
- **且** 若该事件的源**在**豁免名单内（本期 `sitemap`），则**无论是否命中词表**都不进回填域（见「确定性提取源豁免 AI 发布日推断」）——**豁免优先于本次扩域**

#### 场景:告警链回填域不覆盖既不达阈值也不命中词表的低分事件
- **当** 某已评分事件 `importance_score` 低于告警阈值，且其 `representative_title` **未**命中精确事实变更词表，`published_at` 为 NULL
- **那么** 该事件**不**落入告警链回填作用域、不消耗 LLM 推断配额（与扩域前的行为一致——扩域只增不减）

#### 场景:回填域的支路 B 谓词含 is_ai_related 闸
- **当** 某已评分事件的 `is_ai_related` 为 `false` 或 `NULL`——无论它是「低于阈值但命中词表」（支路 B 侧），还是「高 importance 的非 AI 新闻」（支路 A 侧，如 KVM 逃逸 CVE）；两者按告警闸都**永不告警**
- **那么** 该事件**不**落入告警链回填作用域——AI 闸是两支路**共用**前提，回填域与告警闸由**同一个构造器**生成，绝不为永不告警的事件白耗 LLM 推断配额
