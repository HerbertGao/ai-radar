# AI Radar → hangar 迁移:定位共识与次序决策

> **状态:** 讨论定稿 · 未开工(闸在 hangar inbox Phase-1 出口之后)
> **日期:** 2026-07-10
> **一句话:** ai-radar 不"整体切到 hangar",而是**写侧批处理内核下沉成 pilot、读侧常驻服务留独立**;本文记录 2026-07-10 一场 grilling 锁定的未来定位、pilot/服务切分,以及"先改功能还是一步到位"的次序决策。
> **关联:** hangar 仓 `../hangar`(无头 AgentOS 脊柱,`DESIGN.md` 为其架构 SOT)· 本仓 `QA.md`/`ROADMAP.md` · memory `hangar-migration-positioning`。

---

## 0. 前提原则:先定位,后迁移

pilot 与常驻服务之间那条边界,由"这工程未来是什么"决定。定位没锁死就画边界 = 将来要从 hangar 上再拆下来返工。故本文先锁定位,再谈迁移次序。**结论:定位与 hangar 的公理相容,边界成立且清晰。**

## 1. hangar 是什么(够用即可)

一根**无头 AgentOS 脊柱**:停放、调度、审计一队 `*-pilot` agent,自己不抢戏。pilot = 一个独立 repo 的 checkout,含 `app.yaml`(唯一入口)+ 编译出的 `dist/pipeline.js`(导出 `run(ctx)`);域代码与域库留在 pilot 自己 repo,脊柱**零域概念**、只认 `Run/RunEvent/Approval/App`。脊柱提供:cron 调度、run 状态机 + 事件审计(SQLite 4 表)、审批 PARK/resume、崩溃回收、CLI。**不提供**:durable 队列、HTTP、IPC、MCP、web workbench、多租户。`run(ctx)` 给 `input/trigger/config/logger/emit()/propose()`;本质无害的自动副作用(推送)可在 `run()` 内直排、不走审批,只有高危可审批动作走 `propose` → PARK → `hangar approve`。

## 2. 未来定位(锁定)

| # | 结论 | 影响 |
|---|---|---|
| 1 | **自用为主 + 少量演示**,不奔对外产品 | 不触碰 hangar Q1「只服务自己 portfolio」公理 → 脊柱可用 |
| 2 | 重心从"每日精选日报"迁到**持续 KB 构建 + 对话流 RAG 推荐** | 日报**降级**成 inbox-P2/P3 式集合批量推 |
| 3 | 保留 **P0 高价值即时推送**(≅ inbox P1) | 仅剩的 push 型日常价值,大事才响 |
| 4 | 采集走**高频 cron**(每 ~10min),不做流式 | 流式/事件驱动留作 hangar 未来扩展、且多半用在情报之外场景 |

## 3. 架构地图:pilot / 服务切分

**一句话边界:写侧 → hangar pilot,读侧/交互 → 独立常驻服务,DB(Postgres/pgvector)是唯一界面。**

| 单元 | 归属 | 节奏 / 说明 |
|---|---|---|
| **`radar` pilot**(flagship) | hangar 写侧 | 高频 */10:collect→硬去重→judge→**P0 直排即时推**→做卡→入 KB。collect+judge **同 pilot**(即时性不容 DB 交接那一跳延迟) |
| **`digest` pilot**(次要) | hangar 写侧 | 每日,降级批量推;`push_date` 幂等结构留、内容变轻 |
| **`model-radar` pilot**(独立) | hangar 写侧 | 周级 scrape / 每日 staleness / event-review;自有 `mr_*` 域库;bounded domain **不并入** `radar` |
| **对话流 RAG 推荐** | 独立常驻服务 | **纯读** KB;未来"按需触发采集"经 `hangar run` 细缝 |
| **Model Radar web / MCP** | 独立常驻服务 | 读侧,DB 为界,不动 |
| **curation 审批 bot** | 独立常驻服务 | Telegram 逐条批,暂不接 hangar Approval(见 §6) |
| snapshot 刷新 | 随 web 进程 | 缓存活在 web 内存,不拆 |

**关键结论:**
- **`radar` pilot ≅ inbox pilot**:两者都是 `run()` 内即时 notify + 批量 digest、皆不走审批的形状。→ **hangar Phase-1 验证 inbox 时,基本同时预验证了 ai-radar 的 pilot 形状**,迁移风险大降。
- **`radar` + `model-radar` 两个异域 pilot 共脊柱** = 兑现 hangar 的"脚手架摊薄"论点(否则单 pilot 摊不平脊柱的间接成本)。
- **拆 pilot 的正当理由只有:节奏不同 / 崩溃域不同 / 一致性边界不同。绝不因"概念上是不同 Agent"就拆**——"专门 Agent"是 pilot 内部的干净模块,不是独立 pilot。

## 4. KB 用 SAG 思路(不照搬方案)

SAG(`github.com/Zleap-AI/SAG`)= 增强版 RAG:`chunk→event`、`chunk→entities`、`event↔entities` + 多跳 SQL 遍历 + rerank。基础设施只要 **Postgres+pgvector + OpenAI 兼容 LLM/embedding/rerank**——**ai-radar 已全有,零新增基建、无图库、无独立进程**。

- **写侧(`radar` 的 kb-build 阶段)**:"做成卡片"= 抽 event/entity/relation、embed、入库(多几张 `kb_*` 表,在 ai-radar 自己域库里,hangar 不碰)。
- **读侧(对话 RAG)**:检索升级为多跳 SQL + BM25 + rerank,仍对同一 Postgres 纯读。
- **不戳穿边界。** 脚注:① 读侧多一个 rerank API 依赖;② 每条入库 LLM 抽取变重 → 喂回"collect/kb-build 是否按成本拆节奏"的实现期决策。

## 5. 迁移次序决策:先改功能,还是一步到位?

**背景:** §2 的重心迁移(高频扫描 + P0 推送 + SAG KB + 对话 RAG + 日报降级 + model-radar 保鲜)是一批**独立于 hangar 的大功能变更**。而迁移 = 把管线下沉成 pilot。次序有三种:

| 方案 | 做法 | 判定 |
|---|---|---|
| **A · 功能先行** | 先在**当前栈**(BullMQ/worker/Hono)做完新功能并验证,再把已验证系统 re-host 成 pilot | ✅ **推荐** |
| B · 一步到位 | 新功能**直接作为 hangar pilot** 开发 | ❌ 两个移动靶同时打 |
| C · 薄迁移先行 | 先把现状 `runDailyWorkflow` 原样迁上 hangar 求 parity,再在 pilot 上长新功能 | ❌ 迁一个即将被推翻的东西 |

**推荐 A,理由:**
1. **hangar 现在就没就绪。** 迁移闸在 hangar inbox Phase-1(连续 7 天每天用)出口之后,B/C 此刻都被堵;而新功能不必等 hangar,现在就能交付价值。
2. **分离变量(change one thing at a time)。** §2 的产品重构本身是大赌注。先在**稳定已知平台**验证"P0/KB/RAG/日报降级"这套产品形态,再叠加"换宿主"这个变量;否则出了问题分不清是**产品方向错**还是**迁移错**。
3. **别冻结在 hangar 未定契约上。** `ctx.emit` 的 run-chain 事件 schema 要对齐 hangar 正在做的前端 monitor,那契约还在成型;B 会逼你冻结在未冻结的接口上。
4. **可迁形态构建 → 迁移变廉价 re-host。** 新功能在当前栈落地时,业务逻辑与"进程/调度/锁/CLI"解耦,写成能被 `run(ctx)` 形态调用的纯 async 函数;后续迁移就是换驱动、不是重写。

**A 期间的红线:** 新功能**别吃 BullMQ 的 durable 特性**(持久重试队列 / dead-letter / delayed job),只用"cron 触发 + 整 job 重试"这层——ai-radar 现状正好在这个封套内。越界即给未来迁移攒债(hangar 无 durable 队列,破其 DESIGN #3/#8)。

**为何不选 B/C:** B = 你的新功能 + hangar 仍在演化的脊柱,两个移动靶,且 hangar 未到可迁的 Phase-2。C 的"薄迁移求 parity"本身是好动作,但它适合"产品形态已稳、只想换宿主"的处境;你**马上要大改产品形态**(日报降级、P0、KB),迁一个即将被推翻的 `runDailyWorkflow` 迁完就得重来。

### 5.1 为何不把 BullMQ 收为 hangar 的下一期基底

"保留 BullMQ、让 hangar 收它作可选基底,ai-radar 少改一点"——**否**。这不是中性权衡,是砸穿 hangar 地基:

| hangar 公理 | BullMQ-as-substrate 如何违反 |
|---|---|
| #6 无消息队列 | BullMQ 是 Redis 背的 MQ,收它 = 给脊柱装 MQ |
| #3 一 host / 一 SQLite / 4 表 | BullMQ 要 Redis = 第二存储 + 第二进程 |
| #8 不做通用 durable replay | BullMQ 持久队列 = 通用 durable execution;DESIGN 已明文判 inbox `retryQueue`"破 #3/#8,不搬" |
| #2 inbox 用不到不许进脊柱 | inbox 不用 BullMQ(其 durable 队列正被砍),纯为 ai-radar 塞 = 过不了 #2 |

更根本:hangar 存在的理由(DESIGN §0)就是吸收"pilot 被迫自带的那套脊柱",而 BullMQ+Redis+调度正是那套。收回来当基底 = 领养它本要删的复杂度,自我否定。

**且"少改"多半是错觉**:替换 BullMQ = 删胶水(`worker-main.ts` lane 注册 / `schedule*` / `buildConnection` / worker wrapper)+ 把 cron 挪进 `app.yaml`(声明式十来行),**业务逻辑(`runDailyWorkflow` 等)两种驱动都不动**——前提是它在"可迁形态"。省下的正是删掉更好的胶水。

**真 durable 需求万一出现**:走 pilot-local(该 pilot 自己 repo 内 `import bullmq`,像 inbox 的 postgres),**不做 spine substrate**,别让其他 pilot 为 Redis 付账。现实是 ai-radar 只把 BullMQ 当"cron + 整 job 重试",高频模型下整 job 重试又被"下一 tick 补跑"覆盖 → **可从 pilot 路径整个丢掉**。

**结论:替换,不收编。** 目标若真是"最小化 ai-radar diff",那结论是"别迁";既然迁的目的是 fleet 级脚手架摊薄,BullMQ 必须走。

## 6. 挂账 / 分期 / 待定

- **curation 审批粒度**:hangar v0 `approve/reject` 按 run 全批,而 curation 要逐条批。现走现有 Telegram 逐条批 bespoke(方案 iii);真感到"审批不在脊柱、要两处看状态"的痛,再给 hangar 的 `approve/reject` 加**单条 Approval 粒度**(方案 i,轻量 CLI+gateway 泛化)。见 memory `mr-price-curation-design-pending`。
- **观测性**交给 hangar 正在做的前端 monitor;ai-radar 只按其契约 `ctx.emit` 吐 run-chain。**emit schema 待 monitor 契约落地再对齐**,现在别过度埋点。
- **流式/事件驱动** = hangar 未来扩展(多半用在情报之外),非本迁移。
- **collect/judge 是否拆成两 pilot** = LLM 成本决策,实现期定,非架构。
- **部署拓扑会变**:现 worker 容器 → hangar daemon 容器 + `HANGAR_APPS` checkout(编出 `dist/pipeline.js`);web/mcp/browser/bot 独立不动。见 memory `deployment-containerized`。

## 7. 闸与下一步

> **详细分阶段执行计划见 [`hangar-migration-plan-a.md`](./hangar-migration-plan-a.md)。** 本节仅列高层次骨架。

1. **现在:** 本文定稿,不动代码。可选起一个"可迁形态"重构(把 `runDailyWorkflow` 的进程/调度/锁耦合从业务逻辑剥出),纯净收益、与 hangar 进度解耦。
2. **按 A 推进:** 在当前栈做 §2 的功能变更(守 §5 红线:BullMQ 只当 cron+整 job 重试)。
3. **闸:** hangar inbox Phase-1 出口通过 + hangar monitor emit 契约落地。
4. **然后:** 按 §3 图翻成正式 OpenSpec 迁移提案(`radar`/`digest`/`model-radar` 三 pilot 的 `app.yaml` + pipeline 切分 + compose 改写 + emit 对齐),把已验证系统 re-host 成 pilot。
