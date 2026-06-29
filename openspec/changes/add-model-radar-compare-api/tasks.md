## 1. 数据红线与文档决策

- [x] 1.1 更新 ROADMAP / docs/model-radar-tech-plan.md：记录 5c 已开、未知价格排序红线（known 须官方 provenance + 同币种）、同档家族折叠本期延后、browser 真实勘验与 egress 封锁作为 browser/prod gate、ETag=内容哈希唯一公开 version 源、服务表征 freshness 仅离散 stale（tech-plan「🟡N天前」per-fact age 徽标延后 5d、由 per-fact last_checked 重暴露）；**reconcile `mr_catalog_version` 前向引用注释**：`src/db/schema.ts`（原「5c bump/latest 用」）+ `src/mr/ingest/seed.ts:14`（原「留 5c」）→ 统一改「5c 公开 version=内容哈希；该表 5c 不写不读不服务、留未来/内部，非漏接线」，消除 5b→「留 5c」→5c→「留未来」的悬空前向引用
- [x] 1.2 **核验**（verify-only）seed fixture：MiMo 已是 `manual` + `needs_login_recheck`（seed-data.ts），确认无假官方来源即可；如桶2 新增「腾讯」coding_plan vendor，须与既有 CodeBuddy（腾讯，ide_membership）用**不同 normalizedName**（区分产品，避免 vendor 去重键歧义）
- [x] 1.3 为 seed 数据红线补测试：`needs_login_recheck` 价格必须 NULL；未核实 provenance 不得标成 `official_pricing`/`official_doc`
- [x] 1.4 桶2 Coding Plan 结构性录入（百炼/千帆/腾讯/火山/讯飞）：逐家录 vendor + coding_plan plan + source + model/client/limit + 各自 provenance；**本期允许 0 个已核价**，未知价保持 NULL 占位，**禁填传闻/占位价凑数**；源 `fetch_strategy` 按页面真实性质设（JS 渲染=browser、文档页=http、登录墙/漂移=manual，不一律降 manual）；本期不实际抓取（browser/prod gate 未过）
- [x] 1.4b 为 http/browser 桶2源域名扩 `MR_SOURCE_DOMAIN_ALLOWLIST`（火山 volcengine.com / 讯飞 xfyun.cn / 百炼如用 aliyun.com 等），使 `upsertSource` 录入闸放行；manual 源豁免不需扩。**必须先于 1.4 录入对应 http/browser 源**（`upsertSource` 录入即调 `assertUrlAllowed`，次序颠倒会抛 SsrfBlockedError；allowlist.drift.test 机械守护覆盖）
- [x] 1.5 已核桶2价格才经授权改价入口写入并覆盖往返测试；无法核实者断言不写 `mr_price_history`、保持 NULL + needs_login_recheck；结构性录入完成即算 1.4/1.5 验收，不因缺价判失败
- [x] 1.6 confidence↔price 绑定落进**共享 `mrPlanWriteSchema`/`mrPlanWriteValidator`**（`upsertPlan` 新建 INSERT + 改价委托两路都过）+ `recordPriceChange` confidence-must-be-official 断言：非官方 confidence（needs_login_recheck/media_report/official_community）禁带非 NULL 价，发 SQL 前拒 + 负例测试（含 `upsertPlan` 新建分支负例）

## 2. 快照 DTO 与构建器

- [x] 2.1 定义 `ModelRadarSnapshot` / `SnapshotPlan` / query response Zod schema，含 priceStatus（known 须官方 provenance+同币种）/provenance（source_url/source_confidence）/freshness **仅离散 `stale`**（**服务表征不含 raw 秒级 last_checked、不含 lastCheckedDate**）/reviewStatus/sort metadata；ETag = 服务表征纯函数（无 served-but-unhashed/hashed-but-unserved，`version` 是内容哈希传输别名、不入哈希输入；`mr_catalog_version`/`builtAt` 不入服务表征）
- [x] 2.2 实现 `buildModelRadarSnapshot(db, now)`：**单事务 `REPEATABLE READ` + `accessMode:'read only'`、禁 FOR UPDATE/SHARE** 读构建所需 9 张 `mr_*`（含 `mr_source`/`mr_plan_sources`，**不含 `mr_price_history`、也不含 `mr_catalog_version`**——公开 version 由内容哈希派生、该表 5c 不读不写不服务）并去规范化 vendor/plan/models/clients/limits/sources/review flags；各表 `ORDER BY id`（固定数组/行序，使内容哈希 canonical）
- [x] 2.3 实现陈旧/待复核聚合：plan 自身 + child 事实行（limits/clients/models）last_checked + vendor flag + 经 `mr_plan_sources` 关联的 source flag/源 last_checked；陈旧判定与既有排程同口径（**`last_checked IS NULL 或 < 阈值` 即陈旧**，NULL 不漏）；任一 pending/陈旧 → plan 暴露待复核
- [x] 2.4 实现快照 schema 校验失败 fail-closed：不缓存坏快照、不覆盖旧快照；冷启动首建失败返回 503
- [x] 2.5 添加快照构建集成测试：完整关系、provenance、source/vendor flag 传导、child 行 + 从未抓 browser 源（last_checked NULL）判陈旧、unknown price 无损读回；并发写中途提交不产生撕裂快照

## 3. 过滤与排序服务

- [x] 3.1 实现查询参数 Zod schema：category/model（`family:version` 冒号必填、空版本 `family:` 哨兵匹配、裸 family→400）/tool/protocol（clientId 精确大小写敏感匹配）/maxMonthlyPrice（必带 currency）/`currency`（可选 ISO 4217 枚举，限定结果币种；与 maxMonthlyPrice 同传须 currency 一致否则 400）/**单一** `requiresKnownPrice`（不设反向 includeUnknownPrice）；accepted 参数集与 spec 列表一致（含 `currency`，避免未知参数 400）
- [x] 3.2 实现快照内过滤：模型版本、工具、协议、预算、category 组合条件均为确定性 AND 过滤
- [x] 3.3 实现同桶同币种价格排序：known（价/币非 NULL + 官方 provenance）升序、unknown 排后；预算过滤/known-only 排除 unknown；不做 FX
- [x] 3.4 实现跨桶/跨币检索分组：未限定单一 (category, currency) 时禁止全局 price rank，返回分组与 `sortScope={category,currency}`（全未知价组 currency=null）；全 unknown 返回 `cheapest=null` + 具名标记（comparable=false/unknownCount）
- [x] 3.5 添加过滤排序单测（用合成 in-memory 快照 fixture，非 seed 真价）：非官方 confidence 带价不成 cheapest、未知排已知后、混币不同单位比、全 unknown（currency=null 组）不可比、非法 query/model 语法（含裸 family）被拒、currency×maxMonthlyPrice 币种不一致→400、currency 过滤排除 currency=NULL 未知价 plan

## 4. Hono API 接线

- [x] 4.1 新增 Model Radar 路由模块并挂载到 `src/app.ts`，保留 `/health` 行为不变；请求路径只读、不写任何 mr_*/既有表
- [x] 4.2 实现 `GET /model-radar/snapshot` 返回快照公开子集和 version/ETag（**version/ETag 唯一来源 = 内容哈希**；5c 不实现 catalog-version bump 路径）
- [x] 4.3 实现 `GET /model-radar/plans` 调用过滤排序服务，错误参数返回 400
- [x] 4.4 添加 API 测试：按 model+tool 返回合格 plan、非法参数 400（含裸 family）、跨桶结果无全局 rank（带 sortScope={category,currency}）、全 unknown 组 currency=null、只读不写库；含一条 official_pricing 已核价 fixture 断言 HTTP 响应 cheapest/priceStatus=known 端到端透传

## 5. 快照缓存与版本

- [x] 5.1 实现进程内快照缓存接口：冷启动构建、手动 invalidate/rebuild、保留后续 Redis/CDN 写出扩展口
- [x] 5.2 version/ETag 失效闭合：**唯一公开 version/ETag 源 = 内容哈希**（canonical：对象键排序 + 数组/行序固定，见 2.2 ORDER BY）；**哈希内容 = 语义字段 + staleness 离散谓词（`stale` bool，由注入 now 算），排除构建时刻/now 派生连续量/原始 last_checked 连续值；`version` 是该哈希的传输别名、不入哈希输入**；无变更则哈希稳定保 304；**`mr_catalog_version`/`builtAt` 纯内部、不作公开 version 源、不进服务表征**（5c 不引入「bump mr_catalog_version 作公开 version」备选；GET 不得写库）
- [x] 5.3 授权写耦合 rebuild（**无 runbook 逃生口**）：钩在写编排边界覆盖两个改价入口（公开 `recordPriceChange` + `upsertPlan` 委托路径）、最外层事务提交后触发、recompute 覆盖全部 success outcome（非仅 appended；ETag 变 iff hashed 内容变，纯 noop-same-tuple 可不变）；seed/策展脚本末尾触发
- [x] 5.3b rebuild job body（**5c 范围**）：交付**可直接调用的 rebuild job body** + builder/cache 注入 now；**常驻 worker 装配（链7 四件套 + `MR_SNAPSHOT_REBUILD_ENABLED`/间隔 env，仿既有 mr 链）与跨进程 Redis pub/sub 失效显式延后 5d**（5c 无 live 消费者，机制就绪、装配延后，不谎称运行中安全网）；若 5d 装配，env 命名宜对齐既有 `MR_*_CRON`+`_CRON_TZ` 约定或注明刻意用 `every:ms`
- [x] 5.4 添加缓存测试：坏快照不覆盖旧快照；invalidate+rebuild 后数据可见且 ETag 变化；改价（含 upsertPlan 委托）后 ETag 变化、「改价后未 rebuild」不被当作已更新；**保鲜回路 flag 写 → 直接调 rebuild job body（注入 now）→ reviewStatus 反映 + ETag 变**；**staleness 阈值穿越（注入 now 跨阈值、无 DB 写）→ ETag 变（不 304-with-stale）**；**注入 now 推进但不跨阈值 + 无变更 → ETag 稳定（304 命中）**；请求路径只读不写库

## 6. 验证

- [x] 6.1 运行 `openspec-cn validate add-model-radar-compare-api --strict`（或本仓等价 OpenSpec 校验命令）
- [x] 6.2 运行相关 vitest：`src/mr/ingest`、新 `src/mr/snapshot`、新 `src/mr/api` 测试
- [x] 6.3 运行 `npx tsc --noEmit` 与 `npm run lint`
- [x] 6.4 如需真实 DB，运行 `npm run migrate` 后执行 Model Radar 集成测试并记录结果
