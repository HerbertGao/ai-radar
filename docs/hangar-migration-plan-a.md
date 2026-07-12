# Plan A 执行计划:功能先行 → 可迁形态 → 闸后 re-host

> **状态:** 规划定稿 · 未开工
> **日期:** 2026-07-10
> **上位文档:** [`hangar-migration.md`](./hangar-migration.md)(定位共识 + 次序决策,方案 A/B/C 判定见其 §5;为何替换 BullMQ 见其 §5.1)。本文只讲**方案 A 怎么落地**。
> **一句话:** 先在当前栈(BullMQ-as-cron / worker / Hono)做完 §2 产品重构、以"可迁形态"构建并验证,闸后再把已验证系统整体 re-host 成 hangar pilot。**不等 hangar,也不为 hangar 攒债。**

---

## 0. 贯穿全程的三条纪律(每个 Phase 都守)

这三条是"方案 A 不翻车"的护栏,任何 Phase 的改动都不得违反:

1. **可迁形态(seam-first)。** 每条 lane 现有的 `run*(options)` 保持为 driver 无关**核心**(options=生产默认 DI 面 + 新增可选 `emit`),另加一层**薄 `run(ctx)` 包装**把 ctx 映射到 options 运维子集后委托核心——**不是改核心签名**(见 add-run-context-seam design §D2:约 20 字段 DI 在阶段深处被消费,无法塞进 ctx)。业务只依赖本地 `RunContext` shim(镜像 hangar 的 `input/trigger/config/logger/emit/propose`),**绝不**直接 import BullMQ driver 符号。今天由 BullMQ worker 调 `run(ctx)`,闸后由 hangar 直接调同一个 `run(ctx)`——迁移即换驱动。
2. **BullMQ 只当"cron 触发 + 整 job 重试"。** 不碰 delayed job / job priority / dead-letter / 持久重试队列(hangar 没有,用了即攒债,见上位文档 §5.1)。当前 ai-radar 正好在这个封套内,守住别越界。
3. **emit 前向兼容。** `ctx.emit(kind, payload)` 现在落到结构化 stderr 日志(pino 兼容 `Logger` 接口,不加 pino;可选加一张轻量 `run_events` 表供自查);**事件 kind/payload 形状先粗粒度**,待 hangar monitor 契约落地再对齐。这既给 ai-radar 现在就有 run-chain 可观测性,又是闸后 hangar monitor 直接消费的同一份数据。

**每个 Phase 独立成一个 OpenSpec 提案**(`/opsx:propose` → apply → archive),含"非目标",按本仓工作流走;本文是这些提案的母计划。每个 Phase 按本仓惯例**带测试**(单测 + 必要的集成测试,守 `VITEST` 真发生产的护栏)。

---

## 依赖与次序

```
A0 可迁形态地基 ──┬─► A1 高频扫描 + P0 即时推(flagship)──┬─► A4 日报降级
                  │                                        │   (A1 的 P0 一被信任即可做,
                  │                                        │    不依赖 A2/A3)
                  └─► A2 SAG 式 KB ──► A3 对话流 RAG(纯读)
                                      
所有 A* 通过各自出口闸 + 「hangar inbox Phase-1 出口 + monitor 契约落地」
                                      └─────────────► M  re-host 到 hangar
```

- **A0 必须先行**(所有 Phase 的 seam)。
- **A1 是 flagship**,交付新的日常价值抓手(P0 即时推),优先级最高。
- **A2 → A3 强依赖**(RAG 要 SAG KB 才有得检索);A2 可与 A1 部分并行,但 KB 输入质量依赖 judge,故 A1 先更佳。
- **A4 只依赖 A1**(P0 推送必须先在位、覆盖高价值路径,才好把日报降级),**不**依赖 A2/A3,可在 A1 被信任后随时插入。
- **M 是唯一被 hangar 进度闸住的 Phase**;A0–A4 全程不被 hangar 阻塞。

---

## Phase A0 — 可迁形态地基

**目标:** 把"进程/调度/锁/CLI"从业务逻辑剥出,立起 `run(ctx)` seam。零功能变化、纯解耦——即使最终不迁 hangar 也是净收益,且能提前暴露"哪些阶段偷偷依赖了 BullMQ / 进程全局态"。

**关键改动:**
- 新增 `src/pipeline/run-context.ts`:本地 `interface RunContext`(镜像 hangar)+ `makeLocalCtx({ trigger, config, input })`;`emit`→结构化 stderr(pino 兼容接口,可选 `run_events` 表),`propose`→当前栈无审批,直接执行并 emit `action.executed`(闸后由 hangar gateway 接管)。
- `runDailyWorkflow`/`runAlertScan`/`runWeeklyReport` **保留 options 核心**(新增可选 `emit`),各加一层薄 `run(ctx)` 包装(**不改核心签名**);内部在**实有阶段边界**经 `options.emit` 打点(daily 7 含 digest/alert 5 无kb/weekly 2),不深埋。降级熔断(`WorkflowAbortError`)等抛错由包装 emit `run.failed` 后 **re-throw**,守 BullMQ"整 job 重试"。
- `src/pipeline/worker.ts` 改为 `run(makeLocalCtx(...))`;`worker-main.ts` / `queue.ts` 的调度接线**不动**(仍 BullMQ cron 触发)。

**DoD:**
- `runDailyWorkflow` 等以 `run(ctx)` 被调用,BullMQ worker 只负责构造 ctx + 调用。
- `hangar trace` 式的阶段时间线能从结构化 stderr 日志(或 `run_events`)重建。
- 全量测试绿;在 mock LLM(钉 `now`)下,digest 产出的**确定性面**(入选 event ID+排序、`push_records` 行)与改造前一致(prose 摘要非确定、不逐字节比对)。

**出口闸:** 业务逻辑对"谁驱动它"零依赖——各 lane 业务模块**直接 import** 层面无 BullMQ driver 符号(`bullmq`/`Queue`/`Worker`/`Job`,含经 `./queue.js` 转手的连接符号),无原始 `process.env` 生产流程分支。**经 Zod 校验的 `env` 单例作可移植配置允许保留**(随 pilot 迁 hangar、非 driver 耦合)。〔口径细化并取代早前"env 只在 ctx.config 装配处读"——见 `openspec/changes/add-run-context-seam` design §D7;env 在阶段深处被消费,搬进 ctx.config 反破"闸后机械替换",故承重闸定在 BullMQ driver 的直接 import。〕

**显式不做:** 引入 hangar 依赖;改任何流程行为;动 MR / MCP / web。

---

## Phase A1 — 高频扫描 + P0 即时推送(flagship)

**目标:** 把采集+判断从"每日一次"上移到高频档,判为 **P0 的高价值信息即时推送**(≅ inbox P1)。这是重心迁移后新的日常价值抓手。

**关键改动:**
- **复用现成种子:** `src/pipeline/alert-scan.ts`(`runAlertScan`,已是"快速硬去重、无语义层"的 `*/20` 车道,默认关)演进成高频 `scan` 车道:collect(`src/collectors/index.ts`)→ 硬去重(`src/dedup/collapse.ts`)→ judge 新条目(`src/agents/value-judge/`)→ **P0 判定** → 命中即 `dispatch` 即时推 → 送 kb-build(A2 落地前先只入现有 KB / 打标)。
- **P0 判定** = value-judge 输出上的阈值/分类(如 `importance >= P0_FLOOR`),新增 env `P0_FLOOR`(Zod 范围校验,`src/config/env.ts`)。
- **即时推送复用现有幂等:** 走 `src/push/dispatcher.ts` + `push_records UNIQUE(target_type,target_id,channel,push_date)`。P0 逐条即时推各写一条 push_record;`computePendingSet` 已排除 ever-success → **A4 降级后的日报自然不会重推 P0**,零双推。
- **成本闸(可选):** 若每 tick LLM judge 太贵,judge 车道节流得比 collect 慢(collect `*/10`、judge `*/20`),靠 DB "未判行"交接——这是**实现期成本决策、非架构**(两者仍可同 pilot,见上位文档 §3)。judge 前置**廉价预筛**(硬规则 / 与已知高价值的 embedding 相似度)只把 maybe-P0 升级到全量 LLM judge。

**DoD:**
- 高频车道按 `*/N` 稳定跑,新条目分钟级入库。
- 真 P0(如"OpenAI 正式发布 X")分钟级即时推达;非 P0 不即时推。
- 同一 P0 事件**绝不双推**(幂等测试覆盖:即时推后再跑日报不重推)。
- P0 精确/召回有一版可观测口径(噪音率、漏报样本人工抽检)。

**出口闸:** 连续数日,大事发生时你**先从 P0 推送**知道(而非日报),且噪音可忍。

**显式不做:** 把 judge 拆成独立 pilot(同频不拆,见 §上位文档 §3);为 P0 引入审批(本质无害自动推、直排,不走 propose);动 MR。

---

## Phase A2 — SAG 式知识库

> **⚠️ 定序已改(按 `ROADMAP.md`「RAG 检索路径选型」决策,2026-07-11):A2 拆两步,baseline 先行。**
> - **A2a｜检索 baseline(先做,提案 `add-kb-retrieval-baseline`):** over 现有 `kb_documents.embedding` 的**只读** pgvector 余弦检索(事件域 + tombstone 反连接)+ **worker 环境 CLI 测量入口**(`npm run kb:search`)+ 多跳缺口可观测。零 schema 迁移、零新基建、无新依赖。用途=**测量**单跳够不够。**MCP `search_kb` 工具延到 A3 读服务**(纯查询 MCP 进程只需 DATABASE_URL、不宜引 embedding 凭据)。
> - **A2b｜SAG 结构化(下方原计划,延后):** 延到 A2a **实测出**「查询败在跨文档实体串联(多跳)」再作独立提案。理由:SAG 同栈=可放心推迟、当前语料小且多为单跳、盲建多半猜错 entity/relation schema 照样迁(见与用户 2026-07-11 的成本讨论)。
>
> 下方 A2b 原文保留作延后蓝图。

**目标:** "做成卡片再入库"落地成 SAG 思路的结构化 KB:`chunk→event`、`chunk→entities`、`event↔entities`,为 A3 的多跳检索铺底。**抄思路不照搬 SAG 的 app。**

**关键改动:**
- **schema(`src/db/schema.ts` + `drizzle/` 0012+):** 新增 `kb_events` / `kb_entities` / `kb_relations`(+ 现有 `kb_documents` 向量),关系用 SQL 多跳(**不引图库**)。仍 Postgres+pgvector,零新增基建。
- **抽取(kb-build 阶段,`src/kb/`):** `ingestion-agent.ts` 旁新增/增强抽取 agent——从入选条目抽 event/entity/relation、embed、写结构化表。结构化 JSON + Zod 校验(守本仓不变量)。仍只入精选(`long_term_value >= floor`)。
- **接入 A1 车道:** kb-build 挂在 scan 车道尾部(逐条持续)或独立低频车道(成本决策),把 A1 判过的高价值条目结构化入库。
- **rerank 依赖:** 引入 OpenAI 兼容 rerank endpoint(`src/agents/llm-client.ts` 扩一个 rerank 调用),env 加 `RERANK_MODEL`(可选,缺省降级为纯向量)。

**DoD:**
- 入库条目产出 event/entity/relation 三元结构 + embedding。
- 一条多跳 SQL 能从某实体扩展到相关 event(冒烟:给定实体名 → 返回关联事件链)。
- 抽取失败按 per-item 隔离(不拖垮整批,守现有 `store.ts` 隔离范式)。

**出口闸:** KB 里能对一个真实体(如某模型名)做出有意义的多跳关联返回,不是孤立向量命中。

**显式不做:** 图数据库;把 SAG 的 Fastify/React workbench 搬进来;对话层(那是 A3)。

---

## Phase A3 — 对话流 RAG 推荐(纯读服务)

> **形态见 [`a3-conversational-rag.md`](./a3-conversational-rag.md)**(丙-1 双出口 / handler 契约 seam / 结构化诚实红线的完整定位与理由)。A3 = KB 之上的对话 RAG 面,**丙-1 双出口**:MCP 出口(`search_kb`)给**证据**(Claude 自己作答/路由/存档)、Web 出口(`/advisor`)给**答案**(自建 LLM 作答,作答代码只此一处)。走**单路 KB-RAG**,只答「是什么/发生了什么/背景」;选型/价格由 Model Radar 专管、经**确定性前置闸**挡在门外。

**目标:** KB 之上的对话式知识推荐面。**读侧边界:对 DOMAIN(KB / `ai_news_events` / `mr_*` / `ai_products`)只读,只读+写自有 `rag_conversations` 会话库**——"纯读"指不写**域事实**,服务拥有并读写自己的会话状态不破此界(钉死,防顺手往域库写)。

**关键改动:**
- **落点:** 挂现有 Hono app(`src/app.ts`),`src/rag/` 承 KB-RAG handler + Web `/advisor` 路由,与 Model Radar web 同进程 SSR/API——自用规模无需独立进程。
- **handler 契约 = 未来编排引擎 seam:** `handle(query, ctx) → { domain: 本域|非我域, answer, citations, trace, evidence: 有据|无据 }`——每条能力说同一套契约;未来编排引擎(组合 A3-KB-RAG / Model-Radar-选型 / get-today 的意图路由总入口)是**独立 phase**,站在契约上做薄组合(分类意图 → 选 handler,绝不碰 handler 内部),A3 只把契约铺好。
- **检索流(单跳):** query → **价格/选型确定性前置闸**(多字短语匹配 → 强制 `非我域`)→(多轮)**query-rewrite** 消歧(读回历史 condense 成独立检索句,失败降级用原问)→ 单跳 `searchKb`(事件域,只读)→ **证据阈值判无据** → OpenRouter LLM 带引用作答。A3 顺带压测 A2「单跳够不够」;SAG 多跳 / rerank / 经验卡延后。
- **诚实红线——结构化强制(非提示口头):** ① **引用由程序从本轮命中行构造**(LLM 只出散文 + `kb_id` 选择器;命中集外 / 低于 `RAG_MIN_COSINE` 的 id 丢弃,`source_url` 取命中行非 LLM,渲染校验 http(s) scheme)→ 注入结构上无法伪造引用 / 钓鱼 / XSS;② **证据阈值** `RAG_MIN_COSINE` 由 handler(非 `searchKb`)判「无据」(top-k 全低于阈值 → `answer=null`、不作答);③ **价格前置闸**强制 `非我域`(不靠 LLM 分类;价格 / 额度永走 Model Radar 权威源);④ **历史结构上不进作答载荷**(answer 签名只含 `rewrittenQuery` + 本轮 citations,旧答案永不作依据,防无据旧答自我强化)。
- **会话存档 + 多用户隔离谓词今就发:** 自有 `rag_conversations` 表(指针式,存命中 `kb_id` 不存 KB 拷贝);store/retrieval 签名今就带 `user_id`、读写今就带 `WHERE user_id`(本期恒 `'local'`),`conversation_id` 服务端生成、`turn` 服务端派生、`UNIQUE(user_id, conversation_id, turn)` 由 DB 约束——多用户 = 改**值**(接 CF Access 身份 claim)非改**代码路径**。
- **公开面安全 + 最小下限:** `/advisor` ingress 放行 + CF Access 必填 + **in-app CF JWT 校验**(`hono/jwk` 配 CF `jwks_uri`、pin RS256、JWKS fail-closed)作直连兜底承重层;`RAG_MAX_QUERY_CHARS` 输入上限 + `RAG_DAILY_LLM_CALL_CAP` 每日调用上限(Redis 计数,越限或 Redis 不可用均 fail-closed)作公开端点成本地板;渲染一律转义、绝不 `dangerouslySetInnerHTML` LLM 输出。

**DoD:**
- 就一个真实「是什么 / 发生了什么」问题返回**有 KB 依据、带引用**的回答;拿不准 / 无据时诚实降级(「无据」),不编。
- 服务侧对 DOMAIN 表**只读**(仅读写自有 `rag_conversations`);跑对话后 DOMAIN 零变化、仅会话表增行。
- 注入「引用 kb_id=999 / 无视指令」结构上无法伪造引用;价格问被前置闸挡为 `非我域`。

**出口闸:** 你日常开始**去问它**(pull 型日常价值成立),回答比翻日报更快解决「这是什么 / 发生了什么」。

**显式不做:** 编排引擎(未来独立 phase);SAG 多跳(A2b)/ 经验卡检索 / 更专业 RAG 栈;多用户身份逻辑(只留 seam + 隔离谓词);选型 / 价格作答(Model Radar 专管);流式作答;写任何域库;A3 独立进程。

---

## Phase A4 — 日报降级

**目标:** 高频扫描 + P0 即时推在位后,把每日 digest 降级成 inbox-P2/P3 式**集合批量推**——功能变轻,不再是"当日精选成稿"。**大体是减法。**

**关键改动:**
- `src/pipeline/run-daily-workflow.ts`:把"当日集合"重定义为"这段时间入 KB / 判过、且**未被 P0 推过**的条目"(`computePendingSet` 已天然排除 ever-pushed)。
- **减/轻**重写稿阶段:Chinese digest 逐条写稿(`src/agents/digest/`)、product segment(`src/pipeline/product-digest.ts`)、experience mining(`src/pipeline/experience-chain.ts`)在日报路径**下线或大幅调轻**——高价值展开now 活在 KB/RAG,不在推送。**代码不删、改路由**(留作可复用)。
- `push_date` 幂等结构、单实例锁**保留不动**。

**DoD:**
- 每日一条轻量集合推,只含未即时推过的条目,不与 P0 重叠。
- 降级后 LLM 成本明显下降(日报不再逐条重写稿)。
- 幂等回归:P0 即时推 + 当日集合推,同一条目全局只出现一次。

**出口闸:** 你**不再依赖日报**获取高价值信息(那条路 P0 已接管),日报退化为"扫一眼有没有漏"的低频兜底,你也不觉得可惜。

**显式不做:** 删掉写稿能力(只改路由,RAG 可能复用);动幂等/锁结构。

---

## Phase M — re-host 到 hangar(唯一被 hangar 闸住)

**闸(两条都满足才开工):** ① hangar inbox Phase-1 出口通过(连续 7 天每天用);② hangar monitor 的 emit 契约落地。

**目标:** 把 A0–A4 验证过的系统整体 re-host 成 hangar pilot,**业务逻辑零改**(A0 的 seam 已就位),只换驱动 + 拆 app。

**关键改动:**
- 三个 pilot 的 `app.yaml` + `src/pipeline.ts`(`run(ctx)` 按 `ctx.trigger` switch):
  - `radar`:scan(高频)+ digest(每日降级),两个具名触发器。
  - `model-radar`:MR 保鲜/抓取车道(现状基本就绪,默认关);curation 人审**暂留 bespoke Telegram**(方案 iii)。
- 删胶水:`worker-main.ts` / `schedule*` / `buildConnection` / BullMQ worker wrapper。cron 挪进 `app.yaml`。`acquireDigestLock` 由 hangar run-lock 归并(可删)。
- `ctx.emit` 形状对齐 hangar monitor 契约(把 A0 的粗粒度事件细化到契约)。
- **compose 改写(仅 worker 片):** worker 容器 → `hangar daemon` 容器 + `HANGAR_APPS/{ai-radar,model-radar}` checkout(编出 `dist/pipeline.js`);**web / mcp / browser-worker / RAG / postgres / redis / cloudflared 容器不动**。参考 memory `deployment-containerized`。
- 读侧(RAG / Model Radar web / MCP / curation bot)保持独立常驻,DB 为界,**不迁**。

**DoD:**
- hangar host 上按 cron 跑 `radar`(高频 scan + 每日 digest)与 `model-radar`,`hangar status/trace` 看得到 run-chain。
- 与旧 worker **并行跑 1–2 周**,P0/日报/KB 产出与幂等逐条对平(parity)。
- `@hangar/core` 里没有一行为 ai-radar / MR 特化的域代码(守 hangar #1/#2)。

**出口闸:** hangar 托两个 pilot,产出不比旧栈差、你信 KB 新鲜,且不想切回旧 worker → 旧 worker 下线。

**显式不做:** 迁读侧常驻面;把 curation 接 hangar Approval(留待"真感到痛"→ 上位文档 §6 方案 i);为 ai-radar 特化脊柱。

---

## 风险与挂账(承接上位文档 §6)

- **A1 的 LLM 成本**:高频 judge 是主成本;预筛 + judge/collect 分频节流兜底(实现期定)。
- **A2 rerank 依赖**:新增 OpenAI 兼容 rerank endpoint;缺省降级纯向量,别让它成硬依赖。
- **emit 契约漂移**:A0–A4 用粗粒度自定义事件,M 阶段对齐 hangar monitor——保持 kind 少而稳,减少对齐成本。
- **curation 粒度**:全程走 bespoke Telegram 逐条批;hangar approve 单条粒度(方案 i)留到真痛。
- **每 Phase 独立可交付、可回滚**:任一 Phase 未过闸不进下一个;A4 降级前务必确认 A1 的 P0 已被信任(否则先降级 = 自断高价值路径)。
