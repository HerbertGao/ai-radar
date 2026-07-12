# A3 对话流 RAG — 产品形态决策

> **状态:** 定位定稿 · 未开工（提案 `add-conversational-rag`）
> **日期:** 2026-07-11
> **上位文档:** [`hangar-migration-plan-a.md`](./hangar-migration-plan-a.md) Phase A3；[`hangar-migration.md`](./hangar-migration.md)（读写分离迁移边界）
> **一句话:** A3 = KB 之上的**对话 RAG 面**，双出口（MCP 给证据 / Web 给答案），单路 KB-RAG + handler 契约 seam，**故意多建一点先把坑踩出来**，为将来产品级化少踩坑。

本文记录 2026-07-11 一场 grilling 锁定的 A3 产品形态与理由，是 `add-conversational-rag` 提案的定位前置（先定形态再写 spec）。

## 定性（先说清楚这是什么）

**A3 不是一个"取舍后的精简产品"，是"先踩坑的第一版"。** 刻意把会话存档 / 多轮 / 多用户 seam / 历史即信号这些坑先踩出来，RAG 内核的深度优化（历史喂多少、成本上限、检索栈是否换成更专业 RAG）留给未来专业化迭代。故本期评审/设计的取舍标准是"**把关键坑摊出来 + 守住不变量**"，而非"最小可用"。

## 界面：丙-1（双出口，作答只在 Web 一处）

```
              共享检索+作答核心  src/rag/（对 DOMAIN 只读）
              ┌────────────────────────────────────────────────┐
              │ KB-RAG handler（实现 handler 契约 = 未来引擎 seam）│
              │  ①（多轮）query-rewrite: 会话历史+追问 → 独立检索句 │
              │  ② searchKb 单跳检索（事件域）→ grounded 证据       │
              │  ③ OpenRouter LLM 作答 → {domain, answer|无据,      │
              │                          citations, trace}        │
              └──────────────────────┬─────────────────────────┘
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                        ▼
  MCP 出口（自用）                                        Web 出口（演示·本期重心）
  search_kb 工具 = 暴露 searchKb **证据**                 /advisor 多轮 chat 页
  （A2 里"延到 A3"那块接上）                               本地建 + CF Tunnel + CF Access
  Claude 自己作答/路由/存档（编排引擎=你的 Claude）          服务端会话存档 + 带引用作答
```

**为何丙-1（不是"两边都烤答案"、也不是"造独立聊天产品"）：**
- **自用侧的对话流/多轮/存档/意图路由，Claude 全免费给。** 你天天在 Claude 里，问 `search_kb` 得证据、Claude 作答，多轮和对话存档是它 UI 白送的。MCP 出口只需暴露**证据**（不预烤答案——预烤会把 Claude 能对原始证据再推理的强项做废）。
- **Web 出口是演示脸**（给别人看），它没有外部 LLM，才需要自建 LLM 作答——**作答代码只此一处**。
- 造一个独立聊天产品 = 重复 Claude 已做得更好的事。

## 身份：单路 KB-RAG + 契约 seam，编排引擎当未来 phase

- **"留好路子"留的是契约、不是路由器组件。** 让未来编排引擎低成本插入的，是每条能力都说同一套 **handler 契约** `{domain, answer, citations, trace, evidence}`。A3 的 KB-RAG 先实现它；Model Radar recommender（已有 `recommend`+`explain`+`insufficient_data`）将来贴适配即说这套话；编排引擎 = 薄组合器，分类意图 → 选 handler → 组合，**绝不碰 handler 内部**（同 A0 `run(ctx)`：seam 在、驱动换）。
- **A3 走单路 Q**：只做 KB-RAG 这一路 + Web 薄作答；编排引擎/Model Radar handoff/get-today 是被组合的既有能力，**未来独立 phase** 做，不塞进 A3 web。

## 边界（钉死）：纯读 = 不写域事实，非不写任何东西

```
   A3 对 DOMAIN（KB / ai_news_events / mr_* / ai_products）  → 只读
   A3 对自己的 rag_conversations                            → 读+写（服务自有状态）
```
服务端存会话**不破**"读侧纯读"——迁移边界是"读侧不写**域事实**"（那是写侧 pilot 的地盘），A3 拥有并读写自己的会话库是服务自有状态，不碰域库。**此条须写进提案钉死**，防将来有人顺手让 A3 往 KB 写东西塌了纯读。

## 多用户：本期单用户，预留 seam

- **本期只做单用户**（不做 CF Access 身份逻辑 / 不做 per-user 隔离的实现）。
- 但**预留多用户 seam**：会话表带 `user_id` 列、检索口径按"可加 per-user WHERE"设计。未来多用户 = 靠 DB 记录每条问答归属、按用户级隔离 RAG 检索，届时把 CF Access 身份接进 `user_id` 即可，不重写。

## 会话 schema（指针式、可挖掘）

每轮存：`user_id`（预留）· `conversation_id` · `turn` · 原问 · `rewritten_query` · 命中 `kb_id[]`（**指针，不存 KB 正文拷贝**——KB 是唯一真相）· `answer` · `evidence`（有据/无据）· `model` · `ts`。存够"未来据以往对话做二次深入推荐"能挖出信号，但不存成 PII 黑洞、不存 KB 拷贝。

## 诚实红线（钉死）

- **历史只作信号，绝不进证据链。** 过去对话进 query-rewrite / 个性化，**当前答案的依据永远是本轮 KB citations**——绝不把"上次的答案"当依据（否则一个无据的旧答会自我强化、越滚越歪，这是 RAG 记忆最经典的坑）。
- **拿不准 / 无据 → 说"无据"、绝不编。**
- **价格/额度永远走 Model Radar 权威源、绝不经 KB 模糊检索兜**（守 `QA.md` 诚实红线；A3 单路只答"是什么/背景"，选型 handoff 是未来引擎的事）。

## 检索 / LLM / 部署

- **检索**：单跳 `searchKb`（事件域）——A3 顺带当 A2「单跳够不够」的真实压力场；SAG 多跳 / 经验卡 / 更专业 RAG 化延后。
- **LLM**：OpenRouter 经现有 `src/agents/llm-client.ts`（`buildModel`）。
- **部署**：Web 本地建 + Cloudflare Tunnel 暴露 + CF Access 边缘鉴权（gate + 成本收口，参考 hangar 前端形态）；挂现有 Hono app（`src/app.ts`，与 Model Radar web 同进程），复用 `src/mr/web` 的 TSX/SSR 渲染范式。

## 非目标（提案写死）

编排引擎（组合 A3/Model Radar/get-today handler，未来独立 phase）· SAG 多跳（A2b）· 经验卡检索 · 多用户身份逻辑（只留 seam）· 历史喂多少上下文 / 成本上限（等更专业 RAG 化定、可能换栈）· 选型/价格作答（Model Radar 专管）· 写任何域库 · A3 独立进程（挂现有 Hono app）。

## 与后续 phase 的关系

- **A3 依赖 A2**（`searchKb` 已 ship）；A3 的检索质量顺带压测 A2「单跳够不够」，喂回 A2b（SAG）要不要建的决策。
- **未来「编排引擎」phase**：站在 handler 契约上组合 A3-KB-RAG / Model-Radar-选型 / get-today，做真正的"问 AI 圈任何事"总入口——本文的契约 + 单路 + Web-only-作答就是给它铺的路。
