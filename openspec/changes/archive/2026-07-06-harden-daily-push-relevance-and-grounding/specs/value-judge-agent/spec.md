## 修改需求

### 需求:Agent 输出落库往返

系统必须把 Value Judge Agent 经校验的评分结果写入 `ai_news_events` 的对应评分列，并能从数据库读回。Agent 输出字段（无 `_score` 后缀，对齐 QA.md §10.4）与 `ai_news_events` 列（带 `_score` 后缀，对齐 QA.md §8.2）**不同名**，系统必须显式做以下字段名映射后再写入，禁止假定同名直插：

| Agent 输出字段 | `ai_news_events` 列 |
|---|---|
| `importance` | `importance_score` |
| `novelty` | `novelty_score` |
| `developer_relevance` | `developer_relevance_score` |
| `hype_risk` | `hype_risk_score` |
| `should_push` | `should_push`（同名直写） |
| `is_ai_related` | `is_ai_related`（同名直写，布尔） |

**`is_ai_related` 必须落库（绝不可再丢弃）**：Value Judge 已产出 `is_ai_related` 布尔判定，系统必须将其经映射写入 `ai_news_events.is_ai_related` 列（新增列，可空布尔），供 daily-intel-pipeline 的要闻候选过滤据此闸门（见「要闻候选须 AI 相关」）。禁止像既有实现那样在映射层静默丢弃该字段。

本期评分必须写入由硬去重塌缩产生的真实事件行（以 `dedup_key` 经 `ON CONFLICT` 命中/创建的 `ai_news_events`），而非 P0 的 seed 行；P0 基于 `seed-<rawItemId>` 的落库脚手架被真实流水线替换。塌缩阶段先建事件行（DB 生成 `event_id`），Value Judge 阶段在其后对已存在行写分，故写分必须以 `UPDATE ... WHERE event_id = ?` 定位、`set` 中**仅含** `*_score`、`should_push` 与 `is_ai_related` 列，禁止用 `INSERT ... ON CONFLICT` 模板或在 `set` 中带 `event_id`/`representative_raw_item_id`/`representative_title`/`first_seen_at`/`published_at`——否则会覆盖塌缩首建的身份与排序列。既有的 tombstone 排除谓词（`WHERE ... AND merged_into IS NULL`）不变。

#### 场景:评分按映射写入真实事件并可读回
- **当** Value Judge Agent 对一条去重塌缩后的真实事件产出经校验的评分，系统按上表映射写入 `ai_news_events`
- **那么** 可从 `ai_news_events` 读回该事件，各 `*_score` 列与 Agent 输出对应字段一致

#### 场景:is_ai_related 落库并可读回
- **当** Value Judge 对某事件产出 `is_ai_related`（true 或 false），系统按映射写入 `ai_news_events.is_ai_related`
- **那么** 可从 `ai_news_events` 读回该事件的 `is_ai_related`，与 Agent 输出一致；该值不再被映射层丢弃

## 新增需求

### 需求:判分输入须以正文与来源 grounding

系统在调用 Value Judge 判分时，**必须**把代表 raw_item 的**正文（`content`）与来源（`source`）连同标题一并作为判分输入**（当正文经 source-content-enrichment 补全后可用时）；**禁止**退化为「仅标题」判分——除非正文补全失败致正文仍为空，此时才回退仅标题并如实以标题为唯一依据。

理由：仅凭标题判分会使 `is_ai_related` 与各项评分脱离真实内容（如仅凭标题 `Qualcomm Linux 2.0` 难以稳定判非 AI）。以补全后的正文 grounding 后，`is_ai_related` 与重要性/开发者相关性判定才有事实依据。判分输出仍必须经既有 Zod schema 校验（含 mojibake 守卫），失败重试/降级口径不变。

**「须含正文」是对所有被判事件的普遍约束，故补全工作集必须等于判分工作集**：本要求作用于 `scoreUnscoredEvents` 将判的**每一个**事件（`importance_score IS NULL AND merged_into IS NULL`）；若正文补全的工作集窄于此（漏掉上一轮已塌缩未评分的历史事件），被漏事件仍会判分却退化仅标题、违反本约束。故 source-content-enrichment 的补全工作集**必须**与判分工作集同口径（见 source-content-enrichment「待判工作集」、daily-intel-pipeline「补全工作集须与判分集同口径」）。

**载入正文/来源的具体改动点（勿误当仅签名改动）**：`judgeRawItem` 已接受可选 `content`/`source` 入参，故本变更的实工作在**调用侧**——`scoreUnscoredEvents` 现有候选 SELECT 只取 `representativeTitle`，**必须** left join `raw_items`（经 `representative_raw_item_id`）载入补全后的 `content` 与 `source` 再传入 `judgeRawItem`；只改函数签名而不改 SELECT 会使 grounding 静默空转。

#### 场景:有正文时判分吃到正文与来源
- **当** 某事件代表 raw_item 经补全后 `content` 非空，流水线调 Value Judge 判分
- **那么** 判分输入包含标题 + 正文 + 来源三者，`is_ai_related` 与各评分基于正文而非仅标题

#### 场景:正文补全失败时如实回退仅标题
- **当** 某事件正文补全失败、`content` 仍为空
- **那么** 判分回退为仅标题输入（不伪造正文），输出仍经 Zod 校验落库
