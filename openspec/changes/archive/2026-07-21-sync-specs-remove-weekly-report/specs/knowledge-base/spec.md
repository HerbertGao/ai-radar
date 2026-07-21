## MODIFIED Requirements

### 需求:知识摘要 Agent 产出入库元数据

系统必须提供知识摘要 Agent（QA.md §10.7 Knowledge Ingestion Agent），对候选事件经 LLM（Vercel AI SDK `generateObject`）产出经 Zod 校验的结构化 JSON：`{ kb_title, summary_zh, tags: string[], entities: string[], source_urls: string[], event_date, long_term_value: number }`。`long_term_value` 的 Zod 必须钉死取值域 `number().int().min(0).max(100)`——防越界值（如 200 或负数）绕过 `>= 70` 准入闸语义；越界即视为校验不过、跳过该条。该 Agent 属外部 API 调用，必须带重试与错误日志；输出未通过 Zod 校验时必须跳过该条、不入库（不污染知识库），不得中止整批。入库元数据的生成可由 LLM 完成，但**实际入库由程序执行**（QA.md §10.7）。

**新闻事件来源的 grounding 与 `summary_zh` 回写**：对新闻事件来源，知识摘要 Agent SHALL **grounding 于事件原文**（代表 `raw_items.content` / 代表标题等），**不得假设 `ai_news_events.summary_zh` 已由日报阶段预置**——日报 digest 已降级为只产 `headline_zh`（见 chinese-digest-agent），**日报 digest 不再产 `summary_zh`**——新闻事件的 `summary_zh` 改由本入库阶段生成、回写（消除原「日报 digest 与本入库各产一次」的重复生成；告警链仍可为 P0 事件预置 summary+headline，KB 回写因 `WHERE summary_zh IS NULL` 不覆盖）。**知识摘要 Agent SHALL 对每条候选照常运行**：它是 `long_term_value` 的唯一来源、须逐条跑供 `>= 70` 准入闸判定，**绝不能因 `summary_zh` 已存在而跳过 Agent 调用**（否则 P0/告警链已摘要的高价值事件会失 `long_term_value`、被误挡在 KB 外——严重回归）。Agent 产出并经校验的 `summary_zh` SHALL **回写到 `ai_news_events.summary_zh`**，回写为**原子条件写** `UPDATE ai_news_events SET summary_zh = ? WHERE event_id = ? AND summary_zh IS NULL`（`set` 仅含 `summary_zh`、绝不覆盖塌缩首建列；`WHERE ... IS NULL` 令回写**幂等**且与告警链并发写无损——列已非空即不覆盖，非「跳过 Agent」）。回写覆盖**所有已推送成功候选**（Agent 为算 `long_term_value` 本就跑遍它们），与准入 KB 写的 `>= 70` 过滤相互独立（`< 70` 未入 KB 者亦回写）。回写失败绝不阻塞已成功的推送（KB 入库是 push 成功后的 best-effort、never throw；Agent 对某候选失败则该候选无回写，见变更 Risks）。

#### 场景:Agent 产出结构化入库元数据
- **当** 一条候选事件送入知识摘要 Agent
- **那么** 返回经 Zod 校验的 `{ kb_title, summary_zh, tags, entities, source_urls, event_date, long_term_value }`

#### 场景:新闻事件入库回写 summary_zh 供下游复用
- **当** 一条已推送新闻事件经 KB 入库、其 `ai_news_events.summary_zh` 为空
- **那么** 知识摘要 Agent grounding 于原文产出 `summary_zh`，程序以 `UPDATE ... WHERE event_id`（`set` 仅含 `summary_zh`）回写，告警链渲染回退链（`alert-scan.ts` 的 headline_zh → summary_zh 回退）等下游后续零 LLM 复用该值；即便该事件 `long_term_value < 70` 未入 KB，回写仍发生

#### 场景:summary_zh 已存在时 Agent 照常跑、回写不覆盖
- **当** 某新闻事件入库时 `ai_news_events.summary_zh` 已非空（如告警链已产），知识摘要 Agent **仍照常运行**产出 `long_term_value`（供准入闸）
- **那么** `>= 70` 准入判定照常进行、该事件正常按闸入/不入 KB；回写的 `UPDATE ... WHERE summary_zh IS NULL` 因列非空**不覆盖**现值（Agent 调用**绝不跳过**，只是回写幂等无操作）

#### 场景:校验不过的输出被跳过不入库
- **当** 某候选事件的 Agent 输出未通过 Zod 校验或调用重试后仍失败
- **那么** 系统记错误日志并跳过该条、不写入知识库，其余候选照常处理
