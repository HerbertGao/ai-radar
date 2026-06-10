# AI 情报聚合与 AI 工具选型顾问系统需求说明

> 目标：构建一个可长期运行的 AI 相关信息聚合、去重、价值判断、中文摘要、飞书/Telegram 推送、知识库沉淀与后续 AI 工具选型问答系统。
>
> 本文适合直接交给 Claude Code、Codex 或其他 AI Coding Agent 作为项目实践说明。

---

## 1. 项目背景

用户希望构建一个 AI 相关的新闻/产品/工具情报系统，核心需求不是单纯“新闻聚合”，而是：

- 聚合国内外 AI 新闻、技术动态、产品推荐、开源项目、论文与工具更新。
- 支持飞书和 Telegram 推送。
- 针对历史信息去重。
- 当天推送内容不允许重复。
- 后续能够纳入知识库，支持历史查询。
- 未来扩展为“AI 工具选型顾问”，例如回答：
  - “我想做一个内部知识库，用哪个 AI 工具更好？”
  - “我想做 Text2SQL 智能报表，用什么技术栈？”
  - “我想做商品规格归一化比价系统，用 Agent 还是传统规则？”
  - “我想做某某某工作，用哪个 AI 工具更合适？”

---

## 2. 对现成开源产品的判断

### 2.1 TrendRadar

TrendRadar 可以作为参考或早期底座，但不建议完全依赖。

优点：

- 支持 RSS、热点源、AI 分析、AI 翻译。
- 支持飞书、Telegram 等多渠道推送。
- 支持 MCP。
- 有一定去重能力。

问题：

- 默认来源更偏国内热点平台。
- 对国外 AI 产品发现、Product Hunt、GitHub、Hacker News、Reddit、arXiv 等源支持不一定充分。
- 对“AI 产品实体去重”“跨来源产品合并”“工具推荐评分”支持不足。
- 更像信息聚合工具，不是完整的 AI 情报平台。

结论：

- 可以参考其推送、RSS、MCP、调度实现。
- 不建议把核心数据模型和推荐逻辑绑死在 TrendRadar 上。

### 2.2 hot_news_daily_push

适合快速做热点新闻推送，但默认去重偏弱。

问题：

- 更像每日热点摘要。
- 去重多基于标题或简单规则。
- 难以支持复杂的 AI 产品实体库和跨源合并。

结论：

- 可参考推送和日报格式。
- 不建议作为长期系统核心。

### 2.3 RSS-to-Telegram-Bot / ProductHuntTelegramBot

适合单一功能参考：

- RSS-to-Telegram-Bot：适合 RSS → Telegram。
- ProductHuntTelegramBot：适合 Product Hunt → Telegram。

结论：

- 可参考具体 Collector 或推送实现。
- 不适合作为完整 AI 情报系统。

---

## 3. 核心设计原则

### 3.1 不要做成“全 Agent 自治流”

错误方向：

```text
采集 Agent
→ 去重 Agent
→ 判断 Agent
→ 翻译 Agent
→ 推送 Agent
→ 知识库 Agent
```

问题：

- Agent 不适合负责确定性状态。
- 去重不能只靠模型判断。
- 推送不能只靠模型记忆。
- 失败重试、幂等、唯一约束必须由程序和数据库保障。

推荐方向：

```text
确定性工作流 + 数据库状态 + Agent 语义判断 + 知识库/RAG 查询
```

即：

- 数据库决定事实。
- 唯一索引决定是否重复。
- 程序负责幂等、重试、状态流转。
- LLM/Agent 负责分类、摘要、价值判断、推荐解释。

---

## 4. 推荐总体架构

```text
Scheduler / Workflow Engine
  ↓
Collectors
  ├── RSS Collector
  ├── GitHub Collector
  ├── Product Hunt Collector
  ├── Hacker News Collector
  ├── Reddit Collector
  ├── arXiv Collector
  ├── Hugging Face Collector
  └── Official Blog Collector
  ↓
Normalizer
  ↓
Dedup Service
  ↓
Value Judge Agent
  ↓
Chinese Digest Agent
  ↓
Push Dispatcher
  ├── Feishu Bot
  └── Telegram Bot
  ↓
Knowledge Base Ingestion
  ↓
MCP / API / Chat Query
```

---

## 5. 推荐技术栈对比

### 5.1 长期推荐技术栈

```text
LangGraph
+ PostgreSQL / pgvector
+ FastAPI
+ Celery / APScheduler
+ Dify 或 RAGFlow
+ Telegram Bot API
+ 飞书 Bot Webhook
+ MCP Server
```

适合长期做成自己的 AI Radar 和 AI 工具选型顾问。

优点：

- 流程可控。
- 去重可靠。
- 状态可恢复。
- 推送幂等容易实现。
- 产品实体库、任务模式库、推荐系统都能自己掌控。
- Dify/RAGFlow 可替换，不锁死。

### 5.2 快速 MVP 技术栈

```text
n8n
+ PostgreSQL
+ Dify
+ Telegram / 飞书 Webhook
+ OpenAI / Claude / DeepSeek API
```

适合快速验证：

- 信息源是否可用。
- 推送格式是否合适。
- 中文摘要质量是否可接受。
- 去重规则是否基本有效。

缺点：

- 复杂语义去重会越来越难维护。
- 产品实体合并会变成复杂节点流。
- 长期可能变成“节点意大利面”。

### 5.3 可视化 Agent 技术栈

```text
Flowise
+ PostgreSQL
+ Dify
+ Telegram / Feishu
```

适合：

- 可视化搭建 Agent / Workflow。
- 做 demo 和原型。

不适合：

- 严格幂等。
- 复杂产品实体库。
- 长期推荐评分系统。

### 5.4 RAG/知识库重型技术栈

```text
Haystack 或 LlamaIndex
+ PostgreSQL / pgvector / Qdrant
+ Dify 或 RAGFlow
```

适合：

- 长文档检索。
- AI 白皮书、论文、报告入库。
- 多文档问答。
- 工具文档对比。

### 5.5 企业级 Agent 技术栈

```text
Microsoft Agent Framework / AutoGen
+ Azure / PostgreSQL / Vector DB
```

适合：

- 企业内部系统。
- 微软生态。
- .NET/Python 混合。
- 需要更强遥测、类型约束和治理能力。

---

## 6. 最终推荐路线

### 第一阶段：MVP

目标：先跑起来。

推荐：

```text
n8n 或 APScheduler
+ PostgreSQL
+ Telegram / 飞书
+ Dify
```

实现：

- 采集 RSS、GitHub、Product Hunt、HN 等信息。
- 入库。
- 做基础去重。
- 使用 LLM 判断价值。
- 生成中文摘要。
- 每日推送 Top N。
- 精选内容入 Dify 知识库。

### 第二阶段：抽核心服务

推荐：

```text
LangGraph
+ PostgreSQL / pgvector
+ FastAPI
```

抽出：

- 去重服务。
- 价值评分服务。
- 产品实体合并。
- 推送幂等。
- 推荐逻辑。

### 第三阶段：AI 工具选型顾问

新增：

- AI 工具产品库。
- 任务模式库。
- 工具能力评分。
- 工具更新记录。
- 推荐日志。
- MCP 查询接口。

---

## 7. 信息源设计

### 7.1 官方 AI 新闻源

优先级最高，可信度高，适合进入重要新闻。

建议来源：

- OpenAI Blog / News
- Anthropic News
- Google DeepMind Blog
- Meta AI Blog
- Microsoft AI Blog / Azure AI Blog
- Hugging Face Blog
- Mistral AI News
- xAI Blog / Docs / Changelog
- Perplexity Blog
- GitHub Blog / Changelog

### 7.2 技术社区源

适合发现程序员圈热点。

建议来源：

- Hacker News
- Lobsters
- Reddit r/LocalLLaMA
- Reddit r/MachineLearning
- Reddit r/ChatGPT
- GitHub Trending
- GitHub Search API
- arXiv cs.AI / cs.CL / cs.LG
- Papers with Code
- Hugging Face Papers

### 7.3 AI 产品发现源

这是本项目的关键增量。

建议来源：

- Product Hunt
- There’s An AI For That
- Futurepedia
- AlternativeTo
- SaaSHub
- GitHub Trending
- Indie Hackers
- BetaList
- Hacker News Show HN
- Reddit r/SideProject
- Reddit r/SaaS

---

## 8. 数据模型设计

### 8.1 原始信息表 raw_items

用于保存每个来源抓到的原始内容。

```sql
CREATE TABLE raw_items (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(64) NOT NULL,
  source_item_id VARCHAR(255),
  raw_type VARCHAR(64), -- news/product/repo/paper/post
  url TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  content TEXT,
  author VARCHAR(255),
  published_at TIMESTAMP,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  metadata JSONB,
  UNIQUE(source, source_item_id)
);
```

### 8.2 新闻事件表 ai_news_events

用于合并同一事件的多来源报道。

```sql
CREATE TABLE ai_news_events (
  event_id VARCHAR(128) PRIMARY KEY,
  event_type VARCHAR(64),
  representative_title TEXT,
  summary_zh TEXT,
  main_entities JSONB,
  first_seen_at TIMESTAMP,
  last_seen_at TIMESTAMP,
  source_count INT DEFAULT 1,
  importance_score NUMERIC(5,2),
  novelty_score NUMERIC(5,2),
  developer_relevance_score NUMERIC(5,2),
  hype_risk_score NUMERIC(5,2),
  should_push BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 8.3 AI 产品表 ai_products

用于长期沉淀 AI 产品实体。

```sql
CREATE TABLE ai_products (
  product_id VARCHAR(128) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  normalized_name VARCHAR(255),
  vendor VARCHAR(255),
  official_url TEXT,
  canonical_domain VARCHAR(255),
  github_repo VARCHAR(255),
  product_hunt_slug VARCHAR(255),
  category VARCHAR(64),
  subcategory VARCHAR(64),
  description TEXT,
  pricing_model VARCHAR(64),
  open_source BOOLEAN,
  local_deployable BOOLEAN,
  api_available BOOLEAN,
  mcp_supported BOOLEAN,
  first_seen_at TIMESTAMP,
  last_seen_at TIMESTAMP,
  last_pushed_at TIMESTAMP,
  score NUMERIC(5,2),
  metadata JSONB,
  UNIQUE(canonical_domain),
  UNIQUE(github_repo),
  UNIQUE(product_hunt_slug)
);
```

### 8.4 原始信息与事件关系表

```sql
CREATE TABLE item_event_relations (
  raw_item_id BIGINT REFERENCES raw_items(id),
  event_id VARCHAR(128) REFERENCES ai_news_events(event_id),
  relation_type VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY(raw_item_id, event_id)
);
```

### 8.5 原始信息与产品关系表

```sql
CREATE TABLE item_product_relations (
  raw_item_id BIGINT REFERENCES raw_items(id),
  product_id VARCHAR(128) REFERENCES ai_products(product_id),
  relation_type VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY(raw_item_id, product_id)
);
```

### 8.6 推送记录表 push_records

这是保障“当天不重复推送”的核心。

```sql
CREATE TABLE push_records (
  id BIGSERIAL PRIMARY KEY,
  target_type VARCHAR(32) NOT NULL, -- event/product/paper/repo
  target_id VARCHAR(128) NOT NULL,
  channel VARCHAR(32) NOT NULL, -- telegram/feishu
  push_date DATE NOT NULL,
  pushed_at TIMESTAMP,
  status VARCHAR(32) NOT NULL, -- pending/success/failed/skipped
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(target_type, target_id, channel, push_date)
);
```

### 8.7 知识库入库记录表

```sql
CREATE TABLE kb_ingestion_records (
  id BIGSERIAL PRIMARY KEY,
  target_type VARCHAR(32) NOT NULL,
  target_id VARCHAR(128) NOT NULL,
  kb_provider VARCHAR(64) NOT NULL, -- dify/ragflow/custom
  kb_document_id VARCHAR(255),
  status VARCHAR(32) NOT NULL,
  ingested_at TIMESTAMP,
  error_message TEXT,
  UNIQUE(target_type, target_id, kb_provider)
);
```

### 8.8 AI 工具能力表 ai_tools

用于未来“AI 工具选型顾问”。

```sql
CREATE TABLE ai_tools (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  vendor VARCHAR(128),
  official_url TEXT,
  category VARCHAR(64),
  subcategory VARCHAR(64),
  pricing_model VARCHAR(64),
  open_source BOOLEAN,
  local_deployable BOOLEAN,
  api_available BOOLEAN,
  mcp_supported BOOLEAN,
  coding_strength INT,
  writing_strength INT,
  research_strength INT,
  automation_strength INT,
  rag_strength INT,
  chinese_quality INT,
  learning_curve INT,
  cost_level INT,
  last_verified_at TIMESTAMP,
  metadata JSONB
);
```

### 8.9 任务模式库 task_patterns

```sql
CREATE TABLE task_patterns (
  id BIGSERIAL PRIMARY KEY,
  task_name VARCHAR(128) NOT NULL,
  task_type VARCHAR(64),
  required_capabilities JSONB,
  nice_to_have JSONB,
  avoid_tools JSONB,
  examples TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## 9. 去重策略

### 9.1 去重目标

需要同时解决：

- 同一 URL 重复。
- RSS guid 重复。
- 同一标题重复。
- 标题不同但同一事件。
- 中文/英文报道同一事件。
- 同一产品在 Product Hunt、GitHub、HN、Reddit 多次出现。
- 同一天同一事件/产品不能重复推送。

### 9.2 分层去重

第一层：硬去重。

```text
source + guid
canonical_url
github_repo
product_hunt_slug
canonical_domain
```

第二层：标题归一化。

处理：

- 小写化。
- 去标点。
- 去 emoji。
- 去站点名。
- 去 utm/ref/spm 等追踪参数。
- 繁简转换。
- 去除“快讯”“重磅”“刚刚”等噪声词。

生成：

```text
title_hash = sha256(normalized_title)
```

第三层：embedding 相似度。

对以下内容生成 embedding：

```text
title + summary + key_entities
```

判断建议：

```text
cosine_similarity > 0.88：高度疑似重复
cosine_similarity > 0.82：交给 LLM 二次判断
```

第四层：LLM 判断。

要求模型输出结构化 JSON：

```json
{
  "same_event": true,
  "same_product": false,
  "reason": "Both items describe the same OpenAI model release."
}
```

第五层：数据库唯一约束兜底。

尤其是：

```sql
UNIQUE(target_type, target_id, channel, push_date)
```

---

## 10. Agent 分工

### 10.1 Collector

不建议用 Agent 自由采集，应该用确定性程序。

职责：

- RSS 拉取。
- GitHub API。
- Product Hunt。
- Hacker News API。
- Reddit API。
- arXiv。
- Hugging Face。
- 官方 Blog。

输出统一结构：

```json
{
  "source": "product_hunt",
  "source_item_id": "xxx",
  "url": "https://...",
  "title": "...",
  "content": "...",
  "published_at": "...",
  "raw_type": "product"
}
```

### 10.2 Normalizer

主要使用程序，必要时用 LLM 辅助。

职责：

- URL 清洗。
- 标题清洗。
- 正文抽取。
- 语言检测。
- 发布时间标准化。
- 基础实体提取。

### 10.3 Dedup Service

规则 + embedding + LLM。

职责：

- 判断是否重复新闻。
- 判断是否同一产品。
- 合并事件。
- 维护产品实体。

### 10.4 Value Judge Agent

这是最适合 LLM 的部分。

职责：

- 判断是否 AI 相关。
- 判断类型：新闻、产品、论文、开源项目、工具更新。
- 判断是否值得推送。
- 判断对开发者是否有价值。
- 判断是否只是套壳产品。
- 判断是否属于重点分类。

输出 JSON 示例：

```json
{
  "is_ai_related": true,
  "type": "ai_product",
  "category": "AI Coding",
  "importance": 82,
  "novelty": 75,
  "developer_relevance": 90,
  "hype_risk": 35,
  "should_push": true,
  "reason": "A new open-source coding agent with GitHub integration and local execution support."
}
```

### 10.5 Chinese Digest Agent

职责：

- 中文标题。
- 中文摘要。
- 价值说明。
- 风险/槽点。
- 适合人群。
- 来源汇总。

推送模板：

```text
【AI Coding】项目名 / 新闻标题

一句话：
xxx

为什么值得看：
xxx

适合：
开发者 / 企业 / 产品经理

风险：
可能只是套壳 / 暂无开源 / 定价未知

来源：
Product Hunt / GitHub / HN
```

### 10.6 Push Dispatcher

不建议用 Agent。

职责：

- 飞书格式化。
- Telegram Markdown/HTML 格式化。
- 消息分片。
- 限流。
- 失败重试。
- 写入 push_records。
- 保证幂等。

### 10.7 Knowledge Ingestion Agent

可用 LLM 生成入库元数据，但实际入库由程序执行。

职责：

- 生成知识库标题。
- 生成结构化摘要。
- 生成标签。
- 抽取实体。
- 判断长期价值。

输出 JSON 示例：

```json
{
  "kb_title": "OpenAI 发布新一代模型",
  "summary_zh": "...",
  "tags": ["OpenAI", "LLM", "API"],
  "entities": ["OpenAI", "GPT"],
  "canonical_url": "https://...",
  "source_urls": ["https://..."],
  "event_date": "2026-06-10",
  "long_term_value": 78
}
```

只把长期价值较高的内容写入知识库，例如：

```text
long_term_value >= 70
```

---

## 11. 价值评分规则

### 11.1 新闻/事件评分

建议维度：

- importance：行业重要性。
- novelty：新颖程度。
- developer_relevance：对开发者价值。
- source_quality：来源质量。
- multi_source_signal：多来源共振。
- hype_risk：炒作风险。

建议推送条件：

```text
importance >= 75
或 developer_relevance >= 80
或 multi_source_signal >= 2
或 category 属于重点关注范围
```

重点关注分类：

- AI Coding
- Agent
- MCP
- RAG
- LLM Infra
- Local LLM
- AI Search
- Text2SQL
- Workflow Automation

### 11.2 AI 产品评分

硬规则示例：

| 指标 | 分数 |
|---|---:|
| GitHub stars 24h 增长快 | +15 |
| 有明确开源仓库 | +10 |
| 有 demo / docs | +10 |
| Product Hunt 排名前 10 | +10 |
| HN 讨论热度高 | +10 |
| 被多个来源同时提到 | +20 |
| 明确解决开发者痛点 | +10 |
| 只是 ChatGPT Wrapper | -20 |
| 官网无价格/无 demo/只有 waitlist | -10 |
| 夸张营销词过多 | -10 |

LLM 输出：

```json
{
  "is_ai_product": true,
  "category": "AI Coding",
  "novelty_score": 78,
  "usefulness_score": 82,
  "hype_risk_score": 35,
  "should_push": true,
  "reason": "It provides a local-first coding agent workflow with GitHub integration."
}
```

---

## 12. 推送策略

### 12.1 推送类型

| 类型 | 频率 | 内容 |
|---|---|---|
| 即时重要新闻 | 实时/半小时 | OpenAI、Anthropic、Google、Meta 等重大发布 |
| 每日 AI 产品发现 | 每天 1 次 | 3～8 个新产品/开源项目 |
| 每日 AI 新闻摘要 | 每天 1 次 | 5～10 条精选新闻 |
| 每周趋势总结 | 每周 1 次 | 技术趋势、工具变化、值得关注项目 |

### 12.2 推送幂等

必须做到：

```text
同一个 target_type
同一个 target_id
同一个 channel
同一个 push_date
只能推送一次
```

通过数据库唯一约束保证：

```sql
UNIQUE(target_type, target_id, channel, push_date)
```

推送流程：

```text
1. 生成候选推送内容
2. 尝试插入 push_records，status=pending
3. 如果唯一键冲突，跳过
4. 调用飞书/Telegram API
5. 成功后 status=success
6. 失败后 status=failed，保留错误信息，可重试
```

---

## 13. 知识库设计

### 13.1 知识库不是垃圾桶

不应该把所有 raw_items 都写入知识库。

应该入库：

- 高价值新闻摘要。
- 重要 AI 产品卡片。
- 周报/月报。
- 技术趋势总结。
- 重要官方发布。
- 重要论文和报告。

不应该入库：

- 每条 RSS 原文。
- 重复转载。
- 低价值营销稿。
- 纯标题党。
- 低质量社交媒体噪声。

### 13.2 Dify / RAGFlow 使用建议

Dify 适合：

- 知识库 API 入库。
- Chat 查询前台。
- 简单工作流。
- AI 工具问答应用。

RAGFlow 适合：

- PDF。
- 白皮书。
- 论文。
- 技术报告。
- 长文档解析。

推荐：

```text
短新闻/产品卡片：Dify 或自建 pgvector
长文档/报告/PDF：RAGFlow
核心事实和状态：PostgreSQL
```

---

## 14. MCP 设计

MCP 不建议参与主流程调度，而是作为查询和人工干预入口。

建议暴露工具：

```text
get_today_ai_digest
search_ai_events
search_ai_products
mark_product_interesting
mark_event_not_relevant
push_event_now
get_source_quality_report
recommend_ai_tools_for_task
```

未来可以在 Claude Desktop、Cursor、Codex、ChatGPT 等环境里查询：

```text
今天有哪些 AI Coding 工具有价值？
最近一周 MCP 相关项目有哪些？
某个产品之前推过没有？
这个 GitHub 项目为什么被判定为高价值？
我想做内部知识库，用 Dify、RAGFlow、FastGPT 哪个更合适？
```

---

## 15. AI 工具选型顾问设计

### 15.1 不能只靠 RAG

未来的“我想做某某工作，用哪个 AI 工具更好”不能只靠向量搜索。

需要：

```text
结构化产品库
+ 任务模式库
+ 推荐规则
+ RAG 证据
+ LLM 解释
```

### 15.2 推荐流程

```text
用户需求解析
→ 任务类型识别
→ 硬条件过滤
→ 候选工具召回
→ RAG 补充证据
→ 工具评分
→ LLM 生成推荐理由
→ 输出排序、取舍和落地建议
```

### 15.3 推荐输出格式

```text
你的任务：xxx
关键要求：xxx

首选：A
理由：
- xxx
- xxx

备选：B
适合在 xxx 情况下使用

不建议：C
原因：xxx

推荐组合：
A + B + C

落地步骤：
1. xxx
2. xxx
3. xxx
```

### 15.4 推荐逻辑原则

- 规则筛选负责“不离谱”。
- RAG 负责“有依据”。
- LLM 负责“讲明白”。
- 数据库负责“事实和状态”。

不要让 LLM 直接拍脑袋推荐工具。

---

## 16. 建议项目目录结构

```text
ai-radar/
  README.md
  docker-compose.yml
  .env.example

  app/
    main.py
    config.py
    db.py

  collectors/
    base.py
    rss.py
    github.py
    producthunt.py
    hackernews.py
    reddit.py
    arxiv.py
    huggingface.py
    official_blog.py

  services/
    normalize.py
    dedup.py
    embeddings.py
    event_merge.py
    product_merge.py
    scoring.py
    push.py
    kb_ingestion.py
    recommendation.py

  agents/
    value_judge.py
    digest_zh.py
    product_classifier.py
    tool_recommender.py

  channels/
    telegram.py
    feishu.py

  workflows/
    daily_digest.py
    realtime_alert.py
    weekly_report.py
    ingest_kb.py

  mcp/
    server.py
    tools.py

  models/
    schemas.py
    prompts.py

  migrations/
    001_init.sql

  tests/
    test_dedup.py
    test_push_idempotency.py
    test_product_merge.py
    test_recommendation.py
```

---

## 17. MVP 实现任务拆解

### Task 1：初始化项目

- 使用 Python。
- FastAPI 作为 API 服务。
- PostgreSQL 作为数据库。
- 可选 pgvector。
- 使用 Alembic 或 SQL migrations 管理表结构。
- 提供 `.env.example`。

### Task 2：实现基础 Collector

优先实现：

- RSS Collector。
- GitHub Search / Trending Collector。
- Hacker News Collector。
- Product Hunt Collector。

输出统一写入 `raw_items`。

### Task 3：实现 URL 和标题标准化

实现：

- 移除 utm/ref/gclid/fbclid/spm 等追踪参数。
- 生成 canonical_url。
- 生成 normalized_title。
- 生成 title_hash。

### Task 4：实现基础去重

实现：

- source + source_item_id 去重。
- canonical_url 去重。
- title_hash 去重。
- github_repo 去重。
- canonical_domain 去重。

### Task 5：实现 LLM 价值判断

输入 raw item 或 event/product candidate。

输出结构化 JSON：

- 是否 AI 相关。
- 类型。
- 分类。
- 重要性。
- 新颖性。
- 开发者相关性。
- 炒作风险。
- 是否应该推送。
- 理由。

### Task 6：实现中文摘要 Agent

输出：

- 中文标题。
- 一句话摘要。
- 为什么值得看。
- 适合谁。
- 风险/槽点。
- 来源链接。

### Task 7：实现飞书和 Telegram 推送

要求：

- 支持 Markdown/文本格式差异。
- 支持消息过长分片。
- 支持失败重试。
- 写入 `push_records`。
- 通过唯一约束保证当天不重复推送。

### Task 8：实现知识库入库

第一版可以先写入本地数据库。

第二版支持：

- Dify Knowledge Base API。
- RAGFlow API 或自定义入库。

入库内容只包括精选摘要和产品卡片。

### Task 9：实现 MCP Server

暴露：

- get_today_ai_digest
- search_ai_events
- search_ai_products
- recommend_ai_tools_for_task

### Task 10：实现 AI 工具选型顾问 MVP

实现：

- `ai_tools` 表。
- `task_patterns` 表。
- 基于规则的候选召回。
- 基于 LLM 的解释生成。
- 输出推荐、备选、不推荐和落地步骤。

---

## 18. 关键测试用例

### 18.1 推送幂等测试

场景：同一个事件今天推送两次。

预期：

- 第一次成功。
- 第二次因为唯一键冲突跳过。
- Telegram 和飞书都不重复推送。

### 18.2 URL 去重测试

输入：

```text
https://example.com/post?id=1&utm_source=x
https://example.com/post?id=1&utm_source=y
```

预期：

- canonical_url 一致。
- 只保留一条有效记录。

### 18.3 标题归一化测试

输入：

```text
重磅：OpenAI 发布新模型！
OpenAI发布新模型
```

预期：

- normalized_title 接近或一致。
- title_hash 可用于候选去重。

### 18.4 同一产品跨源测试

输入：

- Product Hunt 上的某产品。
- GitHub repo。
- Hacker News Show HN。

预期：

- 识别为同一 ai_product。
- 不重复推送。

### 18.5 工具选型问答测试

输入：

```text
我想做一个内部知识库，Dify、RAGFlow、FastGPT 哪个更合适？
```

预期输出：

- 识别任务类型：内部知识库 / RAG / 企业知识管理。
- 给出首选、备选和不建议方案。
- 解释取舍。
- 给出落地步骤。

---

## 19. 环境变量建议

```env
DATABASE_URL=postgresql://user:password@localhost:5432/ai_radar
REDIS_URL=redis://localhost:6379/0

OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

FEISHU_WEBHOOK_URL=
FEISHU_SECRET=

DIFY_API_BASE=
DIFY_API_KEY=
DIFY_DATASET_ID=

ENABLE_PGVECTOR=true
DEFAULT_TIMEZONE=Asia/Shanghai
```

---

## 20. Claude Code / Codex 实施提示词

可以直接把下面这段交给 Claude Code 或 Codex：

```text
请基于本文实现一个名为 ai-radar 的 Python 项目。

目标：构建 AI 情报聚合、去重、价值判断、中文摘要、飞书/Telegram 推送、知识库入库和 AI 工具选型顾问系统。

优先实现 MVP：
1. FastAPI 项目结构。
2. PostgreSQL 表结构和 migrations。
3. RSS、GitHub、Hacker News、Product Hunt Collector 的基础接口。
4. raw_items 入库。
5. URL canonicalization、title normalization、基础去重。
6. LLM 价值判断接口，要求输出结构化 JSON。
7. 中文摘要生成接口。
8. Telegram 和飞书推送模块。
9. push_records 幂等控制，保证同一 target 同一 channel 同一天不重复推送。
10. 简单知识库入库接口，第一版先写本地表，预留 Dify API。
11. MCP Server 雏形，至少支持 get_today_ai_digest、search_ai_events、search_ai_products、recommend_ai_tools_for_task。
12. 编写关键测试：URL 去重、推送幂等、标题归一化、产品合并。

要求：
- 不要把去重和推送状态交给 LLM 判断。
- 所有 Agent 输出必须是结构化 JSON，并做 schema 校验。
- 所有外部 API 调用要有重试和错误日志。
- 所有推送必须先写 push_records pending，再执行推送，成功后更新 success。
- 如果唯一键冲突，直接跳过推送。
- 项目应包含 README.md、.env.example、docker-compose.yml、基础测试。
```

---

## 21. 最终判断

这个项目不应该被定义为“新闻聚合 Agent”。

更准确的定位是：

```text
AI 行业情报流水线 + AI 工具选型顾问
```

最终架构原则：

```text
Workflow 控制流程
Database 控制事实和状态
Agent 控制语义判断
RAG 控制证据检索
MCP 控制外部访问
Push Dispatcher 控制推送幂等
```

最推荐的长期技术栈：

```text
LangGraph
+ PostgreSQL / pgvector
+ FastAPI
+ Dify / RAGFlow
+ Telegram / 飞书
+ MCP Server
```

最推荐的实施策略：

```text
先用 MVP 跑通信息流
再抽核心服务
最后扩展为 AI 工具选型顾问
```
