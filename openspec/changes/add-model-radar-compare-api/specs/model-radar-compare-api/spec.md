## 新增需求

### 需求:只读快照从 mr_* 子集构建并校验

系统必须提供 Model Radar 只读快照构建器，从构建所需的 `mr_*` 子集（9 张：vendors/plans/models/plan_models/plan_clients/plan_limits/source/plan_sources/review_flag，**不含 `mr_price_history`、也不含 `mr_catalog_version`**——后者在 5c 既不服务也不哈希也无写入者，公开 version 由内容哈希派生，故不读入快照；该表为 5a 所建、5c 保留不写、留未来/内部用途）读取并构建去规范化 JSON。快照必须覆盖 vendor、plan、models、clients、limits、`mr_source`、`mr_plan_sources`、provenance、staleness、review flag，并在对外返回前经过 Zod schema 校验。快照读取必须是**单事务、point-in-time 一致**（如 `REPEATABLE READ` 或显式 pg 快照），防止跨表撕裂读（构建中途有写提交导致 plan 读到却漏其刚写的 child 行）；逐行 Zod 校验不足以捕获跨表不一致。API 请求热路径禁止直接 join 规范化 `mr_*` 表作为主要读路径。

#### 场景:快照包含完整关系与 provenance
- **当** 数据库中存在一个 plan 及其模型、工具/协议、限额和待复核 flag
- **那么** 快照中同一 plan 带有这些去规范化关系、每条断言事实的 `source_url`/`source_confidence` provenance、离散 freshness（仅 `stale`；raw 秒级 `last_checked` 仅 builder 内部用于算 staleness、不入服务表征），以及 pending review 状态

#### 场景:快照单事务一致读不撕裂
- **当** 在快照构建过程中有并发写提交（如新增某 plan 的 limit 行）
- **那么** 构建器在单事务 point-in-time 视图下读取，结果要么完全包含该写、要么完全不含，不出现「读到 plan 却漏其 child」的撕裂态

#### 场景:快照 schema 校验失败不对外服务且不覆盖旧快照
- **当** 快照构建结果缺失必需 provenance 字段或出现非法枚举值
- **那么** 构建器必须报错、不缓存坏快照、不覆盖既有可用快照；冷启动首建即失败时 API 返回 503 且不写缓存，绝不返回坏快照

### 需求:快照聚合源与厂商待复核及陈旧状态

快照中每个 plan 的 `reviewStatus`/`staleness` 必须聚合：① 直接指向该 plan 的 `mr_review_flag`；② 指向其 vendor 的 flag；③ 经 `mr_plan_sources` 关联的 `mr_source` 的 flag 与源 `last_checked`；④ plan 自身及其 child 事实行（`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`）的 `last_checked`。任一为 pending/陈旧，则该 plan 必须暴露为待复核/陈旧，禁止只看 plan 级 flag 而把关联源/child 行已待复核或陈旧的 plan 显示为干净。陈旧判定必须与既有 staleness 排程同口径：**`last_checked IS NULL 或 < 阈值` 即陈旧**。其中 **NULL 分支仅对 `mr_source.last_checked` 可达**（按 DDL 仅它 nullable；`mr_plans`/`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models.last_checked` 均 `NOT NULL`，只走「< 阈值」比较）——从未抓的 browser 源（`last_checked NULL`）必须判陈旧，不被 `now - NULL` 误判新鲜。

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

同桶排序必须将 plan 判为 `priceStatus='known'` **当且仅当**：`current_price` 非 NULL、`currency` 非 NULL、且 `source_confidence` 属已核官方集合 `{official_pricing, official_doc}`。任一不满足（价格或币种为 NULL，或 confidence 为 `needs_login_recheck`/`official_community`/`media_report`）一律判 `priceStatus='unknown'`（未核）。已知价格只在**同一 category 且同一 currency** 内按数值升序排序；不做汇率换算。未知价格（currency 视为 NULL）**当其在结果集中时**必须归入 `sortScope.currency=null` 的未知价组、不挂任何已知币种组（与「currency 过滤指定币种时排除未知价」互不冲突——前者是默认分组归属、后者是谓词过滤把未知价移出结果集，二者 mode-disjoint），不参与“最便宜”结论，并在 `requiresKnownPrice=true` / 预算过滤 / `currency` 过滤时被排除。禁止把 NULL 当作 0、估算价或默认价；禁止用非官方 confidence 的价格冒充已核价参与 cheapest。

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

### 需求:快照版本与 ETag 必须随数据变更失效

API 暴露的 `version`/ETag 必须在底层数据变更后改变，否则下游 HTTP 304 会返回陈旧价。**唯一公开 `version`/ETag 源 = 快照内容哈希**（方案①）：哈希前必须 **canonical 序列化**——既排序对象键，**也固定数组/行序**（buildSnapshot 各表 `ORDER BY id` 或 builder 内按稳定键排序；PG 无 `ORDER BY` 时按物理序返回会让无数据变化的哈希漂移）。**`mr_catalog_version`/`builtAt` 纯属内部用途、不作公开 `version`/ETag 源、不进服务表征**（避免「bump 每周期/无变化也变」与内容哈希语义冲突）——5c 不引入「bump mr_catalog_version 作公开 version」的备选路径。

**哈希内容契约（ETag = 服务表征的纯函数；防过度失效 + 防 304-with-stale）**：ETag 必须是 **API 实际返回的服务表征**的 canonical 哈希——**不得有 served-but-unhashed 或 hashed-but-unserved 字段**，唯一例外是 `version`/ETag 字段本身：响应体 `version`（若返回）**等于该内容哈希、是从 canonical 服务表征派生的传输别名，本身不进入哈希输入**（无法把含自身哈希的字段再哈希——自引用）。`builtAt` 是 builder 内部、`mr_catalog_version` 留未来/内部（5c 不读不入快照），二者**绝不出现在服务表征**（故不入哈希、不致空闲期漂移）。为同时满足「无变更稳定」与「跨阈值翻转」，**服务表征的 freshness 仅暴露离散 `stale: boolean`**（由 `last_checked IS NULL 或 < (注入 now − 阈值)` 算出；plan 级 `stale` = 其任一成分事实/源 stale 的聚合，良定义），**服务表征不暴露 raw 秒级 `last_checked`、也不暴露 `lastCheckedDate`**（raw last_checked 仅 builder 内部算 staleness；provenance 仍含 `source_url`/`source_confidence`）。如此「排除 raw last_checked / now 派生连续量（ageMs）/ 构建时刻」对 hash 与 served 表征**同时成立**、无 served-vs-hash 错配。由此：① 同一注入 now、无服务表征变化 → 哈希稳定、304 命中、不过度失效；② now 推进**跨过 staleness 阈值** → `stale` 翻转 → 服务表征变 → ETag 变（客户端不会拿到 304-with-stale）；③ 仅推 raw 秒级 `last_checked`（未翻 stale）的写不改服务表征 → ETag 可不变。

**已拒绝的替代方案（5c 不采用）**：「bump `mr_catalog_version` 作公开 version 源」——它会带来「每周期 bump/无变化也变」的过度失效，且若在 on-read 触发则让 GET 在请求路径写 `mr_*`、违反「请求路径只读」；故 5c 唯一公开源是内容哈希，不引入该备选。hashed 内容真变经 rebuild 后 ETag 必须变化、无变更则 ETag 稳定。

rebuild **recompute** 必须**无缺口**地覆盖一切改变快照可见字段的授权写（recompute 覆盖全部路径；ETag 是否变化取决于 hashed 内容是否真变——纯幂等 no-op 允许 ETag 不变）：① **改价**——recompute 必须覆盖**两个改价入口**（公开 `recordPriceChange` **与** `upsertPlan` 经 `_recordPriceChangeTx` 的委托改价路径），且在**最外层事务提交后**触发（提交前重建会读不到未提交价），并覆盖 `recordPriceChange` 的**全部 success outcome**（appended / noop-refreshed / noop-same-tuple / history-conflict 等），不得只钩 `outcome==='appended'`；其中 appended/provenance 变会改 hashed 内容→ETag 变，而 `noop-same-tuple`（仅推 last_checked、未翻 stale 谓词、无其它变化）属幂等 no-op、ETag 可不变（304 仍正确）；② **结构性录入事实变**（seed / 策展脚本 / ad-hoc `upsertPlan*`/`upsertVendor`/`upsertSource` 等）由脚本末尾触发或由③的周期 rebuild 兜（单条 ad-hoc 结构写不保证即时刷 ETag，归周期 rebuild）；③ **保鲜回路的 flag/staleness 写**（`setReviewFlag`/`markChecked`/staleness 排程改 reviewStatus/staleness）路径众多且 cron 驱动，须由**后台周期 rebuild 安全网**兜底——**周期/带外、非 on-read**，请求路径绝不触发写。**5c 范围**：交付可直接调用的 rebuild job body + builder/cache 注入 `now` + CI 测；**常驻 worker 装配（链7 = queue/schedule/worker 四件套）与跨进程失效（Redis pub/sub）随 5d 接线**（5c 无 live 消费者，常驻安全网 blast radius=0；机制就绪、装配延后，不在 5c 谎称已是运行中安全网）。实现宜把 rebuild 钩在写编排边界（包住两个改价入口）+ 后台周期安全网，而非脆弱地逐入口枚举或 on-read 触发。

#### 场景:数据变更后 ETag 变化
- **当** 某 plan 价格经授权改价入口更新后触发快照 invalidate+rebuild
- **那么** API 返回的 version/ETag 与变更前不同，下游不会拿到陈旧 304

#### 场景:授权写触发 rebuild（含 upsertPlan 委托改价）
- **当** 改价经 `recordPriceChange` 或经 `upsertPlan` 委托路径成功（任一 success outcome）
- **那么** 在最外层事务提交后必触发快照 rebuild recompute（不留「改价但未 rebuild」缺口）；ETag 仅在 hashed(=服务表征) 内容真变时变化——appended/provenance 变 → ETag 变，纯 `noop-same-tuple`（仅推 raw last_checked、未翻 stale）→ 服务表征不变、ETag 可不变

#### 场景:保鲜回路 flag 写经 rebuild job body 反映
- **当** 保鲜回路给某 plan 打 pending flag（不经改价入口），随后直接调用 rebuild job body（注入 now）
- **那么** 快照 reviewStatus 反映该变化、ETag 变化（请求路径不触发任何写）；测试经直接调 job body + 注入 now 断言，无需真实等待或常驻 worker

#### 场景:staleness 阈值穿越翻转 ETag（不 304-with-stale）
- **当** 无任何 DB 写，但注入 now 推进**跨过**某 source 的 staleness 阈值（前一刻 stale=false，跨后 stale=true）
- **那么** 离散 stale 谓词翻转使 hashed 内容变、ETag 变（X→Y），客户端不会拿到 304 却附过期 stale 状态

#### 场景:不跨阈值无变更 rebuild 不漂移 ETag
- **当** 注入 now 推进但**未跨任何 staleness 阈值**、且无任何快照可见字段变化
- **那么** 内容哈希 ETag 保持不变、下游 304 仍命中（不过度失效；哈希不含构建时刻/now 派生连续量）

### 需求:API 与快照路径只读、不碰既有表

Model Radar 比价/检索 API 的**请求路径**必须只读 `mr_*`：禁止在请求路径执行 `mr_*` 的 INSERT/UPDATE/DELETE，禁止触碰 `ai_products`、新闻、推送、KB 等既有表（bounded domain 隔离）。快照**读取**（buildSnapshot 的 SELECT 部分）只读；唯一的写是 rebuild 时写**进程内/缓存**（非 `mr_*`）。5c 不在任何路径写 `mr_*` 作 version（无 catalog bump）。已核价格只来自人工经授权改价入口（`recordPriceChange`）写入，故 API 正确性与 browser 抓取链解耦。

#### 场景:API 请求不写库
- **当** 调用任一 Model Radar 只读 API
- **那么** 不对 `mr_*` 或既有表执行任何写操作

### 需求:桶2数据策展只录已核价格、允许零已核价

5c 的桶2 Coding Plan 数据（百炼、千帆、腾讯、火山、讯飞）必须通过结构化录入进入 `mr_*`。每家的**结构性**录入（vendor + coding_plan plan + source + model/client/limit + 各自 provenance）是验收对象；真实价格只有在有已核官方来源时才能通过授权改价入口写入 `current_price/currency` 和 `mr_price_history`。**本期不要求录到任何已核价**——browser 真实勘验为价格核实前置且被列为后续 gate，故本期允许 0 个已核价；无法核实者必须保持 `current_price=NULL`、`currency=NULL`、`source_confidence='needs_login_recheck'`，禁止为凑数填传闻价/占位价。同桶排序测试必须用合成 in-memory 快照 fixture，不得依赖 seed 行有真价。

#### 场景:已核价格可参与排序
- **当** 某桶2 plan 通过官方 pricing URL 核实并经授权改价入口写入价格（official_pricing/official_doc）
- **那么** 快照中该 plan 为 `priceStatus='known'`，可参与同桶同币种价格排序，且返回 official provenance

#### 场景:未核价格保持占位且零已核价仍验收通过
- **当** 桶2 某家或全部 plan 没有已核官方价格来源
- **那么** 这些 plan 在数据库和快照中保持价格/currency NULL、source_confidence 为 needs_login_recheck、不写价格历史、不参与 cheapest；结构性录入完成即算 1.4/1.5 验收通过，不因缺价判失败

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

## 修改需求

## 移除需求
