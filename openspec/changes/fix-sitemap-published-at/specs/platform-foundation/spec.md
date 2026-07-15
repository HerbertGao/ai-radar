## ADDED Requirements

### 需求:published_at 权威等级列可迁移

系统必须以 forward-only 迁移（追加新迁移序号、不重写既有迁移，`drizzle-kit migrate` journal 级幂等）为 `ai_news_events` 新增 `published_at_authority` 列，承载「该行 `published_at` 的来源精确性」，使硬去重塌缩与语义合并的 `published_at` 归集可从「先到者永久胜出」改为「权威等级高者胜出」（见 dedup-and-normalization「基于 dedup_key 的硬去重塌缩」与 semantic-dedup「确定性事件合并」，二者为权威）。

**取值域 MUST 为两级非空**：

```
0 = 无日期
1 = 一切【不是页面确定性提取】的日期值
    （rss 的 pubDate / hacker_news 与 show_hn 的投稿时刻 / github 的 push 时刻 / AI 推断回填）
    —— 同档互不覆盖，先到者胜出 = 与引入本列之前的 COALESCE 完全一致的行为，零回归
2 = 页面确定性提取的发布日（sitemap 从文章 HTML 抽取的、文章自己印的那个日期）—— 覆盖一切
```

**这个阶梯排的是「这个值离【文章的发布日】有多近」，不是「这个时间戳的来源有多可信」**：HN 的投稿时刻是**真实**时间戳，但它测的是**错误的事件**（投稿，不是发表）；AI 推断是**猜**的，但它猜的是**正确的事件**（发表）——**对错误事物的精确测量，比对正确事物的粗略估计更坏**。**MUST NOT 在第 1 档内部再排序**（含「程序时间戳 > LLM 推断」）：任何档内排序都会引入一条**能把日期往后推**的覆盖关系（如让转载 RSS 的今日 `pubDate` 覆盖 LLM 已正确推断出的 2023 年发布日）⇒ 老文看起来是新的 ⇒ 过时效闸 ⇒ 当成今日重大发布推出去。而**页面提取读的是文章自己印的日期，结构上不可能让老文看起来新**——故只有它有资格覆盖。完整论证以 dedup-and-normalization「基于 dedup_key 的硬去重塌缩」为权威。

**迁移语句顺序 MUST 逐字钉死（顺序错则生产迁移当场中止）**：

```sql
ALTER TABLE ai_news_events ADD COLUMN published_at_authority smallint NOT NULL DEFAULT 0;

UPDATE ai_news_events SET published_at_authority = 1 WHERE published_at IS NOT NULL;

ALTER TABLE ai_news_events ADD CONSTRAINT ai_news_events_published_at_authority_check
  CHECK ((published_at IS NULL) = (published_at_authority = 0));
```

**`CHECK` MUST 是最后一条语句。** drizzle-kit 从 schema 生成迁移时会把 `ADD COLUMN` 与 `ADD CONSTRAINT` 一起吐出，而手工插入 `UPDATE` 的自然位置是文件末尾 ⇒ 得到「先加 CHECK、再回填」的顺序 ⇒ 加 CHECK 的瞬间，存量**每一行** `published_at IS NOT NULL AND published_at_authority = 0`（列的 DEFAULT）**全部违反约束** ⇒ **迁移 abort、容器起不来**。**空库 CI 恒绿——该顺序错误只在生产炸。**

**存量回填值 MUST 为 1（非页面提取档），MUST NOT 触碰任何一行的 `published_at`**：

- **回填 1 不是保守近似，而是精确的**：存量的**一切**非空 `published_at` 都**不是页面提取值**——页面确定性提取这条采集路径**在本变更之前根本不存在**（`sitemap` 采集器此前一律把 `published_at` 置 NULL）。故存量的每一个非空值必然来自 rss `pubDate` / hn 与 show_hn 的投稿时刻 / github 的 push 时刻 / AI 推断回填，**全部落在第 1 档**。**MUST NOT 回填 2**——那会给存量行一个它们没有的覆盖权：一条被误标为「页面提取」的存量行，会让后到的真页面提取值（亦为 2）因「同档不覆盖」而被丢弃，正好废掉本变更要修的那一格。
- **档内不区分来源是设计，不是妥协**：第 1 档内部**本来就不排序、互不覆盖**（先到者胜出），故「存量里的 AI 推断值与程序时间戳分不开」**不构成问题**——它们本就同档。行为与今天的 `COALESCE`（先到者永久胜出）**完全一致，零回归**。
- **为何不清洗存量 `published_at`**：同一 `canonical_url` 下 HN 与 RSS 的日期实测可差 ±12 天且**方向不定**（HN 常**早于** RSS），**哪个是文章真正的发布日，数据里没有**；任何「按源权威性排序清洗存量」都是猜，而猜错的方向会把老事件的 `published_at` 往后推 ⇒ **让老文看起来更新** ⇒ 正是时效性红线要防的方向。存量事件的日期正确与否**不影响**新口径的正确性（新口径只保证「未来到来的页面提取值能覆盖第 1 档的值」）。

**不变量（MUST）**：`(published_at IS NULL) = (published_at_authority = 0)`。该不变量是「权威高者胜出」口径能同时承载 NULL-fill 的**全部依据**（authority=0 严格小于任何非空来者的等级 ⇒ NULL-fill 自动成立、不需另设分支），故 MUST 由 DB `CHECK` 约束兜底，不得只靠应用层自觉。

**该 `CHECK` 会打挂既有测试 seed（MUST 一并纳入工作量）**：任何写入非空 `published_at` 却不写 `published_at_authority` 的 INSERT 都会当场违约。生产写路径由本变更覆盖，但**集成测试的 seed helper 亦须同步**——seed MUST 把 `(published_at, published_at_authority)` 当作**二元组**写入（非空且非页面提取源 → 1、非空且为 `sitemap` 页面提取 → 2、NULL → 0）。失败方向是对的（fail-loud，不会静默漏），但它不是零成本。

#### 场景:迁移按「加列 → 回填 → 加 CHECK」顺序执行
- **当** 对**已有存量数据**的生产库执行本迁移
- **那么** 语句顺序为 `ADD COLUMN`（`NOT NULL DEFAULT 0`）→ `UPDATE ... SET published_at_authority = 1 WHERE published_at IS NOT NULL` → `ADD CONSTRAINT ... CHECK`；**绝不可**把 `CHECK` 排在 `UPDATE` 之前——那样加约束的瞬间存量每一行「有日期但等级为 0」全部违反、迁移 abort、服务起不来（**空库 CI 恒绿，只在生产炸**）

#### 场景:迁移加列并回填权威等级、不动 published_at
- **当** 对已上线数据库执行本迁移
- **那么** `ai_news_events` 含 `published_at_authority smallint NOT NULL DEFAULT 0`，所有 `published_at IS NOT NULL` 的存量行 `published_at_authority = **1**`（非页面提取档——页面确定性提取这条采集路径**在本变更之前不存在**，故存量的每一个非空值必然来自 rss / hn / show_hn / github / AI 推断，**全部落在第 1 档**；**MUST NOT 回填 2**，那会给存量行一个它们没有的覆盖权、使后到的真页面提取值因「同档不覆盖」被丢弃）、`published_at IS NULL` 的行为 0，且**没有任何一行的 `published_at` 被修改**（迁移中不含任何写 `published_at` 的语句）

#### 场景:CHECK 约束兜死「有日期 ⟺ 等级非 0」
- **当** 任何写路径试图写入 `published_at IS NULL AND published_at_authority > 0`，或 `published_at IS NOT NULL AND published_at_authority = 0`
- **那么** DB `CHECK` 约束拒绝该写入——该不变量是「权威高者胜出即隐含 NULL-fill」的依据，绝不可只靠应用层自觉；既有集成测试的 seed 亦须按 `(published_at, published_at_authority)` 二元组写入（NULL → 0；非空 → **1**，即近似档 rss/hn/github/AI；**唯有 sitemap 页面确定性提取才 → 2**——给普通非空 seed 写 2 会赋予它不该有的覆盖权），否则当场违约或错测覆盖语义

#### 场景:迁移 forward-only 且幂等
- **当** 在已迁移数据库上再次执行 `drizzle-kit migrate`
- **那么** 既有迁移不被重写、本迁移被 journal 跳过、表结构无变化、不报错

### 需求:运维告警落真实通道并由 DB 唯一约束限频

系统必须提供一个**运维告警 sink**，把工作流的 `AlertSink` 接到**真实推送通道**（复用既有 sender），并把「同一告警今天已发过」的限频状态**放进 DB 的推送幂等唯一约束**里。

**为何必须有这条需求**：当前 `AlertSink` 的默认实现是 `console.error`（`[pipeline][ALERT] …`），而生产常驻进程**不注入任何其它实现** ⇒ 所有「系统级故障」告警（采集全挂 / 全 unprocessable / 源陈旧 / 降级熔断 / 租约已失 / 本变更新增的日期提取归零）**只落 stderr**。规范反复区分的「记日志 ≠ 告警」在实现里是**同一个 `console.error`，只差一个前缀**。故规范里任何一条「MUST 告警」在本需求落地前都是**空的**。

#### `AlertDetail` MUST 收窄为「必填 `dedupKey`」——由类型系统枚举全部调用点

sink 的限频与幂等**全部**建立在 `dedupKey` 上，而 `push_records.target_id` 是 `varchar(128) **NOT NULL**`。若 `AlertSink` 的 detail 仍是宽松的可选 `unknown`：

- 既有调用点**不传 `dedupKey`** ⇒ `target_id = undefined` ⇒ **NOT NULL 违反** ⇒ 被 sink 自己的 best-effort catch 吞掉 ⇒ **这些告警连 stderr 都不再有**（今天至少还进 stderr）；
- 而 sink 的单测（都会传 `dedupKey`）**全绿** ⇒ 假绿。

⇒ **为了让新告警落地而引入的 sink，会把已经存在的告警变成静默。** 故：

```ts
interface AlertDetail { dedupKey: string; [k: string]: unknown }
type AlertSink = (message: string, detail: AlertDetail) => void | Promise<void>;
```

**detail MUST 必填、`dedupKey` MUST 必填。** 理由是**枚举必漏、编译器不漏**——收窄类型会让**每一个**既有调用点编译报错，逼实现者逐个分配 `dedupKey`，而不是靠人去数有几处。

**`AlertSink` MUST 允许返回 `Promise<void>`，且所有调用点 MUST `await`**：sink 要做 DB INSERT + 网络发送 + 状态 UPDATE，全是异步。而工作流中数个告警调用点**紧接着就 `throw`**（降级熔断中止、租约已失）——不 `await` 则告警是一个游离的 Promise、工作流已在栈上抛错、job 已失败 ⇒ **投递零完成保证**。

#### 契约（MUST）

```text
createOpsAlertSink({ sender, dbh, channels, now }): AlertSink

alert(message, detail) →
  ① dedupKey = detail.dedupKey                       // 类型上必填
  ② push_date = dateInTimeZone(now())                // 时区口径见下，MUST NOT 用 UTC 日
  ③ INSERT push_records (target_type='ops-alert', target_id=dedupKey,
                          channel, push_date, status='pending')
     ON CONFLICT DO UPDATE SET status='pending', error_message=NULL
       WHERE push_records.status <> 'success'          // 仅【未成功】行可被重新认领
     RETURNING id
     → 命中 0 行 ⇒ 今天已就该 dedupKey 在该 channel 告过【成功】 ⇒ 直接 return，不发
     → 命中 1 行 ⇒ 认领当日名额（含崩溃残 pending / 上次 failed 的重新认领）
  ④ 经 sender 发送（复用既有 sender，如 createFeishuSender）
  ⑤ 成功 → status='success'
     失败 → status='failed'（不删行）；MUST NOT 让该失败占用当日限频名额（见下）
```

**`push_date` 的时区口径 MUST 为 `dateInTimeZone(now, PUSH_TIMEZONE)`（`Asia/Shanghai`），MUST NOT 用 UTC 日**（`toISOString().slice(0,10)` 是最常见的错误写法）。**理由 MUST 逐字保留**：**UTC 日界 = 08:00 CST，而日报链恰在 08:03 CST 运行**——只差 3 分钟。用 UTC 日则 07:49 那一轮高频链的告警落 `push_date = D-1`、08:03 日报链的同一告警落 `push_date = D` ⇒ **唯一键不冲突** ⇒ 「跨两条链自动去重」这条收益**当场为假** ⇒ 持续故障期**天天双响**。`createOpsAlertSink` MUST 支持注入 `now`（可测），两条链 MUST 传同一口径的运行时刻。

**发送失败 MUST NOT 占用当日限频名额**：若把任意冲突都视为「今天已告过」（`ON CONFLICT DO NOTHING`），则失败留下的 `failed`（乃至崩溃残留的 `pending`）会挡死同一 `dedupKey` 当天的后续告警 ⇒ **一次发送失败 / 一次崩溃 = 该告警当天彻底哑火**。故限频判据 MUST 为「**仅 `status='success'` 的行才算今天已告过**」：认领用 `ON CONFLICT DO UPDATE ... WHERE status <> 'success'`（`failed` / 陈旧 `pending` 可被重新认领重发），失败时把该行置 `failed`（**不删行**、留痕）。此为实现所采形态，MUST 显式落地，不得留给实现者临时发明。

**通道选择 MUST 定死**：sink 的 `channels` 取「**已配置通道全集**」（与业务推送同口径）并逐个发送。**未配置任何通道时 MUST 回落 `console.error`，且 MUST NOT 写任何 `push_records` 行**——否则限频键会把「根本没有通道可发」也算成「今天已告过」，使通道配好之后当天仍然静默。

#### 限频状态住在 DB 唯一约束里

限频状态**必须**住在既有的 `UNIQUE(target_type, target_id, channel, push_date)` 里（推送幂等地基），**MUST NOT** 另建 Redis 键或进程内 Map。三条理由 MUST 一并读到：

- **零新状态**：进程内 Map 会在每次 redeploy 复位 ⇒ 任何「今天已告过 / 连续 N 轮」的判断永不达标 ⇒ **静默不告警**（正是本需求要修的失效模式的翻版）。
- **跨进程 / 跨重启 / 跨链自动去重**：日报链与高频告警链用同一个 `dedupKey` ⇒ 一条链先告了，另一条自动命中唯一键冲突而跳过（**该收益以上面的时区口径为前提**——用 UTC 日则跨链去重为假）。
- **与第一架构原则一致**：幂等由 DB 唯一约束保障，绝不交给应用层自由发挥。

#### `ops-alert` 命名空间的必然代价（MUST 显式登记）

**`target_type = 'ops-alert'` MUST 扩入 `target_type` 枚举的权威全集**（见「数据库 Schema 可迁移」：枚举集中收口、禁止散落字面量），与推送用的 `alert`（P0 实时告警的**内容**推送）**分属两个命名空间**、绝不复用——前者是运维告警（收件人是维护者、幂等键是故障 kind），后者是产品内容。

**代价**：任何**不按 `target_type` 过滤**的既有 `push_records` 查询会被 `ops-alert` 行污染。已核实一处：MCP 的「今日已推送内容」查询按 `push_date + status='success'` 取记录、**不过滤 `target_type`** ⇒ 一条 ops-alert 的 success 行会使「今日尚未推送」判定翻转为「已推送」，返回**空要闻段 + 空产品段**、且通道集合被 sink 的通道污染。故新增本 `target_type` 时 MUST 同步给该类查询加 `target_type IN ('event','product')` 谓词。**这是引入新 `target_type` 命名空间的必然代价，不是可选清理。**

#### 注入点

**告警 sink MUST 被常驻运行时注入**。注入点 MUST 落在**常驻 worker 实际调用的那一层**——worker 调的是薄 `run(ctx)` 包装（其职责自陈为「生产默认补齐 DI」），**不是**直调 `runDailyWorkflow(options)`。**MUST NOT** 把注入写成「worker 把 sink 传进 `runDailyWorkflow`」——那会把实现者指到一个 worker 根本不经过的入口，sink 照旧不生效。未注入时回落 `console.error` 的默认实现**只是本地 / 测试兜底**；若生产不注入，本需求全部落空。

**best-effort（MUST）**：sink 内部任何异常（DB 不可达、发送失败）MUST 仅记错误日志、**绝不向上抛**——告警链路不得反过来把它监视的工作流搞崩。

#### 场景:告警经真实通道送达并写推送记录
- **当** 工作流判定系统级故障并 `await alert(message, { dedupKey })`
- **那么** sink 以 `target_type='ops-alert'`、`target_id=dedupKey`、`push_date=dateInTimeZone(now, PUSH_TIMEZONE)` 写入 `push_records`（先 `pending`），经 sender 真实送达后置 `success`

#### 场景:同一 dedupKey 当天只告一次（跨进程、跨重启、跨链）
- **当** 同一 `dedupKey` 的告警在同一天被再次触发（同一进程重复轮次、进程重启后、或另一条链触发）
- **那么** `INSERT ... ON CONFLICT DO UPDATE ... WHERE status <> 'success'` 命中 0 行（已有 `success` 行）⇒ sink 直接 return、**不发送**——限频状态住在 DB 唯一约束里，不依赖任何进程内状态（进程内 Map 会在 redeploy 复位而使限频/连续计数永久失效）

#### 场景:push_date 用 Asia/Shanghai 日而非 UTC 日（否则跨链去重为假）
- **当** 高频告警链在 07:49 CST、日报链在 08:03 CST 各触发一次同 `dedupKey` 的告警
- **那么** 二者的 `push_date` **相同**（同为 `Asia/Shanghai` 的当天）⇒ 第二次命中唯一键冲突而跳过、**只响一次**。**绝不可**用 UTC 日——UTC 日界恰是 08:00 CST，与日报链的 08:03 只差 3 分钟，会把这两次告警落进 `D-1` 与 `D` 两个不同的 `push_date` ⇒ 唯一键不冲突 ⇒ 持续故障期**天天双响**

#### 场景:发送失败不占用当日限频名额
- **当** sink 写入 `pending` 行后，sender 发送失败
- **那么** 该失败 **MUST NOT** 使同一 `dedupKey` 当天的后续告警被限频跳过——限频判据为「仅 `status='success'` 行算已告过」，失败置 `failed`（不删行）后，下一轮的 `ON CONFLICT DO UPDATE ... WHERE status <> 'success'` 可重新认领该行重发。**绝不可**留下一行 `failed` 就让唯一键把当天的该告警彻底哑火；异常仅记错误日志、不向上抛

#### 场景:未配置任何推送通道时不写 push_records
- **当** 运行环境未配置任何推送通道
- **那么** sink 回落 `console.error` 输出告警，且**不写任何 `push_records` 行**——否则限频键会把「没有通道可发」也记成「今天已告过」，使通道配好之后当天仍然静默

#### 场景:生产常驻运行时必须注入本 sink
- **当** 常驻 worker 触发日报工作流
- **那么** MUST 在 worker 实际调用的那一层（薄 `run(ctx)` 包装——「生产默认补齐 DI」的那一层，**非** `runDailyWorkflow(options)` 直调入口）注入本 sink；不注入则回落到只落 stderr 的 `console.error` 默认实现，使规范里所有「MUST 告警」在生产里等于「MUST 记一行日志」
