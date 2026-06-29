## 上下文

Model Radar 5a/5b 已经建立 `mr_*` bounded domain、结构化录入、价格改价入口、抓取变更检测与待复核/陈旧度闭环。5c 是读路径的第一步：把规范化 SOT 转成一个小型、去规范化的只读快照，并提供后续 5d 页面与 5e 推荐器可复用的确定性过滤/排序 API。

当前需要先补的数据红线是：5b seed 为了结构覆盖而大量使用 `needs_login_recheck` 占位；这合法，但 5c 的“同档谁最划算”不能把未知价格当成 0、估算价或可比较价。MiMo 等非主桶条目若 source_url 未核实，也必须保持 manual/占位，不能冒充官方 provenance。

## 目标 / 非目标

**目标：**

- 从构建所需的 `mr_*` 子集（9 张，不含 `mr_price_history` 与 `mr_catalog_version`）构建只读快照，快照包含公开 API 所需的去规范化关系、provenance、陈旧状态与待复核状态。
- 提供 Hono 只读 API，基于快照执行 model/tool/protocol/budget/category 过滤与同桶排序。
- 完成桶2 Coding Plan 的数据策展入口与测试红线：已核官方价格才能录入，未知价格保留 NULL 占位并显式标注不可比。
- 记录阶段 gate：5c 可开发 API；真实 browser 抓取勘验和 browser-worker egress 封锁是 browser/prod 启用 gate。

**非目标：**

- 不做 Web 比价页 UI、推荐器、LLM 解释或 MCP 推荐工具。
- 不引入新的事实来源自动写入路径；抓取和 LLM 仍不得修改价格/额度/兼容事实。
- 不新增跨桶统一性价比归一化算法；比较排序仅在同一 `category` 内有意义。
- 不在 5c 强行启用 browser-worker 生产消费；未通过 egress fail-closed 自检前不能跑 browser job。

## 决策

### D1. 快照是读路径 SOT，规范化表只在重建时读取（含 source/定位边）

5c 新增 `src/mr/snapshot/*`：读取构建快照所需的 `mr_*` 表——`mr_vendors`、`mr_plans`、`mr_models`、`mr_plan_models`、`mr_plan_clients`、`mr_plan_limits`、`mr_source`、`mr_plan_sources`、`mr_review_flag`（共 9 张），构建一个 Zod 校验的 `ModelRadarSnapshot`。**`mr_price_history` 不入快照**（比价读路径只需 `mr_plans.current_price` 当前价；历史图表是 v2，届时单独读）。**`mr_catalog_version` 也不入快照**：5c 公开 version 由内容哈希派生（见 D8），该表在 5c 既不服务也不哈希也无写入者，故无需读入——它是 5a 所建、5c 保留不写、留未来/内部用途（非死表漏接线，是有意决定；schema.ts 原注释「5c bump/latest」应随之 reconcile）。API 只读快照，不在请求热路径 join 规范化表。

`mr_source`/`mr_plan_sources` 必须入快照输入：5b 保鲜回路会给 `target_type='source'`/`'vendor'` 打 flag、并按源 `last_checked` 计陈旧；若快照只读 plan 级 flag，则关联源已待复核的 plan 会被显示为干净。故每个 plan 的 `reviewStatus`/`staleness` 聚合 ① 直接 plan flag ② vendor flag ③ 经 `mr_plan_sources` 关联的 `mr_source` flag 与源 `last_checked` ④ plan 自身及其 child 事实行（`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`）的 `last_checked`（与 task 2.3、既有 staleness 排程同口径）。陈旧判定必须与既有排程同口径：**`last_checked IS NULL 或 < 阈值` 即陈旧**——NULL=从未核对=最该复核，独立于排程是否已物化 flag。**NULL 分支仅对 `mr_source.last_checked` 可达**（按 DDL 仅它 nullable；plan/limits/clients/models.last_checked 均 `NOT NULL`，只走「< 阈值」）；从未抓的 browser 源（`last_checked NULL`/`content_fingerprint NULL`）必须判陈旧，不因 `now - NULL` 被误判新鲜。

替代方案：每次 API 请求直接 join `mr_*`。拒绝原因：数据集虽小但会把后续 5d/5e 热路径绑到 DB，并重复实现 join/陈旧计算；快照更符合读多写少、小数据集的设计。

### D2. 5c 先实现进程内快照，Redis/CDN 写出留扩展口；但版本/失效不省

实现上提供 `buildSnapshot(db, now)` 与 `getSnapshot()` 抽象；首版可冷启动从 DB 构建并进程内缓存，写路径或 seed 后可手动/脚本触发重建。Redis key / pub-sub / CDN/R2 属后续扩展，但 DTO 结构和 builder 不应绑定内存实现。

`buildSnapshot` 必须在**单事务、point-in-time 一致**视图（`REPEATABLE READ` + `accessMode: 'read only'`、且禁用 `FOR UPDATE`/`FOR SHARE` 行锁）内读完上述 9 张构建所需表：跨多表多语句读时，构建中途有写提交会产生跨表撕裂（plan 读到却漏其刚写的 limit/client），而逐行 Zod 校验捕获不到「每行单独合法但跨表不一致」。单写者只防写写竞争、不防撕裂读，故不以「单写者足够」作为一致性理由。只读纯 SELECT 取 `ACCESS SHARE`，与改价的 `ROW EXCLUSIVE`/`FOR UPDATE` 在 PG MVCC 下互不阻塞、无死锁（前提即「快照读不用行锁」）。

版本/失效不能省：见 D8。冷启动 DB 重建只能作为 fallback，不替代 rebuild 时的版本化刷新。

替代方案：一次性上 Redis + pub/sub + CDN。拒绝原因：5c 的核心风险在数据语义与 API 合约，不在高并发；当前一个 JSON blob 足够，先留接口不引入部署复杂度。

### D3. API 用确定性查询参数 + Zod 闸，返回可解释排序元数据

新增路由建议：

- `GET /model-radar/snapshot`：返回完整快照（或后续 5d 页面使用的公开子集）。
- `GET /model-radar/plans`：参数 `category`、`model`（`family:version` 冒号必填）、`tool`、`protocol`、`currency`（可选 ISO 4217，限定币种、排除 currency=NULL 未知价）、`maxMonthlyPrice`（必带 currency）、`requiresKnownPrice`（单一 boolean，不设反向布尔）等经 Zod 校验后在快照中过滤。

响应中的每个 plan 必须带：`priceStatus`、`provenance`、`staleness`、`reviewStatus`；排序响应必须带 `sortScope={category, currency}`（全未知价组 currency 可为 `null`）与不可比标记（`cheapest`/`comparable`/`unknownCount`），让调用方知道排序是否可解释。

替代方案：自由文本搜索或 LLM 查询。拒绝原因：5c 是确定性比价 API，规则筛选负责“不离谱”，LLM 解释留 5e。

### D4. 未知价格不可参与“最便宜”结论（known 须同时满足已核 provenance + 同币种）

`priceStatus='known'` 当且仅当：`current_price` 非 NULL、`currency` 非 NULL、且 `source_confidence ∈ {official_pricing, official_doc}`。任一不满足判 `priceStatus='unknown'`。**关键修正**：现有写闸把 confidence 与 price 解耦（`recordPriceChange` 允许 `needs_login_recheck`/`media_report` 配非空价；且 `upsertPlan` 新建分支直写价只过 `mrPlanWriteSchema`，仅校验 price↔currency 同生同灭、不校验 confidence↔price），若 known 只看 NULL，则未核价会冒充已核价进入 cheapest，正中本变更要堵的红线——故 known 必须叠加「provenance 属已核官方集合」。该绑定的录入侧落点必须是**共享 `mrPlanWriteSchema`/`mrPlanWriteValidator`**（在 `upsertPlan` 顶部对新建 INSERT 与改价委托两路都解析）+ `recordPriceChange` 的 confidence-must-be-official 断言，**不能只落 `recordPriceChange`**（否则 `upsertPlan` 新建非空价绕过），方为真不变量、读侧 known 才有真支撑（双层兜）。

排序只在**同一 category 且同一 currency** 内做；不做汇率换算（D5b）。同桶同币种价格升序时已知价格排在未知前；`requiresKnownPrice=true` / 带 `maxMonthlyPrice`（必带 currency）/ 带 `currency` 过滤时未知价格（currency=NULL）被排除。全 unknown 时返回 `cheapest=null` + 具名标记（`comparable=false`/`unknownCount`），不得用自由文本表达。API 不得把 NULL 当 0/估算价。

替代方案：把未知价格估算为 0/Infinity 或用人工备注参与排序。拒绝原因：价格是精确事实，估算会破坏 Model Radar 红线。

### D4b. 不做汇率换算，按 (category, currency) 分组比较

`maxMonthlyPrice` 必须显式带 currency；排序 scope 至少是 `category + currency`。混币（20 EUR vs 40 CNY）禁止当同单位比较：要么按 (category, currency) 分组返回，要么请求未带 currency 时不输出跨币种 cheapest。本期不引入 FX。

替代方案：硬编码汇率归一。拒绝原因：汇率波动 + 引入外部事实源，超出 5c 范围且会让“最便宜”变成不可溯源的估算。

### D5. 桶2数据策展走录入/改价入口，不在 seed 中臆造

百炼 / 千帆 / 腾讯 / 火山 / 讯飞数据：厂商、plan、模型、工具/协议和限额可以用 `upsert*` 结构化录入；真实价格必须通过 `recordPriceChange` 或等价授权入口写入，且附官方 `source_url`/`source_confidence`。无法核实的条目继续 NULL + `needs_login_recheck`，由 API 标注不可比。

替代方案：为了能排序先填市场传闻价或占位价。拒绝原因：比没有数据更糟，会输出错误推荐。

### D6. MiMo provenance 作为数据卫生，不阻塞 5c 主桶

MiMo 属 Token Plan 桶，不是 5c 主桶。若 `source_url` 未核实，保持 `fetch_strategy='manual'` 与 `source_confidence='needs_login_recheck'`，或从 seed 暂缓；不得把未核实 URL 作为 `official_pricing`/`official_doc` 的依据。该卫生约束通过 seed fixture 测试覆盖，但不阻塞桶2 API 开发。

### D7. browser/prod gate 记录到文档，不作为 5c apply blocker；本期桶2 源登记为 manual

5c 只要求 browser 档代码继续 fail-closed，不要求真实 Chromium 与 egress 已在部署环境跑通。后续启用 browser-worker 生产消费前必须完成：真实定价页勘验、netns/代理封 RFC1918 + metadata、启动自检 fail-closed 通过。文档必须明确“未配妥时不消费 browser job”。

allowlist 与 tier 取舍（修正上一版「一律 manual」的过度降级——那与 tech-plan 已锁「三档全上、GLM 走 browser 不降级」冲突）：源 `fetch_strategy` 按页面**真实性质**登记（GLM JS 渲染页=`browser`，结构化文档页=`http`，登录墙后值/页漂移=`manual`）。既有 `MR_SOURCE_DOMAIN_ALLOWLIST` 含 `baidu.com`/`tencent.com`/`alibabacloud.com`（阿里云/DashScope 国际域，即百炼母体）等，但火山(`volcengine.com`)/讯飞(`xfyun.cn`) 及百炼若用 `aliyun.com` 国内域不在其中，`upsertSource → assertUrlAllowed` 会拒 http/browser 源（manual 豁免）。故为 http/browser 桶2源**扩 `MR_SOURCE_DOMAIN_ALLOWLIST`** 使录入闸放行（单独任务）。**5c 的 gate = 不启用 browser-worker 生产消费、本期不实际抓取任何源**（egress fail-closed 由 `browser-worker-main.ts` 强制），登记真实 tier 是 forward-correct、不等于开抓。

### D8. version/ETag 必须随数据变更失效

若 API 以一个永不变的 version 作 ETag，数据策展/改价后 ETag 不变 → 下游 HTTP 304 返回陈旧价。**5c 唯一公开 version/ETag 源 = 内容哈希**：ETag 由快照内容 **canonical 序列化**后哈希派生，canonical 必须**既排序对象键、也固定数组/行序**（buildSnapshot 各表 `ORDER BY id` 或 builder 内稳定键排序；PG 无 `ORDER BY` 返回物理序会使无数据变化的哈希漂移）。内容哈希下无数据变更则哈希稳定、304 命中、不过度失效。**已拒绝的替代方案（5c 不采用）**：「bump `mr_catalog_version` 作公开 version 源」——会带来每周期/无变化也 bump 的过度失效，且若 on-read 触发则 GET 在请求路径写 `mr_*` 违反只读；故 5c 不引入该备选，`mr_catalog_version` 保留不写（见 D1）。

**rebuild 触发契约必须无缺口**（否则「改价但没人 rebuild」→ ETag 旧、下游 304 陈旧，正是本变更要堵的红线；当前无消费者 blast radius=0，5d 接入即真实暴露）：
- **改价**必须覆盖两个入口——公开 `recordPriceChange` **与** `upsertPlan` 经 `_recordPriceChangeTx` 的委托改价路径（只钩公开入口会漏 `upsertPlan` 委托改价），且在**最外层事务提交后**触发（提交前重建读不到未提交价），并覆盖 `recordPriceChange` 的**全部 success outcome**（appended / noop-refreshed / noop-same-tuple / history-conflict——`noop-refreshed` 改 provenance、`history-conflict` 加 review flag、`noop-same-tuple` 仅推 raw last_checked，均触发 recompute；ETag 是否变取决于服务表征是否真变），不得只钩 `appended`。实现宜把 rebuild 钩在写编排边界（包住两改价入口），而非脆弱逐入口枚举。
- **结构性录入事实写**（seed/策展脚本、ad-hoc `upsertPlan*`/`upsertVendor`/`upsertSource`）由脚本末尾触发或由下条周期 rebuild 兜——单条 ad-hoc 结构写不保证即时刷 ETag（归周期 rebuild）。
- **保鲜回路写**（`setReviewFlag`/`markChecked`/staleness 排程改 reviewStatus/staleness）路径众多且 cron 驱动，须由**后台周期 rebuild 安全网**兜底——**周期/带外、非 on-read**，**请求路径绝不触发写**。
- **5c 范围 vs 5d 装配（避免「CI 绿/生产死」）**：5c 交付**可直接调用的 rebuild job body** + builder/cache 注入 `now` + CI 测；**常驻 worker 装配（链7 = `create*Queue`/`schedule*`/`create*Worker` 四件套 + env 闸默认 off，仿既有 mr 链5/链6）与跨进程失效（Redis pub/sub）随 5d 接线**（5c 无 live 消费者，常驻安全网 blast radius=0）。机制就绪、装配延后——不在 5c 谎称已是运行中安全网（与上轮删 runbook 同一诚实标准，只是这条是「机制 vs 装配」边界而非逃生口）。价改耦合 rebuild 经调用方（seed/策展脚本/API 进程）触发，不需常驻 worker。
- 删除「runbook 口头步骤」逃生口（非 CI 可断言）。须有测试断言：改价（含 upsertPlan 委托）后 ETag 变化、「改价后未 rebuild」不被当作已更新、保鲜回路 flag 写经直接调 rebuild job body（注入 now）后 reviewStatus 反映、staleness 阈值穿越翻转 ETag、不跨阈值无变更 rebuild 后 ETag 稳定。

**ETag 哈希内容契约**（T1/U1）：ETag = **API 实际服务表征**的 canonical 哈希——不得有 served-but-unhashed / hashed-but-unserved 字段。唯一例外是 `version`/ETag 字段本身：响应体 `version`（若返回）== 该内容哈希、是从 canonical 服务表征派生的**传输别名、不入哈希输入**（否则自引用）；`builtAt` 是 builder 内部、`mr_catalog_version` 留未来/内部（5c 不读不入快照），二者**绝不出现在服务表征**。服务表征 freshness **仅暴露离散 `stale: boolean`**（注入 now 算；plan 级 = 任一成分 stale 的聚合，良定义），**不暴露 raw 秒级 `last_checked`、也不暴露 `lastCheckedDate`**（raw last_checked 仅 builder 内部算 staleness）。故「排除构建时刻 / now 派生连续量（ageMs）/ raw last_checked」对 hash 与 served 同时成立、无错配。如此「同一 now 无变更→哈希稳定」（不过度失效）与「跨阈值→stale 翻转→ETag 变」（不 304-with-stale）同时成立；`noop-same-tuple` 仅推 raw last_checked 未翻 stale → 服务表征不变、ETag 可不变。

**已知限制（5c 不解决，注明以免误以为已处理）**：
- 现无授权路径把已核价格降级回 NULL 占位——`upsertPlan` 价改 NULL 报冲突、`recordPriceChange` 的 `newValue` 类型恒非空；故源漂移到登录墙后时，「价格事实从已核回退为占位」无写入路径（属 5a/5b 既有缺口，本期仅经待复核标暴露，不在 5c 范围）。
- **per-fact age 徽标（tech-plan「🟡N天前」）延后 5d**：5c 服务表征只暴露离散 `stale`（🟢/🔴），不暴露连续 age（删 `lastCheckedDate` 是为消除 plan 级多源聚合取值歧义 + 守 ETag 内容哈希稳定）。5d 需「N天前」时，由 builder **已读的 per-fact last_checked 按 per-fact 行重暴露**（per-fact 无聚合歧义），plan 级聚合 date 有意丢弃。此为显式 5d 延后、非永久丢失。

替代方案：不暴露 ETag/缓存头。拒绝原因：5d/HTTP 缓存会自发缓存，无失效信号必致陈旧；显式版本化成本低。

## 风险 / 权衡

- **桶2真实价格短期几乎为零**（多数在登录墙后/页面已漂移，browser 勘验为前置且后置 gate）→ 现实结果可能是 0 个已核价，cheapest 路径主要走「全 unknown 不可比」。tasks 必须明确「0 已核价即可验收、禁臆造」，排序测试用合成 fixture 而非 seed 真价。
- **快照读一致性** → `buildSnapshot` 单事务 REPEATABLE READ point-in-time 读，防跨表撕裂；不以「单写者足够」作理由。并发写中途提交不产生撕裂快照（有测试）。
- **缓存陈旧** → version/ETag 随数据变更失效（D8）；坏快照 fail-closed 不覆盖旧快照、冷启动首建失败返回 503。
- **同桶排序被跨桶/跨币误用** → 排序 scope = (category, currency)；未指定单一 category 时禁止全局 price rank，只返回分桶 groups；混币不当同单位比。
- **未核 provenance 冒充已核价** → 双层兜：① 读路径 `known` 须 provenance 属官方集合；② 录入路径 price-specific 校验器拒「非官方 confidence + 非空价」。fixture 与测试钉死 `needs_login_recheck` 时价格为空。
- **同档家族折叠延后** → ROADMAP 5c 列出但本期价格未核、折叠无数据可依，显式延后（非目标），避免占位数据上做无意义折叠。
