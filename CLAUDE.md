# CLAUDE.md

本文件给 Claude Code / Codex 等 AI Coding Agent 在本仓库工作时使用。

## 事实来源（按权威性排序）

1. **[`QA.md`](./QA.md)** — 完整需求与设计的权威文档。任何冲突以它为准。
2. **[`openspec/config.yaml`](./openspec/config.yaml)** — 浓缩的项目上下文、技术栈与关键不变量，OpenSpec 创建工件时会自动注入；视为 SOT，先读它再动手。
3. **[`README.md`](./README.md)** — 面向人的项目概览（含工作流程图）。
4. **[`ROADMAP.md`](./ROADMAP.md)** — 分期排期计划、各期退出标准与风险。

> 不要把 `QA.md` 的内容复制进本文件。需要细节时直接读上述文件。

> ⚠️ **技术栈例外**：`QA.md` 对需求/架构/数据模型/不变量权威,但**语言与框架选型以 `config.yaml` 为准**。本项目主应用用 **TypeScript**(Node + Hono + Drizzle + pgvector + Vercel AI SDK/Zod + BullMQ + grammY + MCP TS SDK),**不用 Python、不用 LangGraph**。看到 QA.md 里的 Python/FastAPI/LangGraph/Alembic 默认时不要照搬,理由见 `config.yaml` 的“技术栈决策记录”。

## 项目一句话

ai-radar = **AI 行业情报流水线 + AI 工具选型顾问**，不是“新闻聚合 Agent”。

## 不可违背的架构原则

确定性工作流 + 数据库状态 + Agent 语义判断 + RAG 证据检索。

- 不做“全 Agent 自治流”。
- 去重、推送状态、幂等、唯一约束由**程序和数据库**保障，**绝不**交给 LLM 判断。
- Workflow 控流程 / DB 控事实与状态 / Agent 控语义 / RAG 控证据 / MCP 控外部访问 / Push Dispatcher 控幂等。
- 所有 Agent 输出必须是结构化 JSON 并做 schema 校验。
- 所有外部 API 调用必须有重试与错误日志。

## 写代码 / 评审前必须守住的不变量

- 推送幂等：`UNIQUE(target_type, target_id, channel, push_date)`；先写 `pending`，唯一键冲突即跳过，成功置 `success`，失败置 `failed`。
- 分层去重：硬去重 → `title_hash` → embedding 相似度 → LLM → DB 唯一约束兜底。
- URL 规范化移除 `utm/ref/gclid/fbclid/spm` 等追踪参数。
- 知识库只入精选（`long_term_value >= 70`），不入原文 / 转载 / 营销稿。
- 推荐：规则保“不离谱”、RAG 保“有依据”、LLM 保“讲明白”、DB 保“事实”。

完整不变量、数据模型 DDL、去重分层、评分规则、测试用例见 `QA.md`。

## 工作流

本仓库使用 **OpenSpec（spec-driven）**。新增能力走提案流程：`/opsx:propose` → `/opsx:apply` → `/opsx:archive`。提案需对齐 `QA.md` 定位并包含“非目标”。

## 工具调用约定

- GitHub CLI 一律用 `\gh`（反斜杠前缀），不要用裸 `gh`。
- 中文为主要书写语言。
