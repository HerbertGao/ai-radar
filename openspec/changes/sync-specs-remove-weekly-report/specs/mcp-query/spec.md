## MODIFIED Requirements

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
