## 新增需求

## 修改需求

### 需求:快照版本与 ETag 必须随数据变更失效

API 暴露的 `version`/ETag 必须在底层数据变更后改变，否则下游 HTTP 304 会返回陈旧价。**唯一公开 `version`/ETag 源 = 快照内容哈希**（方案①）：哈希前必须 **canonical 序列化**——既排序对象键，**也固定数组/行序**（buildSnapshot 各表 `ORDER BY id` 或 builder 内按稳定键排序；PG 无 `ORDER BY` 时按物理序返回会让无数据变化的哈希漂移）。**`mr_catalog_version`/`builtAt` 纯属内部用途、不作公开 `version`/ETag 源、不进服务表征**（避免「bump 每周期/无变化也变」与内容哈希语义冲突）——5c 不引入「bump mr_catalog_version 作公开 version」的备选路径。

**哈希内容契约（ETag = 服务表征的纯函数；防过度失效 + 防 304-with-stale）**：ETag 必须是 **API 实际返回的服务表征**的 canonical 哈希——**不得有 served-but-unhashed 或 hashed-but-unserved 字段**，唯一例外是 `version`/ETag 字段本身：响应体 `version`（若返回）**等于该内容哈希、是从 canonical 服务表征派生的传输别名，本身不进入哈希输入**（无法把含自身哈希的字段再哈希——自引用）。`builtAt` 是 builder 内部、`mr_catalog_version` 留未来/内部（5c 不读不入快照），二者**绝不出现在服务表征**（故不入哈希、不致空闲期漂移）。为同时满足「无变更稳定」与「跨阈值翻转」，**服务表征的 freshness 仅暴露离散 `stale: boolean`**（由 `last_checked IS NULL 或 < (注入 now − 阈值)` 算出；plan 级 `stale` = 其任一成分事实/源 stale 的聚合，良定义），**服务表征不暴露 raw 秒级 `last_checked`、也不暴露 plan 级聚合 date；但暴露 per-provenance 日粒度 `lastCheckedDate`**（5d-B 新增，见下「per-fact age」；raw 秒级 last_checked 仍仅 builder 内部算 staleness；provenance 仍含 `source_url`/`source_confidence`）。如此「排除 raw last_checked / now 派生连续量（ageMs）/ 构建时刻」对 hash 与 served 表征**同时成立**、无 served-vs-hash 错配。由此：① 同一注入 now、无服务表征变化 → 哈希稳定、304 命中、不过度失效；② now 推进**跨过 staleness 阈值** → `stale` 翻转 → 服务表征变 → ETag 变（客户端不会拿到 304-with-stale）；③ 仅推 raw 秒级 `last_checked`、**未跨该事实的 UTC 日界**、未翻 stale 的写不改服务表征 → ETag 可不变；若该写把 `last_checked` 推到**新 UTC 日**，则其 `lastCheckedDate` 变 → ETag 变。

**per-fact age（5d-B 新增、对既有「不暴露 lastCheckedDate」禁令的修订）**：服务表征必须为**每条事实行 provenance**（`snapshotProvenanceSchema`：plan 价格事实、models/clients/limits 事实）+ **关联源行**（`snapshotSourceSchema`）暴露一个 `lastCheckedDate`（**日粒度** ISO 日期），由 builder 在单事务 point-in-time 内从该行 `last_checked` 派生。**它是 `trunc(last_checked)` 的纯函数、完全与 `now` 无关**——`now`（build/render 时钟）推进、即便跨过任何 UTC 自然日界，**也不改变它**；仅当该事实行 `last_checked` 被**写**到新 UTC 日才变。**截断必须按固定 UTC**（`toISOString().slice(0,10)` 或 SQL `AT TIME ZONE 'UTC'`），**禁按进程/会话本地时区**——否则同一 `timestamptz` 瞬间在不同 `process.env.TZ` 进程截成不同日 → 内容哈希分叉 → 破 5d-A 跨进程免协调一致性。**`snapshotSourceSchema.lastCheckedDate` 可为 null**（`mr_source.last_checked` 按 DDL 可 NULL，从未抓源无 date）——builder 对关联源行**总补**该字段（有值则 date、NULL 则 null，**不省略**），故 schema 为 required-nullable（`z.iso.date().nullable()`）；事实 provenance（plan/limit/client/model，其 `last_checked` NOT NULL）的 date **必填非 null**。仍**不暴露 raw 秒级 `last_checked`、仍不暴露 plan 级聚合 date**（per-fact 行 date 无聚合歧义；plan 级「取哪条源 date」歧义仍有意丢弃）。「N 天前」相对文案只在 render 层算、**绝不**进 DTO/哈希。

**已拒绝的替代方案（5c 不采用）**：「bump `mr_catalog_version` 作公开 version 源」——它会带来「每周期 bump/无变化也变」的过度失效，且若在 on-read 触发则让 GET 在请求路径写 `mr_*`、违反「请求路径只读」；故 5c 唯一公开源是内容哈希，不引入该备选。hashed 内容真变经 rebuild 后 ETag 必须变化、无变更则 ETag 稳定。

rebuild **recompute** 必须**无缺口**地覆盖一切改变快照可见字段的授权写（recompute 覆盖全部路径；ETag 是否变化取决于 hashed 内容是否真变——纯幂等 no-op 允许 ETag 不变）：① **改价**——recompute 必须覆盖**两个改价入口**（公开 `recordPriceChange` **与** `upsertPlan` 经 `_recordPriceChangeTx` 的委托改价路径），且在**最外层事务提交后**触发（提交前重建会读不到未提交价），并覆盖 `recordPriceChange` 的**全部 success outcome**（appended / noop-refreshed / noop-same-tuple / history-conflict 等），不得只钩 `outcome==='appended'`；其中 appended/provenance 变会改 hashed 内容→ETag 变，而 `noop-same-tuple`（仅推 last_checked、**未跨其 UTC 日界**、未翻 stale 谓词、无其它变化）属幂等 no-op、ETag 可不变（304 仍正确）——但若该 refresh 把 last_checked 推到**新 UTC 日**，其 `lastCheckedDate` 变 → ETag 变；② **结构性录入事实变**（seed / 策展脚本 / ad-hoc `upsertPlan*`/`upsertVendor`/`upsertSource` 等）由脚本末尾触发或由③的周期 rebuild 兜（单条 ad-hoc 结构写不保证即时刷 ETag，归周期 rebuild）；③ **保鲜回路的 flag/staleness 写**（`setReviewFlag`/`markChecked`/staleness 排程改 reviewStatus/staleness）路径众多且 cron 驱动，须由**后台周期 rebuild 安全网**兜底——**周期/带外、非 on-read**，请求路径绝不触发写。**5c 范围**：交付可直接调用的 rebuild job body + builder/cache 注入 `now` + CI 测；**常驻 worker 装配（链7 = queue/schedule/worker 四件套）与跨进程失效（Redis pub/sub）随 5d 接线**（5c 无 live 消费者，常驻安全网 blast radius=0；机制就绪、装配延后，不在 5c 谎称已是运行中安全网）。实现宜把 rebuild 钩在写编排边界（包住两个改价入口）+ 后台周期安全网，而非脆弱地逐入口枚举或 on-read 触发。

#### 场景:数据变更后 ETag 变化
- **当** 某 plan 价格经授权改价入口更新后触发快照 invalidate+rebuild
- **那么** API 返回的 version/ETag 与变更前不同，下游不会拿到陈旧 304

#### 场景:授权写触发 rebuild（含 upsertPlan 委托改价）
- **当** 改价经 `recordPriceChange` 或经 `upsertPlan` 委托路径成功（任一 success outcome）
- **那么** 在最外层事务提交后必触发快照 rebuild recompute（不留「改价但未 rebuild」缺口）；ETag 仅在 hashed(=服务表征) 内容真变时变化——appended/provenance 变 → ETag 变，纯 `noop-same-tuple`（仅推 raw last_checked、未跨 UTC 日界、未翻 stale）→ 服务表征不变、ETag 可不变

#### 场景:保鲜回路 flag 写经 rebuild job body 反映
- **当** 保鲜回路给某 plan 打 pending flag（不经改价入口），随后直接调用 rebuild job body（注入 now）
- **那么** 快照 reviewStatus 反映该变化、ETag 变化（请求路径不触发任何写）；测试经直接调 job body + 注入 now 断言，无需真实等待或常驻 worker

#### 场景:staleness 阈值穿越翻转 ETag（不 304-with-stale）
- **当** 无任何 DB 写，但注入 now 推进**跨过**某 source 的 staleness 阈值（前一刻 stale=false，跨后 stale=true）
- **那么** 离散 stale 谓词翻转使 hashed 内容变、ETag 变（X→Y），客户端不会拿到 304 却附过期 stale 状态

#### 场景:不跨阈值无变更 rebuild 不漂移 ETag
- **当** 注入 now 推进但**未跨任何 staleness 阈值**、且无任何快照可见字段变化
- **那么** 内容哈希 ETag 保持不变、下游 304 仍命中（不过度失效；哈希不含构建时刻/now 派生连续量）

#### 场景:per-fact lastCheckedDate 完全 now 无关（now 跨日界亦不改哈希）
- **当** 无任何 DB 写、注入 now 推进**跨过**某事实的 UTC 自然午夜（但未跨 staleness 阈值）
- **那么** 各 provenance 的 `lastCheckedDate` **不变**（它=该行 `last_checked` 的 UTC 截断、不依赖 build/render now）、内容哈希/version **稳定**（不因日界滚动而每日过度失效；「N 天前」相对文案在 render 层另算、不进哈希）

#### 场景:事实重核到新 UTC 日改其 date 与哈希
- **当** 某事实行 `last_checked` 被**写**到新的 UTC 日期
- **那么** 该 provenance 的 `lastCheckedDate` 变为新日期、内容哈希/version 随之变

#### 场景:UTC 截断保证跨进程哈希一致
- **当** 两个 `process.env.TZ` 不同的进程（如 UTC 与 `Asia/Shanghai`）对同一 DB 状态构建快照、某 `last_checked` 落在近午夜瞬间
- **那么** 二者按固定 UTC 截断得到**同一** `lastCheckedDate` 字符串、算出**同一**内容哈希（不因进程 TZ 分叉 ETag）

### 需求:只读快照从 mr_* 子集构建并校验

系统必须提供 Model Radar 只读快照构建器，从构建所需的 `mr_*` 子集（9 张：vendors/plans/models/plan_models/plan_clients/plan_limits/source/plan_sources/review_flag，**不含 `mr_price_history`、也不含 `mr_catalog_version`**——后者在 5c 既不服务也不哈希也无写入者，公开 version 由内容哈希派生，故不读入快照；该表为 5a 所建、5c 保留不写、留未来/内部用途）读取并构建去规范化 JSON。快照必须覆盖 vendor、plan、models、clients、limits、`mr_source`、`mr_plan_sources`、provenance、staleness、review flag，并在对外返回前经过 Zod schema 校验。快照读取必须是**单事务、point-in-time 一致**（如 `REPEATABLE READ` 或显式 pg 快照），防止跨表撕裂读（构建中途有写提交导致 plan 读到却漏其刚写的 child 行）；逐行 Zod 校验不足以捕获跨表不一致。API 请求热路径禁止直接 join 规范化 `mr_*` 表作为主要读路径。

#### 场景:快照包含完整关系与 provenance
- **当** 数据库中存在一个 plan 及其模型、工具/协议、限额和待复核 flag
- **那么** 快照中同一 plan 带有这些去规范化关系、每条断言事实的 `source_url`/`source_confidence` + per-provenance 日粒度 `lastCheckedDate`（关联源行 date 可 null）provenance、离散 freshness（仅 `stale`；raw 秒级 `last_checked` 仅 builder 内部用于算 staleness、不入服务表征），以及 pending review 状态

#### 场景:快照单事务一致读不撕裂
- **当** 在快照构建过程中有并发写提交（如新增某 plan 的 limit 行）
- **那么** 构建器在单事务 point-in-time 视图下读取，结果要么完全包含该写、要么完全不含，不出现「读到 plan 却漏其 child」的撕裂态

#### 场景:快照 schema 校验失败不对外服务且不覆盖旧快照
- **当** 快照构建结果缺失必需 provenance 字段或出现非法枚举值
- **那么** 构建器必须报错、不缓存坏快照、不覆盖既有可用快照；冷启动首建即失败时 API 返回 503 且不写缓存，绝不返回坏快照

## 移除需求
