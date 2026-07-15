## MODIFIED Requirements

### 需求:ai-radar 事件流触发复核（独立队列、published_at、排 tombstone、不改事实）

事件消费者必须是**独立 BullMQ 队列**（cron 在每日 workflow 产出事件之后，**不嵌入 `run-daily-workflow.ts`**）；候选门必须是**闭区间 `startOfDayInTimeZone(now, windowDays-1) <= published_at <= now`**（windowDays env 可配但**必须 `>=1`**，env 校验拒 `0`——`0`→`daysBack=-1`→下界算成明天→区间空集**静默停打标**，与 alert-scan「0=不限窗口」心智相反；**上界 `<= now` 绝不可省**——拦 AI 推断的未来 `published_at` 越过下界刷屏；nullable `published_at` 经 `gte/lte` 自然排除）的 `ai_news_events`，**排除 `merged_into IS NOT NULL` tombstone**；匹配 `mr_vendors.normalized_name`（已归一）vs 事件 `representative_title/summary_zh/headline_zh`（**三列均 nullable，任一为 NULL 必须跳过该列、不对 NULL 归一**，两侧归一）+ 价格/模型关键词常量。命中 → 给该厂商 plan 经单行翻转 CAS 打标（**不做「写前查 status」预检**——CAS 本就幂等，预检是 TOCTOU 会与人工 resolve 竞态丢真实事件），多 plan **per-target 独立**（每 CAS 自治，失败隔离）。**只写 flag、不改事实**。

**候选域宽度登记（MUST，本需求修改点——只登记、不改任何判定）**：本需求的候选闸是**裸 `published_at` 闭区间 + 排 tombstone**——**无 source 闸、无 `importance_score` 闸、无 `is_ai_related` 闸**。`sitemap` 源（一方厂商官方公告）此前靠 `published_at IS NULL` 被**结构性排除**在候选域外；其确定性发布日提取落地后（见 source-collectors「sitemap 增量采集」），这些官方新闻会**每天**落进本复核窗口（默认 `MR_EVENT_REVIEW_WINDOW_DAYS=1`）。**MUST NOT 为此加 source 闸**——候选域宽是本需求的既定语义（厂商名 + 关键词的合取才是判定闸）。

**门控开启前的重新评估义务（MUST）**：`MR_EVENT_REVIEW_ENABLED` 默认关闭，故上述扩面当前**无 live 影响**。该门开启前 MUST 重新评估：

- ① **`REVIEW_TRIGGER_KEYWORDS` 的命中面**——其召回偏置（宁多勿漏）的前提是「候选域稀疏」，**该前提已不成立**；
- ② **窗口重叠重放会重开已 resolve 的 plan**（已知接受项：windowDays 有界 + single-writer）与更宽候选域的**交互**；
- ③ **量级估算 MUST 按合取估**：命中判定是 **AND**——归一后的事件文本须**同时**含某 `REVIEW_TRIGGER_KEYWORDS` 关键词**且**含某 `mr_vendors.normalized_name`。**MUST NOT 以「关键词命中数」单独外推**（会系统性高估）。

本登记 **MUST NOT** 被解读为放宽事实判定：命中仍**只写 flag、不改事实**——价格/兼容/额度是精确事实，由结构化录入 + DB 保障，**绝不交事件流或 LLM 判定**。

#### 场景:命中厂商变动打标不改事实
- **当** 当天 `published_at` 某非-tombstone 事件命中被跟踪厂商 + 价格/模型关键词
- **那么** 对应 plan 打待复核，其事实值不变

#### 场景:tombstone 与冷启动不误触发
- **当** 扫到 `merged_into IS NOT NULL` 的合并事件 / 首次部署的历史回填事件
- **那么** 被排除/窗口下界挡住，不打标

#### 场景:未来 published_at 不绕过上界
- **当** 一条 `published_at` 为未来日期的事件命中关键词
- **那么** 被闭区间上界 `<= now` 挡住，不打标

#### 场景:一方厂商官方新闻正常进候选域、判定闸不变
- **当** 一条 `source='sitemap'` 的一方厂商官方新闻事件，其页面提取的 `published_at` 落在复核窗口闭区间内、非 tombstone
- **那么** 它**正常进入候选域**（本需求无 source/importance/`is_ai_related` 闸，不为它加特例闸）；是否打标仍由「某厂商 `normalized_name` **AND** 某价格/模型关键词」的合取判定，命中也只写 flag、不改任何事实
