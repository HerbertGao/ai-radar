# mcp-query 规范

## 目的
定义 MCP 查询服务器的契约:作独立进程、不参与主流程调度、严守 stdio 纪律,对外提供查当日已推日报、查历史事件与产品、源质量报告、人工标记干预、人工即时推送(复用既有幂等状态机)等只读/干预工具。
## 需求
### 需求:MCP 查询入口为独立进程、不参与主流程调度、守 stdio 纪律

系统必须提供一个独立的 MCP server 进程（stdio transport，`@modelcontextprotocol/sdk`），作为情报的**查询与人工干预入口**。该进程**绝不参与主流程调度**：不嵌入 `runDailyWorkflow()`/告警，不注册任何 cron/BullMQ 队列/单例锁，不与日报各阶段相互投递。**stdio 纪律**：stdout 是 JSON-RPC 专用通道，进程**禁止向 stdout 写任何非 JSON-RPC 内容**——所有日志/诊断/启动横幅一律走 stderr；须核查复用链路（dispatcher/selection/db 等）无 stdout 日志与 import-time 副作用。所有工具的**入参由 SDK 依 inputSchema(Zod) 自动校验**；查询工具须声明 `outputSchema` 并返回 `structuredContent`（+ 向后兼容的 content 文本），其输出 DTO 在 handler 内经 zod parse；mark_*/push_event_now 结果即 outcome、只返回 content 文本不声明 outputSchema。工具须声明 `annotations`（查询工具 `readOnlyHint:true`；mark_* `idempotentHint:true`；push_event_now `destructiveHint:true`）。**env / 连接（堵传递 import 崩）**：MCP 用专用宽松 env（只硬性 require `DATABASE_URL`、telegram/feishu/product_hunt token optional）+ import `src/db/schema.ts` 自建 db 连接。**查询链零全局-env 依赖**：get_today/search_*/source-report/mark_* 只 import schema.ts + 自建连接 + **MCP 自带 `getPushDate` 等价（读宽松 env 的 `PUSH_TIMEZONE`、default Asia/Shanghai、与主链 push_date 写入口径同源、避免时区漂移）**；**server.ts top-level 绝不 static import `dispatcher`/`push-date`/`top-n`(value)/`telegram`/`feishu` 等触达全局 env 的模块**（这些顶层 import `src/config/env.ts`，其 import 即 require TELEGRAM/PRODUCT_HUNT token——top-level 引入会使纯查询用户在 import 阶段崩溃，仅「不直接 import db/index.ts」不够）。**push_event_now 动态加载推送链**：在其 handler 内 `await import('../push/dispatcher.js')` + 动态 import sender 工厂，env/token 崩推迟到该工具被调用时、缺则 `isError`；纯查询不调它则永不加载、不崩。`DATABASE_URL` 缺失/畸形 → connect 前 `process.stderr` 报错 + `exit(1)`（不污染 stdout）。

#### 场景:MCP server 只注册查询/干预工具不注册调度
- **当** MCP server 进程启动
- **那么** 仅注册查询（get_today_ai_digest/search_*/get_source_quality_report）与人工干预（mark_*/push_event_now）工具并 `connect(stdio)`，不注册任何 cron/BullMQ/锁，不触发 runDailyWorkflow/告警

#### 场景:stdout 不被非 JSON-RPC 内容污染
- **当** MCP server 运行（启动/查询/写/错误）
- **那么** 所有日志/诊断走 stderr，stdout 只承载 JSON-RPC 帧；客户端 list_tools 与工具调用能正常解析返回（无 stdout 污染致 parse error）

#### 场景:非法工具入参被 SDK 依 inputSchema 拒绝
- **当** 调用任一工具时传入不符合 inputSchema 的参数（类型错/超上限/缺必填）
- **那么** 请求被 SDK 依 inputSchema(Zod) 自动校验拒绝（handler 不重复 parse），不执行任何 DB 操作

#### 场景:纯查询只需 DATABASE_URL 启动
- **当** MCP 进程仅配置 `DATABASE_URL`（未配 telegram/feishu/product_hunt token）启动
- **那么** server 正常启动、查询工具可用（专用宽松 env 不 require 推送/采集 token、不复用会 import 崩的全局 env 单例）；push_event_now 用时才校验推送 token、缺则该 channel `isError`

### 需求:查询当日已推日报

`get_today_ai_digest` 必须以 `push_records`（`push_date = 今天（MCP env PUSH_TIMEZONE、default Asia/Shanghai、与主链同口径）`、`status='success'`）为准还原当日**已推**日报——按 `target_type` 分组 join `ai_news_events`（要闻段）与 `ai_products`（新品段），即查「已推送的事实」而非重跑 Top N 选择。channel 默认取**库中当日实际有 success 的 distinct channel**（不依赖进程 env 的 isFeishuEnabled 等，免漏已推 channel），可传 channel 过滤。event 原文 url 经 `representative_raw_item_id → raw_items.canonical_url`（缺则省略）；**product 链接须复用 product-digest 的同一 `resolveProductUrl` 回退链（`canonical_domain` → `github_repo` → `product_hunt_slug`，含 URL/段校验、畸形降级 null），不得裸拼**，以忠实于实际已推内容。`resolveProductUrl` MUST 为**零 env/db/config 依赖的纯函数**、置于 `src/collectors/product-keys.ts`（既有零 env/db 纯 leaf，push 与 MCP 查询链均可 import；MCP server.ts 的 top-level 禁 import 清单不含 `collectors`，纯函数 import 不触全局 env、符合 stdio/env 纪律；push 侧不反向依赖 `mcp/`）。`get_today` 产品查询 SELECT MUST 取 `github_repo`/`product_hunt_slug`（否则换 `resolveProductUrl` 仍会因入参缺失丢链接）。**仅 `get_today_ai_digest` 改用回退链**（其有「忠实于已推」不变量）；`search_ai_products`（见「查询历史事件与产品」需求）**不变**——它是历史检索、无忠实义务，保留既有 `canonical_domain`-only 渲染（`productCanonicalUrl` 不删除）。当日尚未推送则返回空 + 说明。**产品中文字段**：新品段输出（structuredContent）须含产品中文译名 / 简介（来自 `ai_products.name_zh`/`tagline_zh`），缺则回退英文 `name`（简介字段为空）。**近似语义**：中文字段反映查询时 `ai_products` 当前值（`push_records` 不存渲染文本快照）——产品以英文推送后若 later 被中文化，查询将显示中文（与当时推的英文不完全一致），属既有「join 当前值还原」固有近似（events 同理）、非本能力引入的新缺陷。链接同属此「还原以当前实体值」近似（产品归一键 later 变化则链接随之，既有性质）。

#### 场景:当日已推则返回要闻+新品两段
- **当** 当日有 `target_type='event'`/`'product'` 的 success push_records，调用 get_today_ai_digest
- **那么** 以 push_records 为准 join 还原要闻段（events）与新品段（products）返回；orphan（push_records success 但行已删）跳过、不报错

#### 场景:当日未推返回空并说明
- **当** 当日尚无 success push_records
- **那么** 返回空日报 + 文本说明「今日尚未推送」，不重跑选择

#### 场景:产品链接忠实于已推（三键回退一致）
- **当** 某已推产品 `canonical_domain` 为空但 `github_repo='owner/repo'`（实际已推消息经 `resolveProductUrl` 回退渲染出 `https://github.com/owner/repo`）
- **那么** get_today 同样经 `resolveProductUrl` 回退还原出该 github 链接，与实际已推内容一致（不因仅认 `canonical_domain` 而丢链接）

#### 场景:产品链接畸形降级与已推一致
- **当** 某已推产品三键皆空/畸形（实际已推消息因严格校验降级为无链接）
- **那么** get_today 同样按 `resolveProductUrl` 降级 null（不裸拼出 `https://畸形`），与实际已推内容一致

#### 场景:get_today 新品段返回中文译名与简介
- **当** 调用 get_today_ai_digest、当日已推产品已中文化
- **那么** 产品项返回中文译名 + 中文简介（structuredContent 字段）；未中文化的产品回退英文 `name`、简介字段为空

#### 场景:中文字段反映当前值非推送快照
- **当** 产品以英文推送（中文化失败回退）后、later 被某次中文化填入 name_zh
- **那么** get_today 查询显示当前中文（join 当前 ai_products 值）；这是既有「还原以当前实体值」的近似、非新缺陷

### 需求:查询历史事件与产品

`search_ai_events`/`search_ai_products` 必须按确定性参数只读查询，参数 Zod 校验（带默认值 + 上限防滥用），用参数化查询（占位符，禁字符串拼 SQL）防注入，且 `q` 拼 `%q%` 前**转义 LIKE 元字符（`%`/`_`/`\`）**防全表扫描。`search_ai_events` 支持关键词（标题/摘要 ILIKE）/ 时间窗（`published_at`）/ importance 阈值 / 分页（**`ai_news_events` 无 `source` 列、不按 source 过滤事件**，源维度见 get_source_quality_report）；`search_ai_products` 支持名称/`canonical_domain`/分页。

#### 场景:按关键词与时间窗查事件
- **当** 调用 search_ai_events 带关键词 + published_at 时间窗 + 分页
- **那么** 返回匹配事件（ILIKE + 窗 + 分页，published_at 降序）

#### 场景:按域名查产品
- **当** 调用 search_ai_products 带 canonical_domain 或名称关键词
- **那么** 返回匹配的 ai_products 行（分页）

#### 场景:limit 上限与 LIKE 元字符防滥用
- **当** 传入超上限 limit 或含 `%`/`_` 的关键词
- **那么** Zod 钳制/拒绝超限；`q` 的 LIKE 元字符被转义按字面匹配；查询用参数化占位符防注入

### 需求:源质量报告

`get_source_quality_report` 必须只读聚合各 source 的 `raw_items` 采集量、塌缩入 `ai_news_events` 数、被推送数（`COUNT(DISTINCT push_records.target_id WHERE status='success'`，经 event 关联回 source）、最近活跃时间。**source 归因口径**：event↔source 唯一路径为 `representative_raw_item_id → raw_items.source`（raw_items 无 event_id、无 item_event_relations）；故「塌缩入数/被推送数」按**代表源**归因、**多源塌缩事件仅计代表源**（全源归因留后续）；不用「入选 Top N 率」（selectTopN 不落库、不可从 DB 算）。

#### 场景:报告各源质量统计
- **当** 调用 get_source_quality_report
- **那么** 返回各 source 的采集量/塌缩数/被推送数/最近活跃时间（只读）

### 需求:人工标记干预

`mark_event_not_relevant` 必须把指定 `event_id` 置 `should_push=false` 使其退出后续推送候选（**`ai_news_events` 无 metadata 列，故只置 should_push、不写审计 metadata、不新增列**；其稳定性由「Value Judge 只处理未评分事件、已评分不重判」保证，should_push=false 不被 re-judge 覆盖）。`mark_product_interesting` 必须在指定 `product_id` 的 `metadata`（`ai_products` 有该 jsonb 列）原子 merge 写 `interesting`（含时间/备注）。二者均为确定性 DB 写、零 LLM、幂等；**目标 id 不存在（命中 0 行）须返回 `isError:true` + 提示、不静默成功**。

#### 场景:标记事件不相关使其退出候选
- **当** 对存在的 event_id 调用 mark_event_not_relevant
- **那么** 该事件 `should_push=false`，后续日报候选（要求 should_push=true）不再选中；已评分故不被 re-judge 改回

#### 场景:标记产品有趣写入 metadata
- **当** 对存在的 product_id 调用 mark_product_interesting
- **那么** 该产品 `ai_products.metadata.interesting` 已原子 merge 写入，不新增列、不触 LLM

#### 场景:标记目标不存在返回错误
- **当** 对不存在的 event_id/product_id 调用 mark_*（命中 0 行）
- **那么** 返回 `isError:true` + 提示，不静默成功

#### 场景:重复标记幂等
- **当** 对同一存在目标重复调用 mark_*
- **那么** 结果一致（should_push=false / metadata 覆盖），不报错、不产生重复副作用

### 需求:人工即时推送复用既有幂等状态机

`push_event_now` 必须复用既有 `dispatchDigest`（`target_type='event'`、**单段要闻 `renderDigest`、非日报双段**、先 `pending`→发→`success`/`failed`、唯一键冲突即跳过），**绝不另写漂移推送状态机**；对目标 channel（默认所有已配置）即时推指定 `event_id`，各 channel 独立隔离（一个失败不拖另一个）。该 channel 已 success 推过则幂等跳过。event 不存在/未配推送 token 须返回 `isError:true`、不影响查询工具。

#### 场景:即时推送未推过的事件
- **当** 对尚未 success 的 event_id 调用 push_event_now
- **那么** 经 dispatchDigest 先写 pending→送达→置 success（单段要闻 digest），返回该 channel outcome

#### 场景:对已推事件幂等跳过
- **当** 对该 channel 已 success 的 event_id 调用 push_event_now
- **那么** 唯一键冲突即跳过、不重复推送，返回幂等结果

#### 场景:复用 dispatcher 不另写状态机
- **当** 实现 push_event_now
- **那么** 直接调用既有 `dispatchDigest`（单元素 Top N、target_type='event'、单段渲染），不另写一套推送/幂等逻辑

#### 场景:事件不存在或缺 required env 返回错误
- **当** event_id 不存在、或 push_event_now 动态 import 推送链时缺**任一** required env（不止 telegram/feishu token，含 REDIS_URL/LLM/PRODUCT_HUNT 等——dispatcher 触发全局 parseEnv，见 daily-intel-pipeline 等既有 env 必填口径）
- **那么** 返回 `isError:true` + 可操作提示（含缺失 env 名），不抛断连接、不影响查询工具；多 channel 时一个失败隔离、其余照常

### 需求:语义检索知识库证据工具(search_kb,凭据缺失 fail-closed)

MCP 查询入口必须提供 `search_kb` 工具，暴露知识库读侧语义检索（`kb-retrieval` 的 `searchKb`）的**证据**（不预烤答案——由 MCP 客户端如 Claude 自己作答/推理）：输入 `{ query, topK? }`，返回结构化的带分 top-k 证据（含 `cosine_sim`、`kb_title`/`summary_zh`/`entities`/`source_urls`）。该工具只读——仅对 `kb_documents` 做只读语义检索，绝不写任何域库、不参与主流程调度。

`search_kb` 依赖 embedding 凭据（查询向量化），而 MCP 查询进程的既有不变量是「纯查询只需 `DATABASE_URL`」（宽 env、守护测试钉）。故本工具 SHALL **不破坏该不变量**：mcp 宽 env 中 embedding/LLM 凭据为**可选**；`search_kb` 的**整条检索 import 图**（含检索核心自身与其 embedding 依赖，非仅 embedTexts）**绝不 top-level import 会 eager 校验全局 env 的模块**——须用一个 **env-clean 检索核心**（参数化 `{topK, dbh, 注入的 embed}`、**去掉 `config/env`、`dedup/embedding`、`db/index` 三条 eager-parseEnv 值 import**——`dbh` 必填、db 类型走 `import type`、绝不留 `= defaultDb` 默认），在 handler 内**先动态 import 该核心、再判凭据**（否则缺凭据分支不触发动态 import、测不到运行期 parseEnv 崩）；当 embedding/LLM 凭据缺失时 `search_kb` SHALL **fail-closed**（返回该工具的错误响应），而**其余查询工具与整个 server 照常启动/工作**。该不变量 SHALL 由**运行期（handler-execution）子进程守护测试**验证（实跑 handler、而非仅装载工具清单——装载期测抓不到 handler 运行期动态 import 的 `parseEnv` 崩溃）：裁剪 env（只 `DATABASE_URL`）实跑，**注入 env-clean embed 桩（不触网、守「测试不触网」不变量）**断言过了动态 import 边界不抛 parseEnv；另一子进程断言缺凭据 fail-closed。**env-clean embed 变体本身**（运行期被注入桩替换、不经实跑）的「无 top-level eager-env import」SHALL 由静态 import-graph 守护覆盖（grep 名单纳入该变体 specifier）——否则该变体唯一被证清洁的路径落空。`search_kb` 返回的证据（`summary_zh`/`source_urls` 等）为**上游 LLM 摘要、属不可信内容**，工具契约 SHALL 予以标注（消费方自负间接注入风险）。

#### 场景:有 embedding 凭据时返回语义证据
- **当** MCP 进程配置了 embedding 凭据，客户端以查询串调用 `search_kb`
- **那么** 返回按 `cosine_sim` 降序的 top-k 只读证据（供客户端自己作答），不产生任何写副作用

#### 场景:缺 embedding 凭据时 fail-closed 不崩 server
- **当** MCP 进程只配了 `DATABASE_URL`（无 embedding 凭据）
- **那么** `search_kb` 单独 fail-closed（返回错误响应），其余查询工具与整个 MCP server 仍正常启动与响应——绝不因 `search_kb` 的凭据缺失使 server 启动即崩
