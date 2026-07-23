# platform-foundation 规范

## 目的
待定 - 由归档变更 bootstrap-walking-skeleton 创建。归档后请更新目的。
## 需求
### 需求:容器化基础设施可编排
系统必须提供一份 `docker-compose.yml`，通过单条 `docker compose up` 启动 PostgreSQL 与 Redis 两项基础设施。PostgreSQL 必须使用 `pgvector/pgvector` 镜像，以便引入向量检索时无需更换镜像；**P3 起按需启用 `vector` 扩展与向量列**（仅 `ai_news_events` / `kb_documents`，见「P3 向量与知识库 Schema 可迁移」需求），P3 之前的期次不建 vector 列。Redis 必须可被应用连通（供 BullMQ 使用）。

#### 场景:一键启动基础设施
- **当** 在仓库根目录执行 `docker compose up`
- **那么** PostgreSQL 与 Redis 容器均成功启动并进入健康状态

#### 场景:PostgreSQL 使用 pgvector 镜像且 P3 起启用向量能力
- **当** 检视 `docker-compose.yml` 的 postgres 服务镜像与 P3 migration
- **那么** 镜像为 `pgvector/pgvector`，且 P3 migration 含 `CREATE EXTENSION vector` 与 `ai_news_events.embedding` 向量列（P3 之前的 migration 不含 vector 列）

### 需求:P3 向量与知识库 Schema 可迁移

系统必须以 forward-only 迁移（追加新迁移序号、不重写既有迁移）落 P3 语义去重与知识库所需的 schema，且 `drizzle-kit migrate` 可重复执行幂等：

- `CREATE EXTENSION IF NOT EXISTS vector;`（pgvector 扩展，镜像已是 `pgvector/pgvector` 无需换镜像）；
- `ai_news_events` 新增 `embedding vector(1536)`（可空）列，承载事件 embedding（维度由所选默认模型 `text-embedding-3-small` 定，钉死 1536，换不同维度模型属新迁移）；
- `ai_news_events` 新增 `merged_into varchar(128)`（可空）列，承载语义合并 tombstone 指针（指向存活事件 `event_id`，见 semantic-dedup「确定性事件合并」与 dedup-and-normalization「tombstone 改投」）；
- 新建 `kb_documents` 表（本地表知识库，含 `embedding vector(1536)` 供未来检索，见 knowledge-base「本地表知识库存储」）；
- 新建 `kb_ingestion_records` 表（QA.md §8.7）并建 `UNIQUE(target_type, target_id, kb_provider)`（见 knowledge-base「知识库入库幂等」）。

向量能力本期仅及于 `ai_news_events` 与 `kb_documents`，不及于 `ai_products`（产品语义合并不在本期范围）。迁移禁止 drop 既有上线数据表重建。

#### 场景:P3 迁移启用 vector 扩展与向量列
- **当** 对已落 P2 schema 的数据库执行 P3 新增迁移
- **那么** 存在 `vector` 扩展、`ai_news_events` 含 `embedding vector(1536)` 与 `merged_into varchar(128)` 列，存在 `kb_documents` 与 `kb_ingestion_records` 表（后者含 `UNIQUE(target_type, target_id, kb_provider)`）

#### 场景:P3 迁移 forward-only 且幂等
- **当** 在已迁移数据库上再次执行 `drizzle-kit migrate`
- **那么** 既有迁移不被重写、新增迁移被跳过、表结构无变化、不报错

### 需求:数据库 Schema 可迁移

系统必须用 Drizzle 定义并通过 `drizzle-kit migrate` 落库核心表 `raw_items`、`ai_news_events`、`push_records`。三张表的列必须对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL（不得只建主键与唯一约束的空壳表）。`drizzle-kit migrate` 必须可重复执行：已应用的迁移被跳过、命令成功返回、数据库结构无变化（迁移 journal 级幂等）。本期（P2）在 P1 三表基础上**解禁并新建 `ai_products` 表**（产品发现所需，见「ai_products 产品表可迁移」需求）。**P3 起新增 `kb_ingestion_records` 与 `kb_documents` 两张知识库表（见 knowledge-base capability），并为 `ai_news_events` 增 `embedding` 与 `merged_into` 列（见「P3 向量与知识库 Schema 可迁移」需求）**；**本变更（AI 博主经验提炼）起新增 `ai_experiences` 表（经验卡片所需，见 blogger-experience-mining）**；仍禁止定义 `item_event_relations` / `item_product_relations` / `ai_tools` / `task_patterns`（事件-产品关系表 P3 改用 `ai_news_events.merged_into` tombstone 替代、不建关系表；工具/任务模式表留待 P5 顾问期提案再加）。

schema 必须包含以下列与约束（P1 已落库，P2 沿用、不得回退）：

- `ai_news_events.event_id` 必须为不透明 surrogate key，其值不得由内容（如 `canonical_url` 哈希）派生——以保证 P3 语义合并时事件身份稳定、历史引用（`push_records.target_id` 等）不需迁移。为与 `push_records.target_id`（`VARCHAR(128)`）保持类型一致以便 `target_id=event_id` 互引，`event_id` 必须保留 `VARCHAR(128)` 列类型，并设数据库默认值 `gen_random_uuid()::text`——使塌缩 `INSERT` 省略 `event_id` 时由数据库生成 UUID 文本，禁止由应用层用内容派生值填充。
- `ai_news_events` 必须新增 `dedup_key` 列并建 `UNIQUE(dedup_key)`，作为硬去重塌缩的冲突键（`INSERT ... ON CONFLICT (dedup_key) DO UPDATE`）。
- `ai_news_events` 必须新增 `representative_raw_item_id` 列，记录塌缩时第一条命中的 `raw_item` 主键。
- `ai_news_events` 必须新增 `published_at` 列（可空），承载代表 `raw_item` 的发布时间，供 Top N 排序 tiebreaker 使用——`ai_news_events` 此前无 `published_at` 列（仅 `first_seen_at` / `last_seen_at`），不补则排序字段不存在。
- `raw_items` 必须新增 `title_hash` 列，承载标题归一化哈希。
- `raw_items` 必须新增 `unprocessable` 标记列（`BOOLEAN NOT NULL DEFAULT false`），承载「既无可用 `canonical_url` 又归一后标题为空」的兜底状态——P0 `raw_items` 无任何状态列，不补则该兜底需求无落点。
- `raw_items` 必须含 `collapsed` 标记列（`BOOLEAN NOT NULL DEFAULT false`，P1 已落库，本期沿用并扩展语义）：对新闻类行表示「已塌缩进 `ai_news_events`」；P2 扩展为对 `raw_type='product'` 行表示「已塌缩进 `ai_products`」、对 `raw_type='paper'` 行表示「已沉淀/已路由」（入库即置 `true`）；本变更扩展为对 `raw_type='experience'` 行表示「已沉淀、由经验链消费」（入库即置 `true`）。dedup 类型路由与产品/经验塌缩均依赖此列的 `collapsed=false` 过滤避免每轮无界重扫（见 dedup-and-normalization、product-discovery 与 blogger-experience-mining）——spec 显式声明此列存在，使据 spec 重建 schema 不漏列。
- `raw_items.canonical_url` 由 P0 的「建好但不生成其值」转为本期必须真正生成并写入（采集/规范化阶段填值）。
- `ai_news_events` 必须保留 P0 的 `importance_score` / `novelty_score` / `developer_relevance_score` / `hype_risk_score` / `should_push` / `summary_zh` / `first_seen_at` / `last_seen_at` / `source_count` 等列；`raw_items` 必须保留 `UNIQUE(source, source_item_id)`。

P2 必须为 `ai_news_events` 新增 `judge_claimed_at TIMESTAMPTZ`（可空）列：承载 Value Judge 评分前的原子 claim（日报链与实时告警高频链并发评分时，只有 `UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING` claim 成功者送 LLM，防双评分覆写，见 daily-intel-pipeline「降级逐条容错」为权威定义）；含超时回收项（`OR judge_claimed_at < now()-T`，`T > L + W`）使 claim 后崩溃的事件可被后续运行重新 claim，该列与「僵尸 claim 回收」语义配套。

**本变更（AI 博主经验提炼）新增 `ai_experiences` 表**（forward-only，承载经验卡片）：主键 `id VARCHAR(128) PRIMARY KEY DEFAULT gen_random_uuid()::text`（不透明 surrogate，与 `event_id`/`product_id` 同口径，使 `push_records.target_id = ai_experiences.id` 互引类型相容）；`canonical_source_url TEXT NOT NULL` 并建 `UNIQUE(canonical_source_url)`（去重塌缩冲突键）；`representative_raw_item_id BIGINT NOT NULL`（provenance 回指 `raw_items.id`，**裸 bigint 无外键**，对齐既有 `ai_news_events.representative_raw_item_id`/`ai_products.representative_raw_item_id` 的零 FK 惯例）；结构化经验字段 `scenario TEXT` / `tools JSONB` / `techniques TEXT` / `applicability TEXT`；`long_term_value INTEGER NOT NULL`（0..100，由提炼 Agent 产出并 Zod 约束，兼作 KB 准入闸与实践锦囊排序键，不另设 importance_score）；`headline_zh TEXT` / `summary_zh TEXT`（推送展示）；`published_at TIMESTAMPTZ`（recency 窗口，取自 raw_items）；`created_at TIMESTAMPTZ`。**不含向量列、不建二级索引**（对齐基线惯例——全库零 secondary index，数据量小排序顺序扫足够，未来慢了再单独 forward-only 迁移加索引；UNIQUE(canonical_source_url) 自带索引已够去重 ON CONFLICT）。

迁移对既有数据的处理：P2 必须以 forward-only 迁移（追加新迁移序号、不重写既有 0000–0003）落新增的 `ai_products` 表、`ai_news_events.judge_claimed_at` 列及任何新增列；本变更的 `ai_experiences` 表同样以 forward-only 追加迁移落库，禁止 drop 既有上线数据表重建。迁移幂等口径为「经 `drizzle-kit migrate`（drizzle journal 跳过已应用项）可重跑」，**非** SQL 文件自身可重入。

`push_records` 必须保留 `UNIQUE(target_type, target_id, channel, push_date)` 唯一约束。本期推送链路扩展为多通道与多 `target_type`，系统必须实际写入推送记录（先 `pending`、成功 `success`、失败 `failed`）。`target_type` 与 `channel` 的取值必须由程序集中定义的枚举（如 Zod enum）统一收口，禁止在各推送路径散落字面量——避免某处误拼（如 `'alerts'`、`'Event'`）使幂等四元组静默分裂成两个命名空间、绕过去重而漏推/重推（DB 裸 `varchar` 不挡拼写错）。**权威全集必须显式声明**：`target_type` 枚举 = `{event, product, alert, weekly, experience}`（其中 **`weekly` 为保留成员、无生产写入方**——周报车道已删除，该成员仅为不触发 `push_records` 历史行的 DB 约束迁移而保留，MUST NOT 被新推送路径复用）、`channel` 枚举 = `{telegram, feishu}`；新增 `target_type`/`channel` 必须先扩此枚举再使用（该枚举 push 与 KB 入库共用，一处改两处生效）。该全集相对 QA.md §8.6 注释集 `event/product/paper/repo` 是**双向有意偏离**，两个方向都须自洽说明：① **收口**：`paper`/`repo` 不在范围（arXiv 论文仅采集沉淀、不推送，见 source-collectors 与 proposal 非目标），留后续期；② **扩张**：`alert`（P2 相对 QA §8.6 注释新增，实时告警需独立幂等命名空间，见 realtime-alerts）与 `experience`（本变更新增，AI 博主经验的实践锦囊推送需独立幂等命名空间，见 blogger-experience-mining）。此偏离不与 QA.md 的 DDL 冲突，因为 §8.6 的 `-- event/product/paper/repo` 是 **SQL 行内注释、非 `CHECK` 约束**（QA.md DDL 中 `target_type VARCHAR(32)` 无 CHECK），枚举集可由实现期收口/扩张而不破坏 DDL；CLAUDE.md 以 QA.md 为最高权威，此处对其注释集的偏离已显式登记为有意决策。

#### 场景:迁移落核心表与本期新增列
- **当** 对一个空数据库执行 `drizzle-kit migrate`
- **那么** 数据库中存在 `raw_items`、`ai_news_events`、`push_records` 三张表，且 `ai_news_events` 含 `dedup_key`（UNIQUE）、`representative_raw_item_id`、`published_at`、`judge_claimed_at`，`raw_items` 含 `title_hash`、`unprocessable`、`collapsed`

#### 场景:event_id 为不依赖内容的 surrogate key 且与 target_id 类型一致
- **当** 检视 `ai_news_events.event_id` 的列类型与默认值
- **那么** 其列类型为 `VARCHAR(128)`（与 `push_records.target_id` 一致）、默认值为 `gen_random_uuid()::text`，不由 `canonical_url` 等内容哈希派生

#### 场景:ai_experiences 主键与 target_id 类型相容、去重唯一键就位
- **当** 检视 `ai_experiences` 表结构
- **那么** 其主键 `id` 列类型为 `VARCHAR(128)`、默认值 `gen_random_uuid()::text`（与 `push_records.target_id` 一致，供 `target_id=id` 互引），且存在 `UNIQUE(canonical_source_url)` 约束、`representative_raw_item_id` 为裸 `BIGINT`（无外键），无向量列与二级索引

#### 场景:dedup_key 唯一约束就位
- **当** 检视 `ai_news_events` 表结构
- **那么** 存在 `UNIQUE(dedup_key)` 约束，可作为塌缩 `ON CONFLICT` 的冲突目标

#### 场景:迁移可重跑且幂等
- **当** 在已迁移的数据库上再次执行 `drizzle-kit migrate`
- **那么** 已应用的迁移被跳过、命令成功返回、表结构无变化、不报错

#### 场景:推送幂等唯一约束就位
- **当** 检视 `push_records` 表结构
- **那么** 存在 `UNIQUE(target_type, target_id, channel, push_date)` 约束

#### 场景:P3 起解禁知识库表 经验表新增 关系/顾问表仍禁止
- **当** 检视累计迁移（P2 + P3 + 本变更）
- **那么** 存在 `ai_products` / `kb_documents` / `kb_ingestion_records` / `ai_experiences` 表，`ai_news_events` 含 `embedding` / `merged_into` 列，且不含 `item_event_relations` / `item_product_relations` / `ai_tools` / `task_patterns` 四张表

### 需求:健康检查端点
系统必须提供 Hono 应用并暴露 `GET /health` 端点，返回数据库与 Redis 的连通状态。当任一依赖不可达时，端点必须以可观测的方式反映该依赖为不健康（非静默成功）。

#### 场景:依赖健康时返回 ok
- **当** PostgreSQL 与 Redis 均可达，客户端请求 `GET /health`
- **那么** 响应体反映 `db` 与 `redis` 均为连通状态

#### 场景:依赖不可达时如实反映
- **当** Redis 不可达，客户端请求 `GET /health`
- **那么** 响应明确反映 `redis` 为不健康，而非返回全部正常

### 需求:环境配置校验

系统必须提供 `.env.example` 列出运行所需环境变量（`DATABASE_URL`、`REDIS_URL`、LLM provider API key、model 名）。应用启动时必须校验关键环境变量存在，缺失时以可观测的方式快速失败，禁止静默使用空值或默认值继续运行。

**配置不合法时，该应用 MUST NOT 带着未校验或错误的配置继续运行。** 该后果按**行为**定义、不按进程拓扑：读文件失败或校验失败时，应用 MUST 在启动期抛错、MUST NOT 调用 `process.exit`、MUST NOT 开始任何工作。独立进程下这兑现为进程非零退出；被宿主以进程内 `import` 托管时兑现为该次加载 reject。

**「由宿主记为失败」是宿主侧前置，不是本需求的保证**——运行时只保证那个 promise 会 reject，宿主是否 await、是否吞掉、是否据此记账不在应用可控范围内。启用托管前 MUST 确认宿主会 `await`、并在 **per-pilot 边界**捕获该 rejection、记为失败后继续运行其它 pilot——**不得让它逸出到进程级未处理路径**（顶层 await 逸出的 rejection 会被 Node 升级为未捕获异常，宿主进程照样会死）。

**已登记的失败模式（一）**：k8s / docker 的 secret 轮转靠原子替换链接再删旧目录，跨「判定类型」与「读取」窗口的读者会拿到 ENOENT/ESTALE ⇒ 启动失败。这是本机制内唯一真实的竞态实例（不是攻击者，是轮转），且其爆炸半径被下面那条放大：**provision 方 MUST 保证启动瞬间该文件稳定**。（不要把「宿主重启该 pilot」写成第二条出路——按失败模式（二），同一 realm 内重启 pilot 拿到的是缓存的错误，唯一的恢复动作是重启宿主进程。）

**已登记的失败模式（二）**：模块求值抛错后，该模块在**同一 ESM loader / module map、同一 resolved URL** 下被标记为错误，此后每次 `import` 重抛同一错误而不重新求值 ⇒ 托管态下一次配置错误会使该应用**在宿主进程剩余生命周期内每次都失败，修好配置也不恢复，需重启宿主**。**故障隔离**不受影响；「恢复」不在本需求的保证与可测面内。

#### 主应用 env 单例的值来源

**主应用 env 单例 MUST 支持一份可选的自有 env 文件作为值来源**，由引导键 `AI_RADAR_ENV_FILE` 指定。该键**MUST 是绝对路径**——托管态下工作目录属于宿主，相对路径的含义随宿主漂移。**空值等同未设。**

**该引导键 MUST 在 env 模块首次求值时、且在本模块加载工作目录 `.env` 之前读取一次**（实现读的是彼时的 `process.env`，不是 OS 启动时的快照；本仓无更早的 dotenv 站点，故二者今天等价，但契约按前者写）；**由 dotenv 从工作目录 `.env` 读入**的同名键与自有文件内的同名键 MUST NOT 参与。否则两种实现都会坏：在 `.env` 加载之后读，则 `.env` 已被灌进共享环境（污染已发生）而后才切换来源；只在之前读却允许 dotenv 提供它，则该键静默失效、隔离没开而运维以为开了。

**注意这不等于「写在 `.env` 文件里一定无效」**：容器编排的 `env_file:` 会把该文件的条目注入为**真进程环境变量**，且注入发生在 node 启动之前、**必然早于首次求值**，那条路径是**生效**的。判据始终是「首次求值时它在不在 `process.env` 里」，不是「它写在哪个文件里」——`env_file:` 只是满足该判据的一种常见方式。同一行配置因此在 `npm run dev` 下无效、在容器里生效——**这个差异 MUST 在部署前置里写明**，否则它本身就是一次「同一配置在不同拓扑下静默走不同路」。

**设了引导键时，该文件 MUST 是取值的唯一来源，MUST NOT 与 `process.env` 叠加。** 叠加只护住文件里写了的键，而 schema 中有默认值或可选的键会在文件未写时静默继承同进程内其它应用的值——那些值本身合法，故既不报错也不告警，后果是把别的租户的推送目标、模型端点与审批人接进本应用的回路。

**该文件的必填键完备性由 env schema 自身的校验保障**：文件成为唯一来源后，缺任何必填键都会被现有校验挡下。**注意这只覆盖必填键**——schema 中有默认值或可选的键，文件未写时取 schema 默认值，本需求不检测漏写、也不保证任一默认值在托管拓扑下安全（见下方残余）。

**读取该文件 MUST NOT 写入 `process.env`**——共享命名空间是本机制要隔离的对象，写回它等于把隔离本身取消。

**该保证的范围是「不污染」，不是「不可见」**：本需求提供卫生隔离（邻居不会在 `process.env` 里观察到本应用的键），**不提供机密性**——同进程内的其它代码仍可 `import` 同一模块实例直接读到。完整的信任模型见变更的 `design.md`。

**未设引导键时，取值来源与优先级 MUST 与本变更前一致**，包括工作目录 `.env` 的加载入口及其选项行为，且 MUST NOT 产生任何新的 stdout 输出。

#### 保护面与已登记的残余

本需求的保护面**限于主应用 env 单例**。以下**不在**其内，且 MUST 显式登记而非默认已覆盖：

- 独立进程的配置入口（如 MCP server 自带的校验入口）——其配置正确性由**该进程自己的启动方式**保证，不由本机制保证；托管拓扑下这是部署侧义务。（**进程分离给出的是环境的一份快照副本，不是隔离**：副本在 spawn 时与其父进程同值、此后各自漂移。所以「它是独立进程」既不能推出「它拿到的是正确的值」，也不能推出「它与主单例一致」。）
- 数据库迁移 CLI——它自读环境变量，托管态下会打到同进程内其它应用的库。启用托管前 MUST 另行处理。
- **文件归属**：完整性校验挡不住「引导键指向了另一应用的 env 文件」——若该文件键齐，校验与 schema 都会通过。本需求的保证是「阻止缺键回落到共享环境」，**不是**「保证读到的文件属于本应用」。
- **畸形文件**：解析器对「合法键行 + 非法字节尾部」的输入仍能提出该键，故本需求**不承诺**畸形或二进制文件必被拒绝；兜底是 schema 的必填校验。
- **web 入口的监听端口**：它不在 env schema 内、由进程环境直供，不受本机制约束。**该残余是否可达取决于托管的是哪个入口**：迁移方向是托管 pipeline 入口（web 独立常驻），那样本条为空；若 web 入口也被同进程托管，两个应用争同一端口表现为**启动期硬失败**，不是静默取错值。
- **MCP 进程**：它与主单例有 **10 个同名键**（`DATABASE_URL` / `PUSH_TIMEZONE` / `FEISHU_WEBHOOK_URL` / `FEISHU_SIGN_SECRET` / `MR_STALENESS_THRESHOLD_DAYS` / `LLM_API_KEY` / `LLM_BASE_URL` / `EMBEDDING_MODEL` / `LLM_MODEL` / `MR_RECOMMEND_EXPLAIN`）。该进程由 MCP 客户端按其自身配置启动，取值与本仓的部署拓扑无关。

  **MUST NOT 给 MCP 进程设置该引导键。** 后果落在**同一个 MCP 进程内的两个配置纪元**：其校验入口在启动时读进程环境（该进程内没有 dotenv 站点），而推送路径要到首次调用推送工具时才动态 `import` 主 env 单例、那一刻才建立第二个纪元。今天两个纪元在客户端设过的键上一致（dotenv 不覆盖已存在键）；设了引导键则纪元二变成「文件即唯一来源」，可与纪元一在全部 10 键上分歧 ⇒ 跨目标读取与推送。

  **遵守该禁令并不消除这 10 键的分歧面**，只是不再扩大它：`PUSH_TIMEZONE` 落在 `push_date` 上（推送幂等唯一键的一维，分歧 ⇒ 同一瞬间算出两个 `push_date`）、`EMBEDDING_MODEL` 落在 KB 向量口径上（同维不同模型不报错，静默检出错误邻居）。统一其配置来源属独立变更。**该禁令目前只有散文，没有守卫**——本需求不检测，登记为残余。
- **provision 侧的三条前置**（本需求不检测、由部署方保证）：① 该文件 MUST 是一份**自足**的 env（含托管拓扑下正确的 DB / Redis endpoint）；② 复用现有部署的 `.env` 前 MUST 按拓扑**核验 endpoint 归属**；③ 路径 MUST 含本应用标识，使「照抄兄弟应用的 provisioning」这类失误在值本身可见。
- **有默认值 / 可选键的静默回落**：文件未写这些键时取 schema 默认值，无检测、无告警。方向比「继承邻居的值」安全，但仍是静默——最可能的失误是 provision 时漏写 `FEISHU_WEBHOOK_URL` / `FEISHU_SIGN_SECRET` ⇒ `isFeishuEnabled()` 静默转假 ⇒ **日报少一条通道且不报错**。本需求不保证任一默认值在托管拓扑下安全。
- **测试守卫开关**：8 个模块共 17 处调用点以裸读共享环境判是否处于测试态，自有文件既设不了也清不掉该键 ⇒ 按构造在保护面外。共享环境中存在该键会使本应用的 LLM 与推送调用点整体抛错（**fail-closed、不误发**）。

#### 场景:缺关键变量时启动即报错
- **当** 缺少 `DATABASE_URL` 等关键环境变量并尝试启动应用
- **那么** 应用以明确错误信息失败，而非静默启动或用空值连接；独立进程下表现为非零退出码

#### 场景:被进程内托管时，配置不合法只让本应用失败
- **当** 本应用被宿主以进程内 `import` 加载，而其配置不合法
- **那么** 该次加载 reject，且**配置加载与校验失败路径**不得以结束进程兑现「快速失败」（`src/config/env.ts` 中不得出现 `process.exit`；CLI 入口与信号处理器的正常退出不在此列）。**「同进程内的其它应用不受影响」是这两条加上本需求前文那三条宿主前置的合取结论，不是本应用单方面的保证**——应用侧只保证「reject 且没开始干活」，宿主是否 `await`、是否在 per-pilot 边界捕获、是否据此记账，均不在本条的保证与可测面内

#### 场景:设了引导键时只读自有文件，不继承共享环境
- **当** `AI_RADAR_ENV_FILE` 指向本应用的 env 文件，而 `process.env` 里存在同名键且值不同（含 schema 里有默认值的可选键）
- **那么** 全部取值来自该文件；`process.env` 中的同名值**一个都不参与**，包括文件未写、schema 有默认值的那些键——它们取 schema 默认值而非共享环境里的值

#### 场景:自有文件缺必填键时启动即失败，而不是回落共享环境
- **当** 引导键指向的文件缺少某个必填键，而 `process.env` 里恰好有该键
- **那么** 启动失败并指明缺失的键，**不得**用共享环境里的值补上

#### 场景:引导键必须是绝对路径
- **当** `AI_RADAR_ENV_FILE` 被设为相对路径
- **那么** 启动失败并指明该键必须为绝对路径——托管态下工作目录属于宿主，相对路径解析结果不受本应用控制

#### 场景:读取自有文件不污染共享环境
- **当** 应用按引导键读入自有 env 文件
- **那么** `process.env` **不被写入任何键**——同进程内的其它应用不会**在 `process.env` 中**观察到本应用的配置（它们仍能 `import` 同一模块直接读到，本条不提供机密性）

#### 场景:引导键只认进程环境，写在 `.env` 里无效
- **当** 工作目录 `.env` 里写了 `AI_RADAR_ENV_FILE=/abs/x.env`，而进程启动环境里没有该键
- **那么** 该键**不生效**：应用按「未设引导键」路径运行（照常加载工作目录 `.env`），**不得**出现「先把 `.env` 灌进 `process.env`、再切换到 `/abs/x.env` 作唯一来源」的半生效状态

#### 场景:空值的引导键等同未设
- **当** `AI_RADAR_ENV_FILE` 被设为空串或纯空白
- **那么** 视作未设，走与本变更前一致的路径；**不得**因「非绝对路径」而失败

#### 场景:引导键指向的文件不存在时启动即失败
- **当** 引导键指向一个不存在的路径
- **那么** 启动失败并指明该路径与该键名——**不得**回落 `process.env`、也不得当作空文件继续。（文件存在但读取失败〔如 EACCES〕走同一条包装与抛出路径，但本需求不为该分支单列可测断言。）

#### 场景:引导键指向非普通文件时在读取之前失败
- **当** 引导键指向一个存在但不是普通文件的路径（如 FIFO）
- **那么** 启动失败并指明该路径，且该判定 MUST 发生在**读取之前**：FIFO 上的读取会永久阻塞（不抛错、不超时），托管态下表现为启动期静默挂死。该场景的用例 MUST 在**有界时间内**判定（走子进程 + 硬超时），否则守卫失效时表现为测试进程无声挂死而非变红

#### 场景:设了引导键时不加载工作目录 `.env`
- **当** 设了引导键，且工作目录下存在 `.env`
- **那么** 该 `.env` **完全不被加载**——`process.env` 不会因此多出它的任何键。这是本机制「本仓不污染邻居」那半的兑现方式；只断言取值来自自有文件不足以覆盖它

#### 场景:引导键指向符号链接时跟随到目标文件
- **当** 引导键指向一个指向普通文件的符号链接（容器与 k8s 的 secret 挂载普遍是这个形态）
- **那么** 正常读取目标文件的内容——判据按跟随语义，**不得**因「链接本身不是普通文件」而拒绝

#### 场景:未设引导键时行为与本变更前一致
- **当** 未设 `AI_RADAR_ENV_FILE`
- **那么** 工作目录 `.env` 的加载与取值优先级和本变更前完全相同，且**不产生任何新的 stdout 输出**——把标准输出当数据通道的 CLI 不得因此被污染

### 需求:ai_news_events 承载日报一句话要点列

系统必须为 `ai_news_events` 提供 `headline_zh` 列（`text`，可空），承载中文摘要 Agent 产出的「一句话要点」，供 Telegram 日报渲染。该列由一次 forward-only 迁移 `ALTER TABLE ai_news_events ADD COLUMN headline_zh text` 添加（取当前下一个未用迁移序号 `0003`，不重写既有 0000/0001/0002）；`drizzle-kit migrate` 必须可重复执行幂等（journal 追加一条 entry、重跑跳过、结构无变化）。该列可空使旧事件（迁移前已落库、无要点）保持 `NULL`，由日报渲染层按固定顺序回退（`summary_zh` 截断 → `representative_title` → 仅标题），不阻塞。

> 本需求把 `headline_zh` 这一新增 schema 列归入 platform-foundation（schema 的单一事实来源），使「中文摘要 Agent 写 `ai_news_events.headline_zh`」与「schema 声明该列」一致，不产生"消费方要求某列但 schema 不声明"的断裂。

#### 场景:迁移添加 headline_zh 列且幂等
- **当** 对已落 P1 schema 的数据库执行新增迁移 `0003`，再次执行 `drizzle-kit migrate`
- **那么** `ai_news_events` 含可空 `headline_zh text` 列；第二次 migrate 被跳过、结构无变化、不报错

#### 场景:旧事件 headline_zh 为 NULL 不阻塞
- **当** 迁移前已存在的事件（`headline_zh` 为 NULL）进入当日 Top N
- **那么** 日报渲染按回退顺序取 `summary_zh` 截断/`representative_title`，不因 `headline_zh` 为 NULL 报错或漏推

### 需求:ai_products 产品表可迁移

系统必须以 forward-only 迁移落 `ai_products` 表（QA.md §8.3），承载产品发现的确定性硬规则合并。表必须含：

- `product_id` 不透明 surrogate key（与 `event_id` 同口径，`VARCHAR(128)` + `gen_random_uuid()::text` 默认值，不由内容派生）；
- `name VARCHAR(255) NOT NULL`（QA.md §8.3 的唯一 NOT NULL 业务列，必须显式声明并在塌缩 INSERT 时填充，见 product-discovery「ai_products 硬规则产品合并」——漏填会使塌缩 INSERT 因 NOT NULL 约束直接失败）；
- 硬规则合并所需的唯一约束：`UNIQUE(canonical_domain)`、`UNIQUE(github_repo)`、`UNIQUE(product_hunt_slug)`（三者各自唯一，作为 `ON CONFLICT` 冲突目标）；
- last_seen 类可累加字段 `first_seen_at` / `last_seen_at` / `last_pushed_at`（可空）——**本期必建**（不属可延后的纯富化列）：硬合并塌缩的 `UPDATE` 分支累加/更新这些列，缺列则 UPDATE 无目标列、塌缩跑不通；
- `metadata JSONB`（QA.md §8.3 含此列）——**本期必建**：多键命中多行冲突态以 `metadata.merge_conflict` 标记落点（见 product-discovery「ai_products 硬规则产品合并」），缺列则冲突状态无持久落点、推送排除规则失去依据；
- `representative_raw_item_id BIGINT`（**独立列**，回指 `raw_items.id`、类型与 `ai_news_events.representative_raw_item_id` 一致）。**此列为 P2 新增过渡列，QA.md §8.3 DDL 未列**，用于在不建 `item_product_relations`（P3）的前提下保留 raw_item↔product 回指，P3 引入关系表后可迁移——spec 此处标注其为有意偏离 QA §8.3、非 DDL 不一致。

迁移必须 forward-only（追加新迁移序号、不重写既有迁移）且 `drizzle-kit migrate` 可重复执行幂等。`ai_products` 本身不建 vector 列（产品语义合并不在本期范围，仍用硬规则合并）；P3 的向量能力仅作用于 `ai_news_events` / `kb_documents`（见「P3 向量与知识库 Schema 可迁移」需求），不及于 `ai_products`。

#### 场景:迁移落 ai_products 表与合并唯一约束
- **当** 对已落 P1 schema 的数据库执行 P2 新增迁移
- **那么** 存在 `ai_products` 表，含 `product_id` surrogate key 及 `UNIQUE(canonical_domain)` / `UNIQUE(github_repo)` / `UNIQUE(product_hunt_slug)` 约束，可作为塌缩 `ON CONFLICT` 冲突目标

#### 场景:ai_products 迁移 forward-only 且幂等
- **当** 在已迁移数据库上再次执行 `drizzle-kit migrate`
- **那么** 既有迁移不被重写、新增迁移被跳过、表结构无变化、不报错

#### 场景:ai_products 不含向量列
- **当** 检视 `ai_products` 的迁移
- **那么** 不包含任何作用于 `ai_products` 的 vector 列（P3 向量能力仅及于 `ai_news_events` / `kb_documents`）

### 需求:测试环境必须隔离生产外部出口

系统必须保证：在测试环境（`process.env.VITEST` 为真）下，任何**外部出口**的**默认（真实）调用路径**被守卫拒绝（throw），强制测试注入 mock / 桩，绝不让用例静默触达生产。外部出口涵盖：

- **消息发送器**：`createTelegramSender`（grammY）与 `createFeishuSender`（webhook）。
- **LLM 调用**：三个 Agent 模块（value-judge / digest / published-at-inference）的默认 `generateObject` 调用路径（即未注入 `generateObjectFn` 时的兜底实现）。

根因：**未设 `AI_RADAR_ENV_FILE` 时**（测试的常态），`config/env.ts` 会加载工作目录 `.env`（含真实 `TELEGRAM_*` / `FEISHU_*` / `LLM_API_KEY`），且测试运行器无 env 中和；若默认真实路径无守卫，任一用例漏注入 mock 即静默真发到生产飞书/telegram 或真打生产 LLM（刷屏 + 费用 + 非确定性）。

守卫判据必须为 `process.env.VITEST`（vitest 恒设、生产恒不设），故**生产运行时行为完全不受影响**——provider / model / 重试 / 超时 / 降级 / 发送口径均不变。守卫必须卡在**真实网络出口路径**：发送器在「未注入真实 transport（telegram 的 api / 飞书的 fetchImpl）」时 throw；LLM 在默认 `generateObject` 实现（仅在未注入 `generateObjectFn` 时被调用）入口 throw——**不得**卡在 `createOpenAI`/`buildModel` 这类仅构造 provider、不触网的步骤上（否则误伤已注入 mock 的用例）。守卫抛错信息必须可操作（指明「测试禁止真实调用，请注入 mock」）。

> 本需求把 PR #10 已落地的发送器守卫与本次新增的 LLM 守卫合并为同一条跨切「测试隔离生产外部出口」不变量，作为单一事实来源，防新增 Agent / 发送器复制旧的无守卫默认路径使该泄漏类复发。

#### 场景:测试下默认 LLM 调用被守卫拒绝
- **当** 某测试用例调用某 Agent（value-judge / digest / published-at-inference）但**未注入** `generateObjectFn` mock，致其走默认真实 `generateObject` 路径
- **那么** 守卫在 `process.env.VITEST` 下直接 throw（可操作错误信息），**绝不发起真实 LLM 网络调用**（首要保证，绝对成立）；该用例随后经各自链路（value-judge/digest 逐条降级→熔断，published-at→backfill 判不出）失败暴露，而非静默通过

#### 场景:测试下默认发送器被守卫拒绝
- **当** 某测试用例使通道集回退到真实发送器（未注入 telegram 的 api / 飞书的 fetchImpl，未注入 mock sender、未钉 channels）
- **那么** `createTelegramSender` / `createFeishuSender` 在 `process.env.VITEST` 下 throw，该用例当场失败，绝不真发到生产 chat / webhook

#### 场景:注入 mock 或桩的用例不被守卫误伤
- **当** 用例已注入 `generateObjectFn` mock（LLM）或注入 transport 桩 / mock sender / 钉定 channels（发送器）
- **那么** 守卫不触发，用例正常执行——守卫只拦「漏注入而回退真实出口」，不拦正确注入的用例

#### 场景:生产运行时不受测试守卫影响
- **当** 应用在生产运行（`process.env.VITEST` 未设）执行日报 / 告警 / 评分 / 摘要 / 发布时间推断
- **那么** 默认真实发送器与 LLM 调用路径照常工作，守卫恒不触发，行为与守卫引入前完全一致

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

**装配现状（截至本次修订）**：真 sink 已在三处注入——日报链 `run-daily-workflow.ts` 的薄 `run(ctx)` 包装、告警链 `alert-scan.ts` 的同层包装、以及 staleness 车道的 worker 装配；生产 `alert()` 调用点共 12 处。下文的「只落 stderr」描述的是**未注入时的回落**，不是当前现状。

**sink MUST 有界，其 DB 调用 MUST 用客户端超时。** `alert()` 的每次调用必须在有界时间内 settle，**即使 DB 无响应**——全部调用点都直接坐在业务 run 的 await 路径上。限频所依赖的 DB 调用必须各自带**客户端**超时：服务端 `statement_timeout` **管不到连接池获取等待**，而池耗尽时连接获取会无限排队且**不抛错**，于是任何只捕获异常的降级分支都不会被触发。

**单通道的串行 I/O timeout 配置预算 = 「认领耗时 + 发送耗时 + 终态写回耗时」的超时上限之和 = 5s + 10s + 5s = 20s；通道间并发，取最大值不叠加。** 该预算 MUST 由一条常量断言钉住，**两个超时常量 MUST 从模块 `import`**（故它们 MUST `export`）——否则断言恒绿、「调高任一超时常量会撞到检查」这句话就是假的。

它是**配置预算，不是墙钟上界**：20s 是可趋近的上确界（认领耗时 4.999s 而不超时时三项并不互斥），且 `setTimeout` 无调度延迟上界、渲染与发送的同步前段在计时器之外。该超时自 builder 交给超时包装时起算，覆盖「连接获取排队 + 握手 + 执行」全程，因此它同时是一个池竞争阈值——本进程自身的重查询占满共享池也会触发它。它是**单次 `alert()` 的**预算，不是 run 的：源级告警坐在逐源循环里，一个 run 的告警耗时按告警点数串行叠加（告警链每轮最坏 ≈80s；日报 job 最坏 ≈360s）。推导见变更的 `design.md` D4。

**两处 DB 调用的超时语义 MUST 分开定义**：
- **认领超时**：与「认领抛错」同路——不去重直接发 + 「限频不可用」标注。
- **终态写回超时**：发生在认领之后、且其失败分支的调用意味着消息未必已发出，MUST 只做有界返回 + 留痕；它**无法**补标注。

**客户端超时不取消底层写入**，被放弃的那次操作仍可能迟到落地，故本需求**不保证**任何确定终态。结局按「操作类型 × 底层结局 × 认领时该行已有状态」三轴判定：

- **认领超时**：本 attempt 永不写终态（无认领 id）。迟到的认领落地时——原状态非 `success` ⇒ 置 `pending`，留下无人收尾的孤儿行、且把 `failed` 的 `error_message` 抹成 NULL；原状态已是 `success` ⇒ 被 `status <> 'success'` 拦下。
- **终态写回超时**：被弃写永不落地 ⇒ 行滞留 `pending`、次轮可重新认领重发；迟到落地且该行仍非 `success` ⇒ 落成 `success` 或 `failed`，先后顺序决定次轮是否重发；该行已被另一 attempt 置 `success` ⇒ 被吸收态拦下。
- **被弃的认领跨日落地**：`push_date` 在语句构造时即算成常量绑进 SQL，故障跨日界时它仍带昨天的 `push_date`，可新插一行历史 `pending`。该行**无自愈路径**（认领只写今天、限频判据只看 `success`）。

**登记的降级**：状态机主键是 `(dedupKey, channel, push_date)`——每通道独立认领、独立占一行唯一键。认领超时时本 attempt 在超时前**没有观察到认领结果**，故无条件走降级直发（迟到的认领可能确实写了行，本 attempt 依然看不见）⇒ 慢库持续期内每一轮、每一通道各重发一条，且与日报链共用同一 dedupKey 的跨链去重同时失效。方向是「宁可重复，不可哑火」。

**`success` MUST 是吸收态**：终态写回 MUST 附带 `status <> 'success'` 条件。该竞争**并非由超时引入**：认领语句的唯一条件是「认领时该行 `status <> 'success'`」，两条认领 SQL 顺序执行（不必并发）即返回同一行 id；倒写还需两个 attempt 的生命周期交错，但不需要超时。超时只是把交错窗口拉大。归因的完整推导见变更的 `design.md` D3。

**吸收态收敛的是「行」，不是「发送」**：只要认领时该行还不是 `success`，认领语句就返回同一个 id ⇒ 每一个在首个 `success` 落库前完成认领的 attempt 都各发一条。故限频口径是「每 dedupKey 每通道每天至多一条 `success` **行**」——重复被压到「这样的 attempt 数」而非 1（当前两条链共用同一 dedupKey 使常见取值为 2，但那是取值不是上界）。限制发送次数需认领即持锁到终态或 fencing，属独立变更。反向（迟到的认领把 `failed` 倒回 `pending` 并清空 `error_message`）**未关闭**，属接受的降级：去重语义不受损，损失的是失败留痕。

**best-effort MUST 覆盖真 sink 的整个函数体**（detail 摘要与时间计算若在任何 try 之外，畸形入参就能让 `alert()` 真的 reject，打到无本地 catch 的调用点上——其中一些紧接抛出、另一些自陈「整步永不向上抛」）。其兜底日志 MUST 打出原始告警文本，只打异常对象会让该告警内容彻底消失。该 MUST 的主语是**真 sink**，不含默认的 `console.error` 实现与惰性构造包装。

**逐通道隔离 MUST 不被 best-effort 兜底吞掉**：单通道失败 MUST NOT 中断其余通道的投递——否则「所有调用点 MUST `await` ⇒ 投递有完成保证」这条收益在多通道下当场为假。

**为何必须有这条需求**（历史动机；本需求已落地，装配现状见下）：`AlertSink` 的默认实现是 `console.error`（`[pipeline][ALERT] …`），本需求落地前生产常驻进程**不注入任何其它实现** ⇒ 所有「系统级故障」告警（采集全挂 / 全 unprocessable / 源陈旧 / 降级熔断 / 租约已失 / 本变更新增的日期提取归零）**只落 stderr**。规范反复区分的「记日志 ≠ 告警」在实现里是**同一个 `console.error`，只差一个前缀**。故规范里任何一条「MUST 告警」在本需求落地前都是**空的**。

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
createOpsAlertSink({ senders, dbh?, now? }): AlertSink
  // senders: Partial<Record<Channel, MessageSender>>——**通道集由 Object.keys(senders) 派生，
  //          不是一个独立入参**；dbh / now 均可选（默认共享池 / 系统时钟），供测试注入。

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

**通道选择 MUST 定死**：sink 的通道集 MUST 由注入的 `senders` **派生**（`Object.keys(senders)`），即「**已配置通道全集**」（与业务推送同口径），并逐个发送——MUST NOT 另收一个可与 `senders` 不一致的 `channels` 入参。**未配置任何通道时 MUST 回落 `console.error`，且 MUST NOT 写任何 `push_records` 行**——否则限频键会把「根本没有通道可发」也算成「今天已告过」，使通道配好之后当天仍然静默。

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

#### 场景:前一次告警已成功后，同一 dedupKey 当天不再发送（跨进程、跨重启、跨链）
- **当** 同一 `dedupKey` 的告警**在前一次已写入 `success` 行之后**、于同一天被再次触发（同一进程重复轮次、进程重启后、或另一条链触发）
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

#### 场景:DB 无响应时告警仍经真实通道发出
- **当** 认领所需的 DB 调用挂住不返回（如连接池耗尽）
- **那么** 该调用在客户端超时后被判为限频不可用，告警**照常经真实通道发出**并带「限频不可用」标注；`alert()` 有界 settle

#### 场景:认领超时期间同一 dedupKey 每轮每通道各重发一条
- **当** 慢库导致认领持续超时
- **那么** 每一轮的每个已配置通道都因**本 attempt 未观察到认领结果**而各自走降级分支重发一条（状态机主键含 `channel`，两通道即两条），跨链去重同时失效——这是登记的降级，不得被描述为「多一条」，其成因亦不得被写成「DB 里没有 `success` 行」

#### 场景:终态写回超时只有界返回，最终状态取决于时序
- **当** 终态写回的 DB 调用挂住
- **那么** `alert()` 仍有界 settle；被放弃的写可能迟到落地，最终状态与是否重发按三轴时序矩阵判定，不得断言某个确定终态

#### 场景:迟到的失败写回不得覆盖已成功的行
- **当** 被放弃或并发的失败写回在另一 attempt 已写 `success` 之后才落地
- **那么** 该写入因 `status <> 'success'` 条件不生效，行保持 `success`，同一告警不因此被重复发送

#### 场景:单通道失败不中断其余通道
- **当** 多通道装配下其中一个通道的发送失败或抛错
- **那么** 其余通道 MUST 照常完成投递并各自写入自己的终态行；`alert()` 仍 resolve。**绝不可**让单通道失败中断整批——那会使「所有调用点 MUST `await` ⇒ 投递有完成保证」在多通道下为假，且该回归被 best-effort 兜底压成一行普通日志、从调用点看不出来

#### 场景:畸形入参不得让告警向业务路径抛
- **当** 传入的 detail 在 detail 摘要或时间计算阶段抛错
- **那么** `alert()` 仍 resolve，兜底日志中出现原始告警文本——调用点紧接的抛出不被替换，自陈「整步永不向上抛」的调用方不被击穿
