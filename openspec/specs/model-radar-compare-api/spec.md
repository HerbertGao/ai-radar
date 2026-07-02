# model-radar-compare-api 规范

## 目的
Model Radar（P5 / 5c+5d-A）读路径：从 `mr_*` 子集构建去规范化只读快照（内容哈希 version/ETag、离散 stale + 待复核聚合、fail-closed），并在其上提供确定性比价/检索 API（model/tool/protocol/currency/budget 过滤、同 (category,currency) 排序、未知价不参与「最便宜」）。桶2 数据红线：已核价才录、未核保持占位、未核 provenance 不冒充已核。快照跨进程失效（Redis pub/sub 仅通道、不存 blob）+ 服务进程内周期 rebuild（`setInterval`，非 BullMQ 常驻 worker）已纳入本规范（5d-A）；Web 比价页（5d-B）、推荐器（5e）不在本规范。
## 需求
### 需求:只读快照从 mr_* 子集构建并校验

系统必须提供 Model Radar 只读快照构建器，从构建所需的 `mr_*` 子集（10 张：vendors/plans/models/plan_models/plan_clients/plan_limits/plan_prices/source/plan_sources/review_flag，仍不含 `mr_price_history`、也不含 `mr_catalog_version`）读取并构建去规范化 JSON。快照必须覆盖 vendor、plan、availability、models、clients、limits、`mr_plan_prices` 季/年付、`mr_source`、`mr_plan_sources`、provenance、staleness、review flag，并在对外返回前经过 Zod schema 校验。快照读取必须是单事务、point-in-time 一致；各表/数组必须按稳定键排序，其中 `mr_plan_prices` 按 `(plan_id,billing_period,currency)` 排序，防无变更 hash 漂移。API 请求热路径禁止直接 join 规范化 `mr_*` 表作为主要读路径。

#### 场景:快照包含完整关系、周期价与 provenance
- **当** 数据库中存在一个 plan 及其模型、工具/协议、限额、季/年付周期价和待复核 flag
- **那么** 快照中同一 plan 带有这些去规范化关系、`availability`、每条断言事实的 provenance（日粒度 `lastCheckedDate`）、离散 freshness 和 pending review 状态

#### 场景:快照单事务一致读不撕裂
- **当** 在快照构建过程中有并发写提交（如新增某 plan 的 period price 行）
- **那么** 构建器在单事务 point-in-time 视图下读取，结果要么完全包含该写、要么完全不含，不出现「读到 plan 却漏其 child」的撕裂态

#### 场景:快照 schema 校验失败不对外服务且不覆盖旧快照
- **当** 快照构建结果缺失必需 provenance 字段、出现非法枚举值、或周期价 `effectiveMonthly` 与 `priceStatus` 不一致
- **那么** 构建器必须报错、不缓存坏快照、不覆盖既有可用快照；冷启动首建即失败时 API 返回 503 且不写缓存

### 需求:快照聚合源与厂商待复核及陈旧状态

快照中每个 plan 的 `reviewStatus`/`staleness` 必须聚合：直接指向该 plan 的 flag、指向其 vendor 的 flag、经 `mr_plan_sources` 关联的 source flag 与 source `last_checked`、plan 自身及其 child 事实行（`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`/`mr_plan_prices`）的 `last_checked`。任一为 pending/陈旧，则该 plan 必须暴露为待复核/陈旧，禁止只看 plan 级 flag 而把关联源/child 行已待复核或陈旧的 plan 显示为干净。

#### 场景:周期价陈旧的 plan 不显示新鲜
- **当** 某 plan 的 `mr_plan_prices` 年付行 `last_checked` 已超阈值，而其它事实行仍新鲜
- **那么** 快照中该 plan 的 `freshness.stale=true`

#### 场景:关联源待复核的 plan 不显示干净
- **当** 某 plan 经 `mr_plan_sources` 关联的源被打了 `target_type='source'` 的 pending flag
- **那么** 快照中该 plan 的 reviewStatus 为待复核，而非干净

#### 场景:vendor 级 flag 传导到其 plan
- **当** 某 vendor 被打 pending flag
- **那么** 其名下 plan 的 reviewStatus 反映该待复核状态

#### 场景:从未核对的源（last_checked NULL）判陈旧
- **当** 某 plan 关联一个从未抓取的 browser 源（`mr_source.last_checked IS NULL`、`content_fingerprint NULL`）
- **那么** 快照将其判为陈旧、暴露待复核，而非按 `now - NULL` 误判为新鲜（plan/child 行 last_checked 为 NOT NULL，只走阈值比较）

### 需求:比价检索 API 基于快照确定性过滤

系统必须提供只读 HTTP API，在快照上按 `category`、`model`、`tool`、`protocol`、`currency`、预算（`maxMonthlyPrice`）、`requiresKnownPrice` 等参数确定性过滤 plan。查询参数必须经 Zod 校验；未知参数或非法枚举必须返回 400（accepted 参数集须与实现一致，避免「tasks 用了但 spec 未列致 400」）。`currency`（可选，ISO 4217 大写枚举）把结果限定到该币种；与 `maxMonthlyPrice`（自带 currency）同传时二者 currency 必须一致，否则 400。`currency` 过滤**排除 currency=NULL 的未知价 plan**（与预算过滤同口径——未知价无币种、不属任何币种结果集）。`model` 查询语法必须显式定义：用 `family:version` 形式（family 小写匹配，与录入归一一致），冒号**必填**，未标版本的模型用空版本 `family:` 匹配哨兵 `''`；裸 family 无冒号（如 `model=glm`）视为非法语法返回 400。`tool`/`protocol` 的 `clientId` 为**精确（大小写敏感）匹配**（录入侧 `upsertPlanClient` 不归一 clientId，seed 约定全小写如 `claude-code`；查询须用同形）。`maxMonthlyPrice` 必须带 currency，且只过滤同 currency 的 plan：`maxMonthlyPrice=100 CNY` 不纳入异币种（如 20 EUR）plan（异币种不可比、不入该预算结果集）。未知价是否入结果由**单一参数** `requiresKnownPrice`（boolean，默认 false=未知价仍列出但排已知后、不入预算过滤）控制——**不设第二个反向布尔**（避免矛盾态需 400 兜）。检索可以横切所有桶，但价格归一化排序只能在同一 `category` 且同一 `currency` 内解释；排序响应必须携带 `sortScope={category, currency}`，其中 `currency` 对全未知价（currency 缺失）组可为 `null`。

#### 场景:按模型与工具过滤
- **当** 请求过滤 `model=glm:4.6` 且 `tool=claude-code`
- **那么** API 只返回快照中同时包含该模型兼容（family=glm、version=4.6）和工具兼容的 plan，并保留其 provenance

#### 场景:非法查询参数被拒
- **当** 请求传入非法 category、无法解析的预算参数或非法 `model` 语法
- **那么** API 返回 400，且不执行宽松兜底查询

#### 场景:currency 与预算币种不一致被拒
- **当** 请求 `currency=USD` 同传 `maxMonthlyPrice=100 CNY`（币种不一致）
- **那么** API 返回 400，不静默择一

#### 场景:currency 过滤排除未知价
- **当** 请求 `currency=USD`
- **那么** currency=NULL 的未知价 plan 不进入结果集（与预算过滤同口径，不归任何组）

#### 场景:跨桶检索不输出全局价格排名
- **当** 请求未限定单一 (category, currency) 而返回多个桶/币种的 plan
- **那么** API 必须按 (category, currency) 分组并在响应携带 `sortScope={category, currency}`，禁止输出跨桶/跨币统一 price rank

#### 场景:requiresKnownPrice 排除未知价
- **当** 请求 `requiresKnownPrice=true`
- **那么** priceStatus 为 unknown 的 plan 不进入结果集（无第二个反向布尔、无矛盾态）

### 需求:同桶价格排序必须按已核 provenance + 同币种判定

同桶排序必须将 plan 判为 `priceStatus='known'` **当且仅当**：canonical 月价 `current_price` 非 NULL、`currency` 非 NULL、且 `source_confidence` 属已核官方集合 `{official_pricing, official_doc}`。任一不满足（价格或币种为 NULL，或 confidence 为 `needs_login_recheck`/`official_community`/`media_report`）一律判 `priceStatus='unknown'`（未核）。已知价格只在**同一 category 且同一 currency** 内按数值升序排序；不做汇率换算。未知价格（currency 视为 NULL）**当其在结果集中时**必须归入 `sortScope.currency=null` 的未知价组、不挂任何已知币种组（与「currency 过滤指定币种时排除未知价」互不冲突——前者是默认分组归属、后者是谓词过滤把未知价移出结果集，二者 mode-disjoint），不参与“最便宜”结论，并在 `requiresKnownPrice=true` / 预算过滤 / `currency` 过滤时被排除。禁止把 NULL 当作 0、估算价或默认价；禁止用非官方 confidence 的价格冒充已核价参与 cheapest。

本变更新增：`availability='discontinued'` 与 priceStatus 正交，停售 plan 可保持 `priceStatus='known'`（历史价格仍是事实），但必须从 `cheapestPlanId` / `comparable=true` 的候选集合排除，且在推荐器中不得成为 primary；`availability='unknown'` 不当停售处理。季/年付 `effectiveMonthly` 不参与 cheapest/sort。

#### 场景:非官方 confidence 带价格不参与 cheapest
- **当** 某 plan `current_price=40`、`currency='CNY'`，但 `source_confidence='needs_login_recheck'`（或 media_report）
- **那么** 该 plan 判 `priceStatus='unknown'`，不参与 cheapest，不被当作已核价排序

#### 场景:未知价格排在已知价格之后
- **当** 同一 category 同一 currency 中 plan A 价格为 40 CNY 且 official_pricing，plan B 价格为 NULL
- **那么** 价格升序结果中 A 排在 B 前，B 标记 `priceStatus='unknown'` 且不成为 cheapest

#### 场景:混币不当同单位比较
- **当** 同一 category 内 plan C 为 20 EUR、plan D 为 40 CNY
- **那么** 二者不被当同单位比较；排序按 (category, currency) 分组进行，或请求未带 currency 时不输出跨币种 cheapest

#### 场景:预算过滤排除未知价格
- **当** 请求 `maxMonthlyPrice=100 CNY` 或 `requiresKnownPrice=true`
- **那么** priceStatus 为 unknown 的 plan 不进入结果集

#### 场景:裸预算无 currency 被拒
- **当** 请求 `maxMonthlyPrice=100`（未带 currency）
- **那么** API 返回 400（与「maxMonthlyPrice 必带 currency」契约一致）

#### 场景:全未知价格不产生最便宜结论（currency 可为 null）
- **当** 某 category 的匹配 plan 全部为 unknown price（currency 缺失为 NULL）
- **那么** API 返回结果可列出这些 plan，置于 `sortScope.currency=null` 的未知价组，必须返回 `cheapestPlanId=null`（无可比最便宜 plan）加具名标记（`comparable=false` 与 `unknownCount`），不得用自由文本含糊表达

#### 场景:停售已核低价不成为 cheapest
- **当** 同一 (coding_plan,CNY) 组内 plan A `availability='discontinued'` 且月价 ¥1，plan B `availability='on_sale'` 且月价 ¥49
- **那么** plan A 可列出并标停售，但 `cheapestPlanId` 指向 plan B；不得因停售低价得出最便宜结论

#### 场景:季/年有效月价不参与 cheapest
- **当** 某 plan 月付 ¥49、年付 ¥468（effectiveMonthly ¥39）
- **那么** cheapest 仍按月价 ¥49 与其它 plan 比较，不按 ¥39 排序

### 需求:快照版本与 ETag 必须随数据变更失效

API 暴露的 `version`/ETag 必须在底层数据变更后改变，否则下游 HTTP 304 会返回陈旧价。**唯一公开 `version`/ETag 源 = 快照内容哈希**：哈希前必须 **canonical 序列化**——既排序对象键，也固定数组/行序（buildSnapshot 各表 `ORDER BY id` 或 builder 内按稳定键排序；新增 `mr_plan_prices` 必须按 `(plan_id,billing_period,currency)` 稳定排序）。**`mr_catalog_version`/`builtAt` 纯属内部用途、不作公开 `version`/ETag 源、不进服务表征**（避免「bump 每周期/无变化也变」与内容哈希语义冲突）。

**哈希内容契约（ETag = 服务表征的纯函数；防过度失效 + 防 304-with-stale）**：ETag 必须是 **API 实际返回的服务表征**的 canonical 哈希——**不得有 served-but-unhashed 或 hashed-but-unserved 字段**，唯一例外是 `version`/ETag 字段本身：响应体 `version`（若返回）等于该内容哈希、是从 canonical 服务表征派生的传输别名，本身不进入哈希输入（避免自引用）。新增的 `availability`、`periodPrices`、周期价 `priceStatus`、`effectiveMonthly`、周期价 provenance/`lastCheckedDate` 都是服务表征，必须进入内容哈希。`effectiveMonthly` 不进 cheapest/sort，但只要服务给客户端就必须进 hash。

为同时满足「无变更稳定」与「跨阈值翻转」，服务表征的 freshness 仅暴露离散 `stale: boolean`（由 `last_checked IS NULL 或 < (注入 now − 阈值)` 算出；plan 级 `stale` = 其任一成分事实/源 stale 的聚合，良定义），服务表征不暴露 raw 秒级 `last_checked`、也不暴露 plan 级聚合 date；但暴露 per-provenance 日粒度 `lastCheckedDate`。如此「排除 raw last_checked / now 派生连续量（ageMs） / 构建时刻」对 hash 与 served 表征同时成立、无 served-vs-hash 错配。由此：① 同一注入 now、无服务表征变化 → 哈希稳定、304 命中、不过度失效；② now 推进跨过 staleness 阈值 → `stale` 翻转 → 服务表征变 → ETag 变；③ 仅推 raw 秒级 `last_checked`、未跨该事实的 UTC 日界、未翻 stale 谓词的写不改服务表征 → ETag 可不变；若该写把 `last_checked` 推到新 UTC 日，则其 `lastCheckedDate` 变 → ETag 变。

**per-fact age**：服务表征必须为每条事实行 provenance（plan 价格事实、models/clients/limits 事实、period price 事实）+ 关联源行暴露一个 `lastCheckedDate`（日粒度 ISO 日期），由 builder 在单事务 point-in-time 内从该行 `last_checked` 派生。它是 `trunc(last_checked)` 的纯函数、完全与 `now` 无关；仅当该事实行 `last_checked` 被写到新 UTC 日才变。截断必须按固定 UTC（`toISOString().slice(0,10)` 或 SQL `AT TIME ZONE 'UTC'`），禁按进程/会话本地时区。`snapshotSourceSchema.lastCheckedDate` 可为 null（`mr_source.last_checked` 可 NULL，从未抓源无 date）；事实 provenance（plan/limit/client/model/period price，其 `last_checked` NOT NULL）的 date 必填非 null。仍不暴露 raw 秒级 `last_checked`、仍不暴露 plan 级聚合 date；「N 天前」相对文案只在 render 层算，绝不进 DTO/哈希。

**已拒绝的替代方案**：「bump `mr_catalog_version` 作公开 version 源」——它会带来「每周期 bump/无变化也变」的过度失效，且若在 on-read 触发则让 GET 在请求路径写 `mr_*`、违反「请求路径只读」；故唯一公开源是内容哈希，不引入该备选。hashed 内容真变经 rebuild 后 ETag 必须变化、无变更则 ETag 稳定。

rebuild **recompute** 必须**无缺口**地覆盖一切改变快照可见字段的授权写（recompute 覆盖全部路径；ETag 是否变化取决于 hashed 内容是否真变——纯幂等 no-op 允许 ETag 不变）：① **canonical 月价改价**——recompute 必须覆盖**两个改价入口**（公开 `recordPriceChange` **与** `upsertPlan` 经 `_recordPriceChangeTx` 的委托改价路径），且在**最外层事务提交后**触发（提交前重建会读不到未提交价），并覆盖 `recordPriceChange` 的**全部 success outcome**（appended / noop-refreshed / noop-same-tuple / history-conflict 等），不得只钩 `outcome==='appended'`；其中 appended/provenance 变会改 hashed 内容→ETag 变，而 `noop-same-tuple`（仅推 last_checked、**未跨其 UTC 日界**、未翻 stale 谓词、无其它变化）属幂等 no-op、ETag 可不变（304 仍正确）——但若该 refresh 把 last_checked 推到**新 UTC 日**，其 `lastCheckedDate` 变 → ETag 变。② **结构性录入事实变**（seed / 策展脚本 / ad-hoc `upsertPlan*`/`upsertVendor`/`upsertSource` 等）由脚本末尾触发或由周期 rebuild 兜（单条 ad-hoc 结构写不保证即时刷 ETag，归周期 rebuild）。③ **保鲜回路的 flag/staleness 写**（`setReviewFlag`/`markChecked`/staleness 排程改 reviewStatus/staleness）路径众多且 cron 驱动，须由**后台周期 rebuild 安全网**兜底——**周期/带外、非 on-read**，请求路径绝不触发写。④ 本变更新增的 `setPlanAvailability`、`upsertPlanPeriodPrice` 授权写提交后必须触发快照 rebuild/invalidation。**5c 范围**继续是交付可直接调用的 rebuild job body + builder/cache 注入 `now` + CI 测；常驻 worker 装配与跨进程失效由后续既有 specs 接线，不在本变更谎称已有运行中安全网。实现宜把 rebuild 钩在写编排边界（包住两个改价入口 + 本变更新增授权入口）+ 后台周期安全网，而非脆弱地逐入口枚举或 on-read 触发。

#### 场景:数据变更后 ETag 变化
- **当** 某 plan 月价经授权改价入口更新后触发快照 invalidate+rebuild
- **那么** API 返回的 version/ETag 与变更前不同，下游不会拿到陈旧 304

#### 场景:授权写触发 rebuild（含 upsertPlan 委托改价）
- **当** 改价经 `recordPriceChange` 或经 `upsertPlan` 委托路径成功（任一 success outcome）
- **那么** 在最外层事务提交后必触发快照 rebuild recompute（不留「改价但未 rebuild」缺口）；ETag 仅在 hashed(=服务表征) 内容真变时变化——appended/provenance 变 → ETag 变，纯 `noop-same-tuple`（仅推 raw last_checked、未跨 UTC 日界、未翻 stale）→ 服务表征不变、ETag 可不变

#### 场景:availability 变化后 ETag 变化
- **当** 某 plan 经授权入口从 `availability='on_sale'` 改为 `discontinued`
- **那么** API 返回的 version/ETag 与变更前不同，下游不会拿到旧的在售状态 304

#### 场景:周期价变化后 ETag 变化
- **当** 某 plan 的年付价、period provenance 或 `lastCheckedDate` 发生快照可见变化
- **那么** 内容哈希/version 随之变化；客户端不会缓存旧的最佳周期依据

#### 场景:保鲜回路 flag 写经 rebuild job body 反映
- **当** 保鲜回路给某 plan 打 pending flag（不经改价入口），随后直接调用 rebuild job body（注入 now）
- **那么** 快照 reviewStatus 反映该变化、ETag 变化（请求路径不触发任何写）；测试经直接调 job body + 注入 now 断言，无需真实等待或常驻 worker

#### 场景:无服务表征变化 rebuild 不漂移 ETag
- **当** 重复写入同一 availability 或同一周期价 tuple，且 `lastCheckedDate`/stale 未变
- **那么** 内容哈希 ETag 可保持不变，避免过度失效

#### 场景:staleness 阈值穿越翻转 ETag（不 304-with-stale）
- **当** 无任何 DB 写，但注入 now 推进跨过某 source 或 period price 的 staleness 阈值（前一刻 stale=false，跨后 stale=true）
- **那么** 离散 stale 谓词翻转使 hashed 内容变、ETag 变，客户端不会拿到 304 却附过期 stale 状态

#### 场景:不跨阈值无变更 rebuild 不漂移 ETag
- **当** 注入 now 推进但**未跨任何 staleness 阈值**、且无任何快照可见字段变化
- **那么** 内容哈希 ETag 保持不变、下游 304 仍命中（不过度失效；哈希不含构建时刻/now 派生连续量）

#### 场景:per-fact lastCheckedDate 完全 now 无关（now 跨日界亦不改哈希）
- **当** 无任何 DB 写、注入 now 推进跨过某事实的 UTC 自然午夜（但未跨 staleness 阈值）
- **那么** 各 provenance 的 `lastCheckedDate` 不变，内容哈希/version 稳定；「N 天前」相对文案在 render 层另算、不进哈希

#### 场景:事实重核到新 UTC 日改其 date 与哈希
- **当** 某事实行 `last_checked` 被**写**到新的 UTC 日期
- **那么** 该 provenance 的 `lastCheckedDate` 变为新日期、内容哈希/version 随之变

#### 场景:UTC 截断保证跨进程哈希一致
- **当** 两个 `process.env.TZ` 不同的进程对同一 DB 状态构建快照、某 `last_checked` 落在近午夜瞬间
- **那么** 二者按固定 UTC 截断得到同一 `lastCheckedDate` 字符串、算出同一内容哈希

### 需求:API 与快照路径只读、不碰既有表

Model Radar 比价/检索 API 的**请求路径**必须只读 `mr_*`：禁止在请求路径执行 `mr_*` 的 INSERT/UPDATE/DELETE，禁止触碰 `ai_products`、新闻、推送、KB 等既有表（bounded domain 隔离）。快照**读取**（buildSnapshot 的 SELECT 部分）只读；唯一的写是 rebuild 时写**进程内/缓存**（非 `mr_*`）。5c 不在任何路径写 `mr_*` 作 version（无 catalog bump）。已核价格只来自人工经授权改价入口（`recordPriceChange`）写入，故 API 正确性与 browser 抓取链解耦。

#### 场景:API 请求不写库
- **当** 调用任一 Model Radar 只读 API
- **那么** 不对 `mr_*` 或既有表执行任何写操作

### 需求:桶2数据策展只录已核价格、允许零已核价

5c 的桶2 Coding Plan 数据（百炼、千帆、腾讯、火山、讯飞）必须通过结构化录入进入 `mr_*`。每家的**结构性**录入（vendor + coding_plan plan + source + model/client/limit + 各自 provenance）是验收对象；真实价格只有在有已核官方来源时才能通过授权改价入口写入 `current_price/currency` 和 `mr_price_history`。**本期不要求录到任何已核价**——browser 真实勘验为价格核实前置且被列为后续 gate，故本期允许 0 个已核价；无法核实者必须保持 `current_price=NULL`、`currency=NULL`、`source_confidence='needs_login_recheck'`，禁止为凑数填传闻价/占位价。同桶排序测试必须用合成 in-memory 快照 fixture，不得依赖 seed 行有真价。

**5d-C 执行（对本需求的修订）**：5d-C 不再停在「0 已核价」——curator 人工勘验桶2 coding_plan（7 个 seeded plan：GLM Lite/Pro + 百炼/千帆/腾讯/火山/讯飞）的**真实定价页**，把可核实的真价经同一授权改价入口 `recordPriceChange` 录入，使某 (coding_plan, currency) 同档**快照 `plans.length≥2`**（满足 compare-web 既有 `plans.length≥2` 最划算闸前置；页面转出最划算由 compare-web spec 拥有、本变更不新增），经既有 5d-A rebuild + 跨进程失效反映（零新接线）。录入的 `current_price` **必须是同一计费基准的可比真月价**：① **真月付(month-to-month)标准价**（与既有 `maxMonthlyPrice` 月语义一致——DB 无计费周期列、按月比）；**仅年/季付者保留占位、不 admit 进 cheapest**（年÷12 含承诺折扣、与真月付不可直接比、页面无周期列披露承诺差异），周期不明同样留占位；② **标准续费价**——**促销/限时/活动浮动价禁止写成 `current_price` 冒充常态最划算**（不录）。`recordPriceChange` 金额校验只挡畸形、挡不住「促销/错周期冒充」，故①②为**人工核查纪律**（非机器闸）+ per-fact `source_url`/`last_checked` 兜溯源。**cheapest 仅表「同档月价最低」、不表「价值」**——seed 显示计费模型异构（GLM `rolling_5h_requests` 限流档 vs 国内五家 `credit/month` 额度档），各 plan 限额行随页呈现供用户判断价值；策展**优先取可比的跨厂商月订阅**作锚（同厂 GLM Lite vs Pro 为退化下界、非跨厂选型价值）。退出锚为 7 个 plan 中可核到的可比 ≥2，核不到者保留 `needs_login_recheck` 占位——**「允许零已核价」不变**（真全核不到则诚实留「数据不足」，退出未达即如实不达、不凑数）。egress/browser 生产抓取启用与本策展正交、不在本变更（留到真开自动抓取时 MODIFY `model-radar-ingestion`「Playwright 沙箱锁定」即用即验）。

#### 场景:已核价格可参与排序
- **当** 某桶2 plan 通过官方 pricing URL 核实并经授权改价入口写入价格（official_pricing/official_doc）
- **那么** 快照中该 plan 为 `priceStatus='known'`，可参与同桶同币种价格排序，且返回 official provenance

#### 场景:未核价格保持占位且零已核价仍验收通过
- **当** 桶2 某家或全部 plan 没有已核官方价格来源
- **那么** 这些 plan 在数据库和快照中保持价格/currency NULL、source_confidence 为 needs_login_recheck、不写价格历史、不参与 cheapest；结构性录入完成即算验收通过，不因缺价判失败

#### 场景:策展只录真月付标准价、促销/年付/错周期价不写成 current_price
- **当** 某桶2 coding_plan plan 的官方页展示真月付标准价、限时/活动促销价、或仅年/季付价
- **那么** curator 经 `recordPriceChange` 录入的 `current_price` **仅为真月付(month-to-month)标准价**；**促销/限时价、以及仅年/季付者**（年÷12 含承诺折扣、与真月付不可直接比、且页面无周期列披露承诺差异）**一律不写成 `current_price`**（保留占位）；此为人工核查纪律（`recordPriceChange` 挡不住合法但误导值），enforcement 靠 curator 录入前核查 + per-fact `source_url` 溯源、非机器闸

#### 场景:同档 ≥2 已核同币种真月价使快照满足 compare-web 最划算前置
- **当** curator 录入 ≥2 个同 (coding_plan, currency) 的桶2 plan 真月付标准价，使该组 `plans.length≥2`
- **那么** 经既有 5d-A rebuild + 跨进程失效，**快照**该组 `plans.length≥2` + `cheapestPlanId` 非 null + `comparable=true`，满足 **compare-web 既有 `plans.length≥2` 最划算闸**的前置数据条件（页面 render 行为由 compare-web spec 拥有、本变更不新增）；故退出验证须断言**快照组 `plans.length≥2`**（非仅 `cheapestPlanId` 非 null——后者 ≥1 即过、不证 ≥2），页面转出由 compare-web 既有测覆盖

#### 场景:已停售 plan 不留作普通待核
- **当** 某桶2 coding_plan plan 经核实其产品**已停售**（如腾讯混元 Coding Plan 无在售订阅）
- **那么** 该 plan 经 `mr_review_flag` 标「已停售/待复核」+ provenance 记停售、**不计入 cheapest**，且**不得留作普通 `needs_login_recheck` 待核**（待核暗示「待定价」会误导用户）；结构删除走授权路径、无则列 follow-up（本期不硬删）

### 需求:browser 与生产 egress gate 作为启用条件暴露

5c 必须在文档和运行约束中明确：真实 browser 定价页勘验与 browser-worker egress/netns 封锁是 browser/prod 启用 gate，不阻塞 API 开发。源的 `fetch_strategy` 必须按页面**真实性质**登记（与 tech-plan 已锁「http+browser+manual 三档全上、GLM 走 browser 不降级」一致）：JS 渲染定价页=`browser`、结构化文档页=`http`、登录墙后值/页已漂移=`manual`。为使 `http`/`browser` 桶2源能通过录入闸（`upsertSource → assertUrlAllowed`），必须为其域名扩 `MR_SOURCE_DOMAIN_ALLOWLIST`（manual 源豁免、无需扩）。**5c 的 gate 是「不启用 browser-worker 生产消费、本期不实际抓取任何源」**（egress fail-closed 自检由既有 `browser-worker-main.ts` 强制），而非把源降级成 manual——登记真实 tier 是 forward-correct，抓取由后续 gate 通过后开启。API 可以返回已有 SOT/快照数据，但不得宣称 browser 生产抓取已启用。

#### 场景:未完成 egress gate 不消费 browser job
- **当** browser-worker 启动自检未证明 RFC1918/link-local/metadata 被网络层封锁
- **那么** worker 非零退出且不消费 job，5c API 仍可基于现有快照服务

#### 场景:桶2源按真实性质登记 tier 并扩 allowlist
- **当** 录入 GLM（JS 渲染）等桶2 `browser`/`http` 源
- **那么** 其 `fetch_strategy` 反映页面真实性质（不被一律降级 manual），其域名已扩入 `MR_SOURCE_DOMAIN_ALLOWLIST` 使录入闸放行；本期不实际抓取（gate 未过）

#### 场景:文档记录 gate 决策
- **当** 查看 ROADMAP 或 Model Radar 技术方案
- **那么** 能看到 5c 可开、browser 真实勘验与 egress 部署封锁为后续启用 gate 的决策

### 需求:快照跨进程失效（Redis pub/sub，仅通道不存 blob）

经 `runSnapshotRebuild` 的写方（改价 `recordPriceChange` / seed / 策展脚本——均在**最外层事务提交后**调 `runSnapshotRebuild`）在本进程 invalidate/rebuild 之外，必须经 Redis pub/sub `publish` 一条失效消息到约定 channel。服务快照的 HTTP server 进程必须 `subscribe` 该 channel，收到消息即调既有 `invalidateModelRadarSnapshot()`（下次读冷启动 build-from-DB）。**Redis 只作 pub/sub 通道，禁止把快照 blob 存入 Redis**（DB 是唯一 SOT；复用 5c 内容哈希 version 的免协调一致性）。失效语义为 **at-most-once**：publish 失败仅记日志、非致命（不阻塞写、不抛断写事务），漏消息由周期 rebuild 自愈；不实现保证投递 / exactly-once / outbox。

**publish 时机（务必提交后、务必不在事务内）**：publish 只允许在**最外层事务提交后的 run 边界**发出（即 `runSnapshotRebuild` 内——它本就在 `db.transaction` 提交后被调），**无条件触发**（不论本进程 rebuild ok/fail——commit 已发生，peer 必须被通知）；**绝不置于 `setReviewFlag` 或任何接收 `TxLike` 的函数内**——`_recordPriceChangeTx` 在事务内调 `setReviewFlag`，事务内 publish 会令 subscriber 立即失效、server 从**未提交**的 DB 状态 build-from-DB，把脏快照回灌缓存。

**连接形态（publisher 短连接 / subscriber 长连接，配置相反）**：
- **publisher** 用短连接「连/发/拆」（仿 `health/redis.ts` 的 pingRedis：`enableOfflineQueue:false` + `maxRetriesPerRequest:1` + `retryStrategy:()=>null` + `lazyConnect:true` + `connectTimeout`（≤1s，界握手）+ **`commandTimeout`（≤1s，界 half-open 命令——Redis 连上不回包时快速失败，仿 `alert-lock.ts`/`push-lock.ts`）** + **显式 `await connect()`→`publish()` 序列**（勿依赖 lazy 自连——`enableOfflineQueue:false` 下直接 `publish()` 会立即 reject「Stream isn't writeable」即便 Redis 在线）+ 'error' handler + catch reject + finally `disconnect()`；每写 publish 阻塞上界 = `connectTimeout`+`commandTimeout`（≤~2s）——只设 `connectTimeout` 则 half-open Redis 令 `await publish()` 永不 settle、吊住 post-commit 路径），**绝不留常驻连接**——一次性 seed/脚本进程靠事件循环排空自然退出（刻意不调 `process.exit`，避免截断 stdout artifact），常驻 socket 会吊住其事件循环致永不退出；短连接同时使「publish 失败立即 reject→被 catch 记日志」成立（默认 ioredis `enableOfflineQueue` 会静默入队、既不报错也不退出）。
- **subscriber** 反之必须**保持自动重连**（用 ioredis 默认/退避 `retryStrategy` + **`maxRetriesPerRequest: null`**（同仓 BullMQ 长连约定），**禁拷贝探针的 `retryStrategy:()=>null`/`lazyConnect`**——那是一次性探针、故意不重连），断线重连后**自动 re-SUBSCRIBE**（ioredis 仅重放成功订阅过的 channel），并挂 'error' handler 吞噪声；否则 Redis 抖一次即永久静默失活、pub/sub 退化 interval-only 无告警。**`maxRetriesPerRequest:null` 是承重项**——默认 20 时冷启动恰逢 Redis 宕的窄窗会 flush 掉首个未成功的 `SUBSCRIBE`、永不重订阅；设 `null` 则首订阅滞留 offline queue 直至连上。

**flag/staleness 不走 publish**：保鲜回路 flag/staleness 是**日级 cron**写（`MR_EVENT_REVIEW_CRON='23 8 * * *'` / `MR_STALENESS_CRON='43 9 * * *'`），只经 `setReviewFlag`、**不经 `runSnapshotRebuild`**，故**不 publish**；其对服务表征（`reviewStatus.pending` / `freshness.stale`）的变更由**周期 rebuild（≤ 一个间隔）**兜底可见——日级写叠秒级 publish 无意义。

#### 场景:跨进程写经 pub/sub 令服务进程失效
- **当** 经 `runSnapshotRebuild` 的写方（seed / 策展改价）在最外层事务提交后 publish 失效
- **那么** HTTP server 进程的 subscriber 收到后调 `invalidateModelRadarSnapshot()`，其下一次读 build-from-DB 反映该变更

#### 场景:publish 只在提交后、不在事务内
- **当** 改价经 `_recordPriceChangeTx` 在同事务内调 `setReviewFlag`（history-conflict 分支）
- **那么** publish **不**在该事务内发出，只在最外层 `db.transaction` 提交后的 `runSnapshotRebuild` 边界发出；server 绝不从未提交状态 build 出脏快照回灌缓存

#### 场景:publisher 短连接不吊住一次性进程
- **当** seed/一次性脚本 publish 失效后进入自然退出（不调 `process.exit`、靠事件循环排空 flush stdout artifact）
- **那么** publisher 短连接已 `disconnect()`、不留常驻 socket，进程正常退出，不被 publish 连接吊住

#### 场景:subscriber 断线自动重连并恢复订阅
- **当** Redis 抖动致 subscriber 断线后恢复
- **那么** subscriber 自动重连并 re-SUBSCRIBE，继续接收后续失效消息（不因一次抖动永久静默失活）

#### 场景:publish 失败不阻塞写
- **当** Redis 不可达导致 publish 抛错
- **那么** 写方经 'error' handler + catch 吞错、仅记日志，写本身照常成功提交，不因失效通知失败而回滚或崩溃

#### 场景:不存快照 blob 到 Redis
- **当** 检查跨进程失效实现
- **那么** Redis 仅承载失效消息（pub/sub），不存快照内容；DB 仍是唯一 SOT、仍在读路径作冷启动来源

### 需求:服务进程内周期 rebuild（驱动 stale 翻转 + 漏消息自愈 + flag/staleness 可见）

服务快照的 HTTP server 进程必须有一个**进程内周期 rebuild**（`setInterval`，**非 BullMQ 链**——周期 rebuild 在 worker 进程内刷新对服务进程无效），按 `MR_SNAPSHOT_REBUILD_INTERVAL_MS` 以**推进的 now** 调既有**非 publish 的** `rebuildModelRadarSnapshot`（**不是会 publish 的 `runSnapshotRebuild`**——否则服务进程每 tick 自 publish→自订阅失效→冷重建 thrash）。它有三个职责：① 驱动 `freshness.stale`（now 派生离散量，无任何写能翻转它）随 now 跨 staleness 阈值翻转；② 作 pub/sub 漏消息的自愈网（间隔即「价改可见延迟上界」）；③ 令**不走 publish 的 flag/staleness 日级写**（改 `reviewStatus.pending`）在一个间隔内可见。周期 rebuild **不依赖 Redis**（纯定时器）。rebuild 失败沿用 5c fail-closed（不覆盖旧快照、记日志），不使进程崩溃。

#### 场景:周期 rebuild 翻转 stale
- **当** 无任何 DB 写，但周期 rebuild 以推进后的 now 重建、跨过某事实/源的 staleness 阈值
- **那么** 该 plan 的 `freshness.stale` 翻为 true、内容哈希 version 变（下游不会拿到 304-with-stale）

#### 场景:周期 rebuild 自愈漏消息
- **当** 某次跨进程失效漏失（Redis 抖动 / 订阅断连 / in-flight rebuild 期 `invalidate` 被完成赋值覆盖）
- **那么** 服务进程在一个 rebuild 间隔内经周期 rebuild 反映该变更，不需进程重启

#### 场景:flag/staleness 写经周期 rebuild 可见
- **当** worker 日级 cron 经 `setReviewFlag` 打 review flag / staleness（不经 publish）
- **那么** 服务进程在一个 rebuild 间隔内经周期 rebuild 反映 `reviewStatus.pending` / `freshness.stale` 变化，不依赖 pub/sub

#### 场景:周期 rebuild 用非 publish 的 cache fn（不自激）
- **当** 服务进程周期 rebuild 触发
- **那么** 它调非 publish 的 `rebuildModelRadarSnapshot`、**不** publish 失效，故不产生「自 publish→自订阅 invalidate→冷重建」回环

#### 场景:Redis 全挂周期 rebuild 仍工作
- **当** Redis 不可用（pub/sub 通道断）
- **那么** 周期 rebuild 作为纯 setInterval 照常重建、读路径 DB 兜底仍可服务；不因 Redis 故障停止刷新

### 需求:服务进程订阅/定时器生命周期与只读不变量

HTTP server 进程启动时必须建立 subscriber 连接 + 周期 rebuild 定时器；优雅关闭（SIGINT/SIGTERM）时必须清除定时器并 quit subscriber 连接（不泄漏句柄、不阻塞退出）。`subscriber.quit()` 为 **best-effort**（须包 `.catch()` 防 Redis 挂时 quit reject 成 unhandledRejection；只读 subscriber 无未刷状态，被 `process.exit` 截断亦无害）；定时器须 `.unref()` 不阻塞退出。跨进程失效与周期 rebuild **不得违反 5c「请求路径只读」**：周期 rebuild / 订阅回调写的是**进程内缓存**（与 fail-closed 替换），**绝不写 `mr_*` 或既有表**，也不 bump `mr_catalog_version`（公开 version 仍唯一来自内容哈希）。

#### 场景:优雅关闭清理订阅与定时器
- **当** HTTP server 收到 SIGINT/SIGTERM
- **那么** 周期 rebuild 定时器被 `clearInterval`、subscriber 连接被 `quit()`（best-effort、包 `.catch()`），进程不因悬挂句柄卡住退出

#### 场景:失效/重建不写库
- **当** 周期 rebuild 或订阅回调触发
- **那么** 仅进程内缓存被替换/清空；`mr_*` 与既有表无任何写、`mr_catalog_version` 不被 bump

### 需求:只读快照暴露 availability + 季/年付周期价（含有效月价），cheapest 仍以月价

只读快照 DTO 必须逐 plan 暴露 `availability ∈ {on_sale, discontinued, unknown}` 与 `periodPrices[]`（`{billingPeriod ∈ {quarterly,annual}, price, currency, priceStatus, provenance, effectiveMonthly}`）。周期价 `priceStatus='known'` 当且仅当 price 非 NULL + 官方 confidence；`effectiveMonthly` = 确定性 `price ÷ {quarterly:3, annual:12}`，但当 `priceStatus!='known'` 时必须为 `null`。比价 / cheapest 仍以 canonical 月价（`current_price`）排序、money-path 排序口径不变；周期价仅作附加暴露和最佳周期依据，不进 cheapest/sort。Token Plan 不生成 effectiveMonthly / 最佳周期。

#### 场景:DTO 暴露 availability + 周期价、cheapest 仍月价
- **当** 某 (coding_plan, CNY) 组含月付 ¥49 与年付 ¥468（effectiveMonthly ¥39）的 plan
- **那么** 快照逐 plan 带 `availability` + 年付 `periodPrices`；该组 cheapest 仍按月价 ¥49，而不是按年付有效月价 ¥39

#### 场景:未核周期价 effectiveMonthly 为 null
- **当** 某年付行 `price=NULL,currency='CNY',source_confidence='needs_login_recheck'`
- **那么** DTO 中该行 `priceStatus='unknown'`、`effectiveMonthly=null`，不得输出 0 或省略导致下游误判

#### 场景:停售 plan 经 availability 暴露、不靠占位暗示
- **当** 某 plan `availability='discontinued'`
- **那么** 快照 DTO 显式带 `availability='discontinued'`，供 query/recommender 区分「停售」与「未核价」；不靠 NULL 价占位暗示停售

