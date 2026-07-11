## 修改需求

### 需求:实时告警独立幂等口径

系统必须以 `push_records` 唯一约束保障实时告警不重复推送。告警四元组必须为 `target_type='alert'`、`target_id=event_id`、`channel`、`push_date=告警触发当日（Asia/Shanghai，与日报 push_date 时区同源）`。独立 `target_type='alert'` 使其与日报推送（`target_type='event'`）在 `push_records` 中互不挤占——禁止复用日报四元组，否则「当日日报已 success 推过该事件」会使实时告警因唯一键冲突被静默吞掉（漏告警），反之亦然。

**幂等语义为「一个事件对每个通道一生只 `success` 告警一次」**（统一模型 Model B：选题与通道解耦 + 各通道可靠补发）：`ai_news_events.importance_score` 一经 Value Judge 评分即稳定（Value Judge 不重判已评分事件），故告警分数不会跨天变化，「跨天再次达阈值」在本系统结构上不会发生、不设此行为。告警候选（channel-blind 选一份）必须满足「该 `event_id` **尚未 alert-success 投递给所有已配置通道**」（alert-success 覆盖的 distinct 已配置通道数 < 配置通道数）——只要还差任一通道未 alert-success 就留在候选；选出的告警事件**同份发放给所有已配置通道**（通道只投递、不参与选题）。**各通道可靠补发（不丢告警）**：各通道经 dispatcher `computePendingSet` 按 **per-channel 跨天**（该 channel 从未 alert-success）独立投递——某通道（如飞书）告警失败时该事件在该 channel 无 success → 跨次扫描仍在该通道待发 → 可靠补发，已 alert-success 的通道（如 telegram）被排除、不重发；同日并发由 `UNIQUE(alert, event_id, channel, push_date)` 兜底。一旦所有已配置通道都 alert-success → 该事件移出告警候选（不再重选）。

告警推送必须**复用 telegram-push/feishu-push 的同一套「待发→`pending`→原子送达→`success`/`failed`」状态机核心**（仅 `target_type` 与幂等键口径不同），禁止另写一套漂移的状态机。**告警消息必须渲染事件原文链接**：链接取该事件 `representative_raw_item_id` 回指 `raw_items.canonical_url`（`canonical_url` 已在采集期经 `normalizeUrl` 去除 utm/ref/gclid 等追踪参数）。该回指**必须是 LEFT JOIN / 相关子查询、绝不 INNER JOIN**：当 `representative_raw_item_id` 为 NULL 或对应 raw_item 行已被塌缩删除时,达阈值事件**仍须留在告警候选**（消息无链接）——**绝不因回指失败丢候选造成漏告警**（漏告警比无链接更糟）。`canonical_url` 为 NULL 时消息可无链接、不报错。**告警推送前必须对入选候选中缺中文摘要者补一次轻量中文摘要**：对入选告警候选（数量受 `ALERT_MAX_PER_SCAN` 上限约束、极少）中 `headline_zh`/`summary_zh` 为 NULL 者,复用中文摘要 Agent（`chinese-digest-agent` 的 `summarizeEvent` per-event 调用）生成 `{headline_zh, summary_zh}` 并持久化（经 `digestEvent`;供该事件后进日报被「已摘要守卫」复用、不重复摘要），使告警渲染的 `headline_zh` 为中文而非原始英文标题（「轻量」指只对 ≤ `ALERT_MAX_PER_SCAN` 条入选候选跑、非更轻的调用）；**仅当摘要生成失败时**,渲染降为复用 telegram-push 的 headline 回退链（`headline_zh` → `summary_zh` 截断 → `representative_title` → 仅标题）——回退链是兜底,摘要缺失/生成失败**绝不**报错或漏告警。告警推送路径必须带**独立单例锁** `alert:{event_id}`（**per-event，覆盖该事件向所有通道的分发**）或 DB 原子 claim，防两并发实例对同一告警事件重复分发（唯一约束挡不住并发双读双发）；单通道发送失败隔离、不拖垮该事件的其余通道。该锁必须为 job 级短时持有 + 完成/崩溃后可靠释放（带 TTL 或 `finally` 释放）——锁键含 `event_id` 但不含时间，若无 TTL 且崩溃未释放会使该事件告警永久死锁，故释放语义不可省（同 telegram-push 单例锁的 TTL/释放要求）。

#### 场景:日报已推同一事件仍可发实时告警
- **当** 某事件当日已作为日报（`target_type='event'`）success 推送
- **那么** 该事件的实时告警（`target_type='alert'`）不因日报记录而被唯一键冲突吞掉，仍可独立推送

#### 场景:已告警给所有通道的事件不再重复告警
- **当** 同一已评分达阈值事件已 alert-success 投递给所有已配置通道，后续轮询再次扫到
- **那么** 该事件因「尚未 alert-success 投递给所有已配置通道」候选条件不满足（已全部告警）而被排除，不再重复告警；同日并发重复触发亦由 `UNIQUE(alert, event_id, channel, push_date)` 兜底跳过

#### 场景:某通道告警失败后跨次可靠补发
- **当** 某达阈值事件 telegram 告警 success、飞书告警失败（飞书无 alert-success），已配置 telegram + feishu
- **那么** 该事件仍在告警候选（飞书尚缺）；后续扫描其飞书 `computePendingSet` 纳入它（飞书从未 alert-success）可靠补发，telegram 被排除不重发——不丢告警

#### 场景:告警消息渲染中文摘要与原文链接
- **当** 某入选告警候选缺 `headline_zh`/`summary_zh`,且其 `representative_raw_item_id` 回指的 `raw_items.canonical_url` 非空
- **那么** 系统推送前对其跑一次轻量中文摘要生成中文标题/摘要,并在消息中渲染该规范化原文链接

#### 场景:摘要生成或持久化失败走回退链不漏告警
- **当** 某入选告警候选的中文摘要**生成**（LLM 超时/报错）**或持久化**（`digestEvent` 抛 DB 异常）失败
- **那么** 该事件仍被告警——逐条 try/catch 隔离,渲染降为 headline 回退链（`headline_zh` → `summary_zh` 截断 → `representative_title` → 仅标题）,不因摘要生成/持久化失败报错或漏告警

## 新增需求

### 需求:首次启用发布时间基线水位(防旧消息刷屏)

为守 `policy-push-timeliness`(禁上线后批量推旧消息),实时告警候选条件 SHALL 额外受一个**可选发布时间基线水位** `ALERT_MIN_PUBLISHED_AT` 约束:当其配置为一个 ISO 时刻时,告警候选须额外满足 `published_at >= 该基线`(与现有时效下界取 `max`,即有效下界 = `max(时效下界, 基线)`)——**只告警基线之后发布的新闻**,启用前发布的存量(无论何时被评分、无论后加了哪个通道)一律排除。该水位是确定性程序谓词(非 LLM)、写在候选查询、**不写任何 `push_records` 假记录**;`ALERT_MIN_PUBLISHED_AT` 的值 SHALL 被校验为合法 ISO 时刻(或显式空串 opt-out),非法值 SHALL 启动 fail-fast(非静默匹配空/静默压制全部)。

**启用告警而未显式给出基线 SHALL 快速失败**:`ALERT_SCAN_ENABLED='true'` 但 `ALERT_MIN_PUBLISHED_AT` **未设置**(既非 ISO 时刻亦非显式空串 opt-out)时,系统 SHALL 在启动/注册阶段拒绝注册告警链并 fail-fast——防「启用却忘设基线 → 存量 P0 刷屏」这一 `policy-push-timeliness` 事故;运维须显式二选一:给 ISO 基线,或空串明示放弃基线、自担刷屏风险。

#### 场景:配置基线水位时只告警启用后发布的新闻
- **当** 配置 `ALERT_MIN_PUBLISHED_AT` 为启用时刻,某达阈值事件 `published_at` 早于该基线(启用前发布的存量)
- **那么** 该事件不进告警候选(被 `published_at >= 基线` 排除),不追推存量;`published_at >= 基线` 的新事件正常告警

#### 场景:启用告警但未设基线则快速失败
- **当** `ALERT_SCAN_ENABLED='true'` 但 `ALERT_MIN_PUBLISHED_AT` 未设置(非 ISO、非显式空串 opt-out)
- **那么** 系统在启动/注册阶段 fail-fast、拒绝注册告警链,提示运维须显式给 ISO 基线或空串 opt-out

### 需求:P0 实时告警质量可观测

系统必须为实时告警提供可观测口径,支撑「精确/召回、噪音率」的人工抽检——这是「大事发生时先从即时推送知道、噪音可忍」这一上线判据的验证信号。每次高频扫描完成后,系统必须以结构化日志/事件记录本次:达阈值并推送的告警计数、命中事件的 `importance_score`（供分布/边界抽检）、以及各告警事件的 `event_id` 与命中的 `channel`。记录必须为**确定性程序输出**（非 LLM 判断质量）,不得引入新的对外副作用（只记录、不额外推送）。

#### 场景:每次扫描记录 P0 告警质量口径
- **当** 一次高频告警扫描完成并推送了 N 条 P0 告警（N ≥ 0）
- **那么** 系统结构化记录本次告警计数 N、各命中事件的 `importance_score` 与 `event_id`/`channel`,供人工抽检精确/召回与噪音率,且不产生额外对外推送

#### 场景:可观测记录不改变告警行为
- **当** 记录 P0 告警质量口径
- **那么** 该记录为纯旁路观测,不影响是否告警的确定性阈值判定、不重复推送、不阻塞或改变告警链其余阶段
