# chinese-digest-agent 规范

## 目的
待定 - 由变更 minimal-intel-pipeline 同步创建。归档后请更新目的。

## 需求

### 需求:结构化中文摘要契约

系统必须提供中文摘要 Agent，为入选事件生成中文摘要。该 Agent 必须通过 Vercel AI SDK 的 `generateObject` 调用 LLM，并以 Zod schema 约束输出。输出必须在**同一次调用**中同时包含两个字段：`summary_zh`（完整中文摘要正文，落库供知识库/Web 等后续用途）与 `headline_zh`（一句话要点，供 Telegram 日报渲染；长度严格受 Zod `.trim().min(1).max(80)` 约束，80 为单一常量供 schema 与 prompt 共用）。两字段均必须经 Zod 校验通过、且通过 mojibake 守卫（检出 UTF-8-被当-Latin-1 的乱码即视为校验失败走重试），校验通过后分别写入 `ai_news_events.summary_zh` 与 `ai_news_events.headline_zh`；禁止把摘要以非结构化文本形式直接返回或入库。摘要写库必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**仅含** `summary_zh` 与 `headline_zh`，禁止用 `INSERT ... ON CONFLICT` 模板或覆盖塌缩首建的 `representative_title`/`representative_raw_item_id`/`first_seen_at`/`published_at`/`*_score` 列。

#### 场景:对事件产出经校验的长摘要与一句话要点
- **当** 向中文摘要 Agent 输入一条待推送事件
- **那么** Agent 返回经 Zod 校验通过的对象，含 `summary_zh`（长摘要）与 `headline_zh`（≤80 字一句话要点），二者写入对应事件行的 `summary_zh` 与 `headline_zh` 列

#### 场景:headline 与 summary 均受 mojibake 守卫
- **当** LLM 返回的 `summary_zh` 或 `headline_zh` 含 mojibake 乱码
- **那么** 该输出视为校验失败，走有限重试；重试仍乱码则降级，绝不把乱码写入任一列或推送

### 需求:摘要校验失败可观测且不污染推送

当 LLM 返回的摘要结构不通过 Zod 校验（含 mojibake 守卫命中）时，系统禁止静默吞掉。系统必须记录错误日志并执行有限重试；重试仍失败则降级——该事件回退使用塌缩首建写入的 `representative_title`（该列在塌缩首建时已写、非 NULL；极个别为空串时再兜底到 `canonical_url`）或被剔除出当日日报，绝不把未校验或半截输出推送给用户或写入 `summary_zh`/`headline_zh`。

#### 场景:摘要失败时降级不推半截输出
- **当** 某事件的摘要在有限重试后仍无法通过 Zod 校验
- **那么** 系统记录错误日志并降级（回退代表标题或剔除该事件），不向用户推送未校验内容

### 需求:摘要须以正文 grounding 且无正文时不编造

中文摘要 Agent **必须**优先以代表事件的正文（`content`，经 source-content-enrichment 补全后可用）与来源作为摘要依据。当正文缺失或过于稀薄（仅有标题）时，摘要 Agent **必须**遵守以下防幻觉护栏：

- **只依据标题概括**，**禁止**编造标题中未出现的具体事实——包括版本号、参数指标（如上下文窗口大小、benchmark 分数）、发布时间、价格、功能清单等。
- **禁止**基于模型自身训练知识**断言某产品/模型是否存在或是否已发布**。模型训练知识存在时效滞后，据此「纠正」一条真实的新发布（如把真实发布的 `Claude Sonnet 5` 摘要成「尚未发布，最新为 Claude 3.5」）属严重错误。无正文佐证时，摘要**必须**以标题所述为准客观转述，**禁止**否定或质疑标题所声称的发布事实。
- 摘要 prompt **必须**注入**当前日期**，使模型不以其训练截止时点作为「现在」，避免用陈旧知识判定新旧。

护栏不改既有输出契约：`summary_zh` 与 `headline_zh` 仍在同一次调用产出、仍经 Zod 校验与 mojibake 守卫，校验失败重试/降级、绝不落库半截或未校验输出的口径不变。

#### 场景:有正文时摘要基于正文
- **当** 某事件代表 raw_item 经补全后 `content` 非空，Agent 生成摘要
- **那么** 摘要以正文事实为依据，`summary_zh`/`headline_zh` 反映正文内容而非模型脑补

#### 场景:无正文时不编造具体参数
- **当** 某事件正文补全失败、仅有标题（如 `Leanstral 1.5`）
- **那么** 摘要只据标题客观概括，不编造标题未出现的上下文窗口大小 / benchmark 分数 / 发布时间等具体参数

#### 场景:无正文时不据训练知识否认真实发布
- **当** 某事件标题声称一次新发布（如 `Claude Sonnet 5`）、正文缺失，而该发布晚于模型训练知识截止
- **那么** 摘要以标题所述为准转述，不基于训练知识断言「尚未发布 / 不存在」、不用陈旧型号「纠正」它；prompt 已注入当前日期使模型不以训练截止为「现在」
