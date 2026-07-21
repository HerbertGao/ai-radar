## MODIFIED Requirements

### 需求:语义去重仅作用于日报链新闻事件

系统的 embedding 相似度层、LLM 二次判断层与事件合并必须**仅在日报链**执行（在硬去重塌缩之后、value-judge 之前），实时告警高频链保持硬去重快路径、不做语义去重（对齐既有"仅日报链"的熔断模式）。语义层必须仅作用于 `ai_news_events`（新闻事件），不作用于 `ai_products`（产品仍沿用确定性硬规则合并）。语义层必须**无条件执行**、不设启停开关（原 `SEMANTIC_DEDUP_ENABLED` 门控已随该层转正删除）；其正确性由阈值与确定性护栏保障，不由运行期开关兜底。

#### 场景:告警链不触发语义合并
- **当** 实时告警链运行硬去重塌缩
- **那么** 不执行 embedding 相似度/LLM 判断/事件合并，仅按硬去重 + 一生一次幂等告警

#### 场景:日报链无条件执行语义层
- **当** 日报链完成硬去重塌缩
- **那么** 语义层照常执行，不存在可跳过它的运行期开关（grep 全仓无 `SEMANTIC_DEDUP_ENABLED`）

### 需求:tombstone 对所有下游消费者不可见（合并的核心闭环）

语义合并把被吞事件置 `merged_into IS NOT NULL`（tombstone），但 tombstone 仍是 `ai_news_events` 中一条物理行，其 `*_score` / `should_push` / `summary_zh` / `published_at` 等列原样保留。**因合并发生在 value-judge 评分之前，被吞 tombstone 的 `importance_score` 此刻为 NULL，若不显式排除，会被 value-judge 重新选中评分（"复活"为已评分事件）、进而被 Top N 选中并独立推送——与存活者重复推送同一现实事件，使合并不仅无效、反而比不合并更糟**。故系统必须确立一条横切不变量：

> **凡把 `ai_news_events` 的一行当作「独立事件」用于评分 / 选择 / 推送 / 查询 / 聚合统计的读取，都必须在 `WHERE` 上排除 tombstone（`merged_into IS NULL`）；凡按 `event_id` 定位写入的，要么命中的是终态存活者（经链式解析），要么显式跳过 tombstone。**

declared-coverage（合并闭环所需的全部受影响读点）必须覆盖以下**实际生效集**（按当前代码消费者枚举，新增同类消费者须一并纳入）：

| 消费者 (`file`) | 用途 | 必须的处理 |
|---|---|---|
| `src/agents/value-judge/score-events.ts`（候选 SELECT `importance_score IS NULL`；claim CAS `UPDATE … WHERE event_id=? AND importance_score IS NULL …`；评分写 CAS `UPDATE … SET *_score/should_push WHERE event_id=?`） | 选未评分事件送判 | 候选 SELECT **与 claim CAS、评分写 CAS 三处 `WHERE` 都**加 `AND merged_into IS NULL`——**不可只在 SELECT/claim 收口**：告警链跑 `scoreUnscoredEvents` 不持日报锁，SELECT→claim→评分写均为分离语句，任一间隙日报链都可把 B 置 tombstone（TOCTOU）；谓词落每个 CAS 自身 `WHERE` 才使「tombstone 绝不被 claim/评分/复活」成立 |
| `src/selection/top-n.ts`（Top N 候选 SELECT） | 选日报推送候选 | 加 `AND merged_into IS NULL`——tombstone 绝不入选推送 |
| `src/agents/published-at-inference/backfill.ts`（候选 SELECT 与回填 CAS `UPDATE … WHERE event_id=? AND published_at IS NULL …`） | 回填 published_at | 候选 SELECT **与回填 CAS 的 `WHERE` 都**加 `AND merged_into IS NULL`——同 value-judge 的 TOCTOU 理由（告警链 `backfillPublishedAt` 不持日报锁），谓词必须落 CAS 自身 `WHERE`，不浪费推断预算、不在 tombstone 落 `published_at` |
| `src/pipeline/alert-scan.ts`（告警候选 SELECT） | 实时告警候选 | 加 `AND merged_into IS NULL`——不对已被日报链合并掉的死 event_id 告警 |
| `src/mcp/tools/source-quality.ts`（`count(distinct event_id)`） | 来源质量统计 | 加 `AND merged_into IS NULL`——不因 tombstone 虚增「事件数」 |
| `src/mcp/tools/search-events.ts` / `get-today.ts` / `mark-event.ts` / `push-event-now.ts` | MCP 查询/标记/手动推送 | 排除 tombstone——不向 agent/用户暴露重复行、不手动推 tombstone、不在 tombstone 上落写 |
| KB 入库候选选择（见 knowledge-base「准入闸」候选域） | 选高价值/已推送事件入库 | 加 `AND merged_into IS NULL`——否则存活者与 tombstone 各得不同 `target_id`，`UNIQUE(target_type,target_id,kb_provider)` 不去重、产生重复 KB 文档 |

**无锁告警链的 CAS 必须自带谓词（SELECT 收口不充分）**：日报链的合并在单例锁内，但告警高频链跑 `scoreUnscoredEvents` / `backfillPublishedAt` / 塌缩**均不持日报锁**，与日报合并并发。凡告警链可达、按 `event_id` 定位的 **CAS 写**（claim `judge_claimed_at`、评分写 `*_score`/`should_push`、回填 `published_at`、塌缩 `source_count`），其 tombstone 排除谓词**必须落在该 CAS 自身的 `WHERE`**，不可仅靠上游候选 SELECT 或上一步 claim（claim 与评分写亦为分离语句，claim 后、评分写前仍可被合并置 tombstone）——SELECT 与 CAS 是分离语句，二者之间日报合并可置 tombstone（TOCTOU），仅 SELECT 收口挡不住。谓词落 CAS 后，最坏情形退化为「无害空写/空 claim」（命中已 tombstone 行时 `WHERE` 不满足、0 行受影响），既不复活 tombstone、也不浪费 LLM/推断（CAS 0 行即跳过后续外部调用）。**例外（有意豁免）**：`releaseJudgeClaim`（清 `judge_claimed_at`）**无需**加该谓词——清 claim 仅「重新允许被 claim」，而再 claim 已被加谓词的 claim CAS 挡住，故清在 tombstone 上是无害空操作、非复活向量；勿误把它当遗漏「顺手补上」。

注：`src/dedup/collapse.ts`（ON CONFLICT 改投存活者）与 `semantic-search.ts`（候选检索 `merged_into IS NULL`）已在各自需求中处理，是闭环的另两点。改投在事务内对「冲突行 + 链解析后的存活者行」两行加锁，与并发合并（对被吞行 + 其存活者 `FOR UPDATE`）可能 AB-BA——依赖与「合并 vs 合并」同一套 Postgres 死锁检测 + BullMQ 重试 + 幂等重塌缩兜底（见「确定性事件合并」锁序），非声称无死锁协议。以下按键读/写**经上游收口而传递性安全**（枚举完备、非偶然完备）：`src/pipeline/run-daily-workflow.ts`(`loadCanonicalUrls`) 与 `src/agents/digest/persistence.ts`（`UPDATE … WHERE event_id=?` 写 summary）的 `event_id` 全部来自 Top N 选集（已排除 tombstone），故不会落在 tombstone 上；`src/mcp/lib/canonical-url.ts` 由 get-today/push-event-now 喂入（均已收口）。`get-today.ts` 经 `push_records.status='success' AND push_date=今日` 还原：tombstone **可能保留被合并前某历史 push_date 的 success 记录**，但因 tombstone 已被 value-judge/Top N 排除、当日绝不被新推送，故**今日**的 success 集只含存活者——结论安全（措辞按「今日 push_date 集只含存活者」，非「tombstone 无 success 记录」）。上述按键路径实现仍须在 `event_id` 来源不可信（如 MCP 入参）时显式排除 tombstone。

#### 场景:被吞事件不被 value-judge 复活、不被 Top N 重复推送
- **当** 今日新事件 B 与存活者 A 合并、`B.merged_into=A.event_id`（B 此前 `importance_score` 为 NULL），随后 value-judge 与 Top N 阶段运行
- **那么** B 因 `merged_into IS NOT NULL` 被 value-judge 候选查询排除、不被评分，Top N 候选查询同样排除 B，B 绝不进入推送，当日仅存活者 A 一条参与（A 若昨日已 success 则据幂等跳过）

#### 场景:并发下被吞事件即便被告警链选中也不被 claim/评分/回填（CAS 自带谓词）
- **当** 告警链（无日报锁）候选 SELECT 已选中 B，其后日报链把 B 置 `merged_into=A`，告警链再执行 claim CAS / 评分写 CAS / 回填 CAS（含 claim 成功后、评分写前 B 才被置 tombstone 的链内二次 TOCTOU）
- **那么** 各 CAS 自身 `WHERE … AND merged_into IS NULL` 不满足、命中 0 行：B 不被 claim、不送 LLM 评分、`*_score`/`should_push` 不被写、`published_at` 不被回填，tombstone 绝不复活（SELECT→claim→评分写的每个 TOCTOU 间隙都被各 CAS 自带谓词兜住）

#### 场景:tombstone 不出现在告警/MCP 查询/KB/统计
- **当** 一条 tombstone 事件存在于 `ai_news_events`
- **那么** 告警候选、MCP `search-events`/`get-today` 结果、KB 入库候选、`source-quality` 的 `count(distinct event_id)` 统计均不包含它（各读点带 `merged_into IS NULL`）
