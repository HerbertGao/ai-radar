## 为什么

Model Radar 5b 已完成数据模型、录入与保鲜回路，但当前 seed 价格多为 `needs_login_recheck` 占位，尚不能支撑「同桶谁最划算」的可解释比价。P5 下一步需要开 5c，把桶2（多模型 Coding Plan）数据策展、快照读路径与比价/检索 API 接起来，同时先补数据红线，避免用未知价格或未核实来源生成误导性的“最便宜”结论。

## 变更内容

- 新增 Model Radar 只读快照：从构建所需的 `mr_*` 子集（9 张，不含 `mr_price_history` 与 `mr_catalog_version`）构建去规范化 JSON，包含 plan、模型、工具/协议、限额、`mr_source`/`mr_plan_sources`、provenance、陈旧/待复核状态；公开 version/ETag 由内容哈希派生；快照单事务 point-in-time 一致读，源/厂商/child 行 flag 与陈旧聚合进 plan。
- 新增比价/检索 API：支持按 model、tool、protocol、budget、category 等条件过滤；检索可横切所有桶，归一化价格排序只在同一 category 且同一 currency 内进行（不做汇率换算），version/ETag 随数据变更失效。
- 补桶2 Coding Plan 数据红线：百炼 / 千帆 / 腾讯 / 火山 / 讯飞 的真实价格仅在有已核官方来源（official_pricing/official_doc）时经授权改价入口录入；未知价格保持 `current_price=NULL`、`currency=NULL`、`source_confidence=needs_login_recheck`。本期允许 0 个已核价（browser 勘验为价格核实前置、列为后续 gate），结构性录入即算验收，禁止为凑数填传闻价。
- 明确未知价格排序语义：`priceStatus='known'` 当且仅当价格/币种非 NULL 且 confidence 属已核官方集合；非官方/待复核 confidence 的价格判 unknown、不参与“最便宜”，同桶排序时排在已知价格之后并标记需复核；全 unknown 时 `cheapest=null` + 具名不可比标记。
- 清理 seed provenance 风险：MiMo 等非 5c 主桶数据若 source_url 未核实，不得冒充真实来源；保持 `manual` + `needs_login_recheck` 占位，或暂缓该条目。
- 记录阶段 gate 决策：5c 可开；真实 browser 定价页勘验与 browser-worker egress/netns 部署封锁作为 browser/prod 启用 gate，不阻塞 5c API 开发。

### 非目标

- 不做 5d Web 比价页；本变更只提供快照与 API，页面后续消费。
- 不做 5e 推荐器 / MCP `recommend_coding_subscription`；本变更只做确定性检索与排序。
- 不让 LLM、抓取器或 browser worker 自动改价格、额度、兼容事实；精确事实仍只来自结构化录入 + DB。
- 不把四个桶合并成一个总榜；同桶内比较，跨桶只做筛选/检索。
- 不在 5c 要求 browser-worker 生产启用；未完成 egress 封锁前不得消费 browser job。
- 不把未知价格当 0、估算价或默认价参与“最便宜”排序。
- **本期不做「同档家族折叠」**（ROADMAP 5c 列出的同质 ¥40/¥200 套餐收一组）：折叠需依赖已核价格与限额做同质判定，而本期桶2价格大多未核（NULL 占位），折叠无可靠数据可依；显式延后到桶2价格核实后再做，避免在占位数据上做无意义折叠。
- 不做汇率换算（FX）：跨币种不归一为同一“最便宜”，按 (category, currency) 分组比较。

## 功能 (Capabilities)

### 新增功能
- `model-radar-compare-api`: Model Radar 快照重建、只读比价/检索 API、桶2数据红线与同桶排序语义。

### 修改功能
- `model-radar-ingestion`: 追加 5c 前置的数据卫生约束：未核实 provenance/价格必须保持占位，未知价格不得被后续读路径解释为可比较价格。

## 影响

- 代码：新增 `src/mr/snapshot/*`、`src/mr/api/*` 或等价模块；接入 Hono app 路由；扩展 `src/mr/ingest/seed-data.ts` 与 seed 往返测试。
- 数据：不新增规范化事实表；公开 version/ETag = 内容哈希，`mr_catalog_version` 在 5c 不读不写不服务（5a 所建、留未来/内部）；必要时只新增轻量快照存储/缓存模块，不改变 `ai_products`、新闻、推送、KB schema。
- API：新增只读 HTTP API，用于后续 5d Web 页面和 5e 推荐器消费。
- 运维：5c 不启用 browser-worker 生产消费；browser 真实抓取勘验和 egress fail-closed 部署是后续 gate。
- 文档：更新 ROADMAP / 技术方案 / OpenSpec，记录 5c 开工决策和 browser/prod gate。
