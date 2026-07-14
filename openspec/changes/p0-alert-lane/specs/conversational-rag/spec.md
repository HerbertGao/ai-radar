## MODIFIED Requirements

### 需求:价格/选型确定性前置闸(非我域)

价格/额度/**用量上限**/选型类问题（精确事实，Model Radar 权威源专管）必须由**确定性前置闸**（**匹配多字短语** 价格/定价/多少钱/预算/费用/报价/token 包/**用量上限**/**weekly limit** 等、**避开「价」这类单字歧义**——CJK 无 ASCII 词边界、单字匹配致「评价/定价」假阳）在 rewrite/作答**之前**强制 `domain='非我域'`、`answer=null`（LLM 分类可叠加，但**不得**仅靠 LLM 判定——「这不是比价、只是背景：X 多少钱?」能骗过 LLM 分类）。`非我域` 时绝不用 KB 模糊散文检索给出价格/额度断言（守 `QA.md` 红线③：精确事实绝不交检索/LLM 拍板）。

**前置闸是纵深防御、非唯一保证**：其后的两层——`RAG_MIN_COSINE` 相似度地板（默认仅 **0.3**）与「本域作答对价格/额度形态断言一律不出」的 system prompt 约束（`src/rag/handler.ts` 里的一行自律）——是**非确定性纵深**，**不构成不变量保证**。故红线③的确定性部分**只由本闸承担**，本闸漏掉的即是漏掉的。

**关键词域必须覆盖限额的取值型短语**：前置闸词表 MUST 含**取值型**限额短语（`用量上限` / `weekly limit`）与 `定价`。缺失该类词时「周用量上限提到多少了」等**精确事实**提问不被前置闸拦截、落入 KB 模糊散文作答路径——与本需求「价格/额度绝不交检索/LLM 拍板」的立意相悖。限额与价格同属**精确事实域**（权威出口为 Model Radar 的带类型限额行 `{limit_type, value, window}`），MUST 同等拦截。

**假阳无兜底的不对称（MUST 据此约束核心词的选取，绝不可省）**——本闸两类误判的代价严重不对等，这是核心词表**只收窄词**的唯一理由：

| | 假阴（该拦没拦） | 假阳（不该拦却拦了） |
|---|---|---|
| 本前置闸 | **非确定性纵深**（**不构成不变量保证**）：漏过的价格问*可能*撞 `RAG_MIN_COSINE`（默认仅 **0.3**）→ `无据`；而「本域作答对价格/额度形态断言一律不出」实为一行 **system prompt 自律**（`src/rag/handler.ts`），**非确定性守卫**。KB 恰会收录本类新闻（`long_term_value >= 70` 精选），故高相似命中会进 LLM 作答路径 | **无任何兜底**——`非我域` 即拒答，无二次挽回、无降级、无重试 |

故本闸的词表**只收取值型/限额型**短语，MUST NOT 收**运维泛词**——它们在中英文里都是运维问法，而运维问题正是经验车道该答的：

| 泛词 | 会被误拒的真实提问 |
|---|---|
| 裸 `限流` | 「API 限流了怎么办 / 429 怎么处理」 |
| 裸 `用量` | 「怎么降低 token 用量」；「GPT-5 的**使用量**大吗」（`'使用量'.includes('用量')` 恒真） |
| **`rate limit`** | 「how to handle **rate limit** errors from the Claude API」「我一直撞 **rate limit**，怎么退避重试」 |
| **`速率限制`** | 「**速率限制**撞了怎么退避重试」——它是 `rate limit` 的标准中译（Anthropic / OpenAI 中文文档即用此词），与 `rate limit` **完全同类** |
| **`usage limit`** | 「Codex 的 **usage limit** 撞了之后多久恢复」（问的是恢复机制，不是取值） |

`rate limit` 在英文里**正是那个运维词**（"hitting rate limits" / "rate limit error" / "429"），与中文裸 `限流`、与 `速率限制` 完全同类。**同一条推理 MUST 在中英两侧一致执行**：故 `rate limit` / `usage limit` / `速率限制` / 裸 `限流` / 裸 `用量` **MUST NOT 作为裸关键词进核心**，只进 P0 变更词扩展。

**但「不收裸词」MUST NOT 被读成「这个洞只能留着」——前置闸 MUST 支持确定性共现规则（本需求修改点，绝不可省）**：本闸 MUST NOT 仅由裸关键词 `includes` 构成；它 MUST 另支持一组**确定性共现规则**。**判定形态 MUST 为「否定项一票否决 ∧ 取值意图词 ∧ 事实名词」**，三组词表逐词穷举如下：

```
共现命中 ⟺ NOT(命中任一否定项) ∧ (命中任一取值意图词) ∧ (命中任一事实名词)
                └── 否定项【一票否决】，优先于共现

INTENT_EN  = what is · what's · current · maximum · how many
INTENT_CJK = 多少 · 上限是 · 最多 · 最高
FACT       = rate limit · usage limit · 速率限制
NEGATIVE   = error · 429 · retry · back off · backoff · handle · handling · maxed ·
             exceed · avoid · throttl · 怎么办 · 怎么处理 · 退避 · 重试 · 撞
```

**「取值意图 ∧ 事实名词」单靠共现【不足以】放过运维型，否定项 MUST NOT 省（实测证据）**：运维问法**照样含意图词**——`how do I set max_tokens to avoid hitting the rate limit?`（`max` ⊂ `max_tokens`）、`I maxed out my rate limit, how do I back off?`（本规范此前逐字列为「MUST NOT 拦」）、`how to handle current rate limit errors`（含 `current`）、`what is a rate limit error?`（本规范此前自己登记为假阳）——不带否定项时**全部被拦**，而它们里只有「what is Claude's rate limit?」是该拦的。⇒ **「共现比裸词窄 ⇒ 自动放过运维型」是假的**；把运维型放回去的是**否定项**，不是共现本身。

**三处词表约束 MUST 逐条守住（每条对应一个已实测的静默失效）**：

- **MUST NOT 收裸 `max`**——`max` ⊂ `max_tokens` / `maxed`，一条问 `max_tokens` 配置的运维提问会被无兜底拒答。取值型问法由 `maximum` 覆盖；`what's the max usage limit` 仍由 `what's` 命中 ⇒ **零召回损失**。**这一删同时解掉「`maximum` 是死词（⊂ `max`）」**。
- **MUST NOT 把 `how much` 收进共现意图词**——它已是 `SELECTION_QUERY_EXT` 的**裸词**、被本闸消费 ⇒ 含 `how much` 的提问早已由裸词命中 ⇒ 共现分支**恒不独立命中** = **死规则**（违反本规范自己的死词自检 MUST）。
- **否定项 MUST NOT 含 `hit`**——`hit` ⊂ **`white`**：`what is Claude's rate limit for white-label apps?` 会被否定项误放行。**否定项自身同样 MUST 过子串自检**。

**第四组常量 `NEGATIVE_PATTERNS`（两个出口【共同】消费，绝不可省）**：

```
NEGATIVE_PATTERNS = rate limiter · 限流器 · 速率限制器
```

事实名词 `rate limit` / `限流` / `速率限制` 都是**器物名的子串**（`rate limit` ⊂ `rate limiter`；`限流` ⊂ `限流器`；`速率限制` ⊂ `速率限制器`）——而工具帖在语料里是**高频**的，两个出口都会被打中：

| 出口 | 命中样本 | 后果 |
|---|---|---|
| **P0 支路 B**（SQL `LIKE ANY`） | `Show HN: A rate limiter for LLM APIs` | **一次手机震动**（`is_ai_related=true`、命中 `%rate limit%`、支路 B 无 importance 地板） |
| **`/advisor` 前置闸**（裸词 **与** 共现两条分支） | `what is a rate limiter?` | **无兜底拒答**（含意图词 `what is` + 事实名词子串） |

**`rate limiting` MUST NOT 入 `NEGATIVE_PATTERNS`（本需求修改点，逐字登记理由）**——器物名与动名词 MUST 分开裁决：

| 词 | 性质 | 处置 |
|---|---|---|
| `rate limiter` / `限流器` / `速率限制器` | **器物名**（只有库 / 工具才叫这个名字） | **保留在否定项** |
| **`rate limiting`** | **公告常用动名词**（`Improved rate limiting`、`Updating rate limiting for the Claude API`） | **MUST 移出否定项** |

**方向不对称，MUST 写清**：支路 B 存在的**全部意义**是捕获 LLM 低估的精确事实变更 ⇒ **漏掉一条真的限流变更公告，正是它要防的那种失效**；而误震一次（`Rate limiting best practices` 这类博文）只是烦人、可恢复、看一眼就过去了。故这一格的取舍方向与否定项整体的方向**相反**，MUST NOT 被后人「统一」掉。

**生产语料实测（30 天全语料，标题含 `rate limit*` / `限流*` / `速率限制*`）**：真命中共 **2** 条，**两条都不含 `rate limiter` / `rate limiting`** ⇒ 否定项对它们**零误杀**：

- `Beyond rate limits: scaling access to Codex and Sora`
- `Improved Batch Inference API: Enhanced UI, Expanded Model Support, and 3000× Rate Limit Increase`

同一窗口内 `rate limiter` 工具帖 **0 条** ⇒ **本组模式防的是一个尚未发生的假阳**（HN 语料里该类库贴常见，故仍要防），而 `rate limiting` 若留在否定项里挡掉的是**真公告**——两者的期望代价不在一个量级。

**残余假阳 MUST 登记**：`Rate limiting best practices` / `如何做限流` 这类**博文 / 教程**不含器物名后缀 ⇒ 不被否定项挡住 ⇒ 仍会**震一次手机**。本期接受（P0 侧一次震动可恢复），进上线核验清单。

**故 `NEGATIVE_PATTERNS` MUST 同时作用于两个出口**（它是 SQL 可表达的纯否定谓词，**这正是它与共现规则的关键区别**——共现需要两个词表的 AND，本规范定死它不进 P0；而否定模式只是一个 `NOT ... LIKE ANY`，进得去）：

- **`/advisor` 侧：MUST 一票否决【两条分支】——共现分支【与】`PRECISE_FACT_CORE` / `SELECTION_QUERY_EXT` 的裸词分支（绝不可只挡共现）**。一条含 `rate limiter` 的提问，无论它是经共现命中（`what is a rate limiter?`）还是经裸词命中（`这个 rate limiter 的定价怎么算` 命中核心裸词 `定价`），**都是工具帖 / 定义提问，不该被无兜底拒答**。判定序 MUST 为：**先判否定项 → 命中即整闸不命中（`isPriceOrSelectionQuery` 直接返回 `false`）→ 再判裸词 / 共现**。若只把它并进共现的否定项，裸词分支仍会漏拦。
- **P0 支路 B 侧**：候选谓词 MUST 追加否定合取项，与既有的正向 `LIKE ANY (词表)` **同在 SQL 侧**（MUST NOT 放到应用层做二次过滤——`LIMIT` 先于应用层执行，见上）。

**否定谓词 MUST 复用与正向支路【同一个】 `lower(representative_title)` 表达式（绝不可省——漏 `lower()` 会让它恰在它唯一要防的那条标题上失效）**：

```sql
-- 正向（既有）：lower(representative_title) LIKE ANY (<词表 patterns>)
-- 否定（本需求新增）：
AND NOT ( lower(representative_title) LIKE ANY (<NEGATIVE_PATTERNS patterns>) )
--        ^^^^^ 与正向【同一个】表达式，MUST NOT 写成裸 representative_title
```

理由是**词表全小写 + PG 的 `LIKE` 区分大小写**：HN 的真实标题是 **Title Case**（`Show HN: A **R**ate **L**imiter for LLM APIs`）⇒ 正向谓词因为**用了 `lower()`** 而命中 `%rate limit%`、否定谓词若不用 `lower()` 则匹配不到 `%rate limiter%` ⇒ `NOT(false)` = `true` ⇒ **手机照震，否定项等于不存在**。而本规范给出的样例恰好全小写 ⇒ **测试会绿**，这个失效是静默的。上面那条生产真命中（`… and 3000× **R**ate **L**imit Increase`）同样是 Title Case——它能被正向谓词捕获，**只因为正向用了 `lower()`**。

**方向登记（有意）**：`Anthropic raises rate limits for Claude Pro` 不含任何器物名 ⇒ **照常命中，零召回损失**；被排除的只有工具帖。若某日厂商真的发布一个名为「rate limiter」的产品，它会被本组模式漏掉——**这是有意的取舍**（漏一条产品发布，换掉每一篇 HN 工具帖的手机震动）。

**子串自检的作用域 MUST 覆盖共现的【三个词表全部】（意图 / 事实 / 否定），中英一视同仁（绝不可省）**：本规范为 CJK 立了这条自检（`用量` ⊂ `使用量`），却从未把它套到英文上——而两处实测炸掉的（`max` ⊂ `max_tokens`、`hit` ⊂ `white`）**全是英文**。作用域为共现集自身（每个词表内部的死词自检 + 对常用词的子串自检），与裸词消费集分开算。

**否定项的方向 MUST 显式登记为【有意】**：它把**假阳**（拒答，不可挽回、无兜底）换成**假阴**（落进 KB 检索路径，有 `RAG_MIN_COSINE` 这道非确定性纵深兜底）。**这正是本规范自己的原则（「假阳无兜底 ⇒ 宁可假阴」）的兑现，不是它的例外**——一条被否定项误放行的取值型提问，最坏是走 KB 路径；一条被共现误拦的运维提问，是一个本该被回答的问题被永久拒绝。

**共现比裸词窄，正是「假阳无兜底 ⇒ 核心只收窄词」原则的正确实现，不是它的例外**：裸 `rate limit` 会误拒**全部**运维问法，而「否定项 ∧ 共现」拦住取值型、放过运维型。上一段只证明了「不能加裸词」，它**没有**证明这个洞必须留着。

- **MUST 拦（逐字）**：「what is Claude's **rate limit**?」「what's the **max usage limit**?」「**rate limit** 最高是多少」（**中文意图词 ∧ 英文事实名词**——中英交叉格 MUST 命中：意图词与事实名词各自**跨语言取并集**后再做共现，**不是**两条各自封闭的语言内规则）「what is Claude's rate limit for **white-label** apps?」（**它是取值型、该拦**；列在此处是为钉死「否定项 MUST NOT 含 `hit`」——`hit` ⊂ `white` 会让它被误放行）。
- **MUST NOT 拦（逐字）**：「how to handle **rate limit** errors」「429 怎么退避重试」「我一直撞 **rate limit** 怎么办」「how do I set **max_tokens** to avoid hitting the rate limit?」「I **maxed out** my rate limit, how do I back off?」「how to handle **current** rate limit errors」「**what is a rate limit error**?」「Show HN: a **rate limiter** for LLM APIs」。
- **MUST NOT 用 LLM 复核来决定是否拦截**——那会把红线③（精确事实绝不交 LLM）交回 LLM。共现规则 MUST 为纯字符串判定（可单测、可回放）。
- **共现规则【只】被本前置闸消费，MUST NOT 进 P0 词表支路**：P0 侧是**纯 `representative_title` 单词表谓词**（SQL `LIKE ANY`，见 realtime-alerts），共现会改变其谓词形态；且新闻标题里出现 `rate limit` 几乎必是变更公告，P0 侧本就用裸词即高精度。
- **共现的事实名词侧 MUST NOT 收 `用量上限`**：它已是 `PRECISE_FACT_CORE` 的**裸词**、被本闸消费 ⇒ 任何含它的提问早已由裸词命中 ⇒ 该共现规则**恒 no-op** = **死规则**。（此即为何「把 `用量上限` 移出核心、改由共现承载」这条补救路径**不成立**，见下「已知代价二」。）

**已知代价一：英文取值型提问的存量洞【已由共现规则关闭至残余】（MUST NOT 粉饰残余部分）**——「what is Claude's rate limit」这类**带取值意图词**的英文提问由上面的共现规则**确定性拦截**，不再落进 KB 散文路径。**残余的洞是【无意图词的裸名词短语】**（如「Claude rate limits?」——既无取值意图词、亦不含核心词），它仍不被本闸拦截，其守卫只有**非确定性纵深**（`RAG_MIN_COSINE=0.3` + 一行 system prompt 自律），**不构成红线③的确定性保证**。该残余 MUST 如实登记：收窄不是关闭，系统 MUST NOT 声称该路径已有不变量级保证。

**已知代价二：`用量上限` 的中文运维假阳（有意的不对称取舍，MUST 显式登记、不得沉默）**——`用量上限` 以**裸词**留在核心，是为保住招牌用例「周用量上限提到多少了」的召回；代价是中文运维问法「Codex 的**用量上限**撞了之后多久恢复」会被本闸**无兜底拒答**，而它的英文版（`usage limit` 撞了多久恢复）在上表里被逐字列为「MUST NOT 拦」的反例。**这处中英不对称是【已接受的代价】，`用量上限` MUST 恒留核心。** 它 MUST 进上线观察期的人工核验清单，但**其处置 MUST NOT 是「移出核心」**。

**「移出核心、改由共现承载」这条补救路径 MUST NOT 被写进本规范（它有两个独立的致命缺陷，任一成立即足以否掉它）**：

1. **它对 P0 是招牌用例全损，「召回不变」这个说法是假的**。本规范定死「P0 支路消费 `PRECISE_FACT_CORE ∪ FACT_CHANGE_EXT`，**MUST NOT 消费共现规则**」——把 `用量上限` 移出核心，它就**从 P0 的词源里彻底消失**（共现进不了 P0，`FACT_CHANGE_EXT` 里也没有它），而 P0 的招牌用例「周用量上限提升 50%」正是由**核心的** `用量上限` 命中。⇒ 该补救对 `/advisor` 或许无损，**对 P0 是把招牌用例静默打死**。**两个消费者共享同一份核心词表 ⇒ 任何对核心的增删 MUST 同时对两个出口逐一裁决**；**任何只算了一个出口就宣称「召回不变」的措辞 MUST NOT 出现**。
2. **承载它的那条共现规则本身是死规则**：`用量上限` 是核心裸词、被本闸消费 ⇒ `(多少|上限是|最多|最高) ∧ 用量上限` **恒不独立命中**（见上「共现的事实名词侧 MUST NOT 收 `用量上限`」）。补救路径无处落脚。

**该补救若被误做，强制复检【抓不到】（MUST 登记这条盲区）**：离线回放（见 realtime-alerts「P0 实时告警质量可观测」，MUST 在每次改词表后重跑）在 30 天生产语料上的**唯一命中样本**（「…重置 Fable 5 **额度**了」）是由 **`额度`** 命中的，**不是** `用量上限` ⇒ 移走 `用量上限` 后回放仍然「①不带闸 = ②支路 B = 1」、**验收判据照常绿**。

**若确有一天必须把 `用量上限` 移出核心**，处置 MUST 为：移出核心的**同时**把它加进 `FACT_CHANGE_EXT`（P0 侧保持命中），且 MUST NOT 宣称该操作对两个出口都无损。**MUST NOT** 靠给本闸加 LLM 复核来救（那会把红线③交回 LLM）。

**CJK 子串禁令（MUST）**：只禁「**单字**」不足——**双字词同样可能是高频无关词的子串**（`用量` ⊂ `使用量`）。口径为：新增词 MUST 通过「常用词子串」自检；取值型概念 MUST 用足够长的短语（`用量上限`）而非其裸名词根（`用量`）。

**死词自检（MUST，含作用域定义）**——一个词 W 是**死词**，当且仅当**它所在那个 gate 的消费集**（本前置闸 = 核心 ∪ 提问词扩展；P0 告警支路 = 核心 ∪ 变更词扩展）中存在一个更短的词 S，使 `W.includes(S)` 恒真——此时 W 永远不会独立命中，`some(kw => q.includes(kw))` 早已被 S 满足。**死词 MUST NOT 加入，且存量死词 MUST 清理**（`性价比最高` ⊂ `性价比`、`哪个划算` / `哪个更划算` ⊂ `划算`、`how much does` ⊂ `how much`——删除它们**不改变本闸的命中集**）。例：`额度上限` 是死词（`额度` 已在核心内）。

**死词自检的作用域 MUST 同时覆盖【共现规则的三个词表各自内部】（意图 / 事实 / 否定），并 MUST 把「与裸词消费集重叠即死」一并算上**：共现的每一侧都是 `some(w => q.includes(w))`，故同一侧内的更短词会先满足（如 `是多少` ⊂ `多少` ⇒ `是多少` 是死词，MUST NOT 加）；而共现的**某一侧词项若已是本闸裸词消费集的成员**，含该词的提问早已由裸词命中 ⇒ 整条共现分支恒不独立命中（如 `how much` 已在 `SELECTION_QUERY_EXT`、`用量上限` 已在 `PRECISE_FACT_CORE`）⇒ **同样是死规则，MUST NOT 加**。

**语义过宽自检（MUST，非子串问题——CJK 子串禁令查不出这一类）**：核心词 MUST NOT 收**语义过宽的取值名词**——`报价` / `单价` / `售价` 会命中「H100 **售价**上调」「OpenAI **报价** X 亿收购」这类市场/并购新闻（`is_ai_related=true`、importance<85），它们**不改变开发者当日的用法与成本决策**，进 P0 即为噪音。此三词 MUST 归**提问词扩展**（advisor 侧它们本就是问法）。核心保留 `价格` / `定价` / `pricing`（真·公告措辞）。

**已知过宽词登记（MUST 逐词登记，并 MUST 进上线核验清单）**——下列词经自检**仍保留**，其过宽面已知、代价已定价。

**登记 MUST 逐词标出【假阳落在哪些出口】，MUST NOT 只标 P0（绝不可省）**：`PRECISE_FACT_CORE` 是**两侧共享**的——落在核心里的过宽词，其假阳**同时**打在 P0 告警**和** `/advisor` 前置闸上，而 **advisor 侧的假阳是【无兜底拒答】，是更贵的那一侧**（P0 侧只是一次手机震动，用户看一眼就过去了；advisor 侧是一个本该被回答的问题被永久拒绝，无二次挽回、无降级、无重试）。把核心词的假阳统统记成「P0 → 一次手机震动」会**系统性低估**这些词的真实代价。

| 词 | 所在词组 | 过宽面 | 假阳落在哪些出口 | 代价 | 处置 |
|---|---|---|---|---|---|
| `quota` | **`PRECISE_FACT_CORE`（两侧共享）** | `quotation`（子串，无词边界） | **P0 告警 ＋ `/advisor` 前置闸** | P0：一次手机震动；**advisor：拒答，无任何兜底** | 保留，进核验清单（**两侧都要看**） |
| `额度` | **`PRECISE_FACT_CORE`（两侧共享）** | 「算力额度」「授信额度」等 `is_ai_related=true` 的算力/融资新闻 | **P0 告警 ＋ `/advisor` 前置闸** | P0：一次手机震动；**advisor：拒答，无兜底** | 保留，进核验清单（**两侧都要看**） |
| `价格` | **`PRECISE_FACT_CORE`（两侧共享）** | 泛市场新闻（「显卡价格」「算力价格」） | **P0 告警 ＋ `/advisor` 前置闸** | P0：一次手机震动；**advisor：拒答，无兜底** | 保留，进核验清单（**两侧都要看**） |
| `用量上限` | **`PRECISE_FACT_CORE`（两侧共享）** | 中文运维问法「撞了多久恢复」 | **`/advisor` 前置闸**（P0 侧无实测假阳） | **拒答，无任何兜底** | **恒留核心**（招牌召回；移出即打死 P0 招牌用例），见上「已知代价二」 |
| `sunset` | `FACT_CHANGE_EXT`（**仅 P0**） | 英文标题里的普通用法（非弃用公告） | **仅 P0 告警**（本词不进 advisor 消费集） | 一次手机震动 | 保留，进核验清单 |
| **`rate limit`** | `FACT_CHANGE_EXT`（**仅 P0**） | **⊂ `rate limiter`**（P0 侧 SQL `LIKE '%rate limit%'` 无词边界）——「**Show HN: A rate limiter for LLM APIs**」这类库贴 `is_ai_related=true` 且命中 ⇒ **直接推手机**。HN 上此类贴常见 | **仅 P0 告警** | 一次手机震动 | 保留；**器物名后缀由 `NEGATIVE_PATTERNS` 在 SQL 侧挡掉**（含 `lower()`，见上）。**残余**：`Rate limiting best practices` 一类博文不含器物名 ⇒ 仍震一次，进核验清单 |
| **`限流`** | `FACT_CHANGE_EXT`（**仅 P0**） | ⊂ `限流器`（同上，中文侧同型） | **仅 P0 告警** | 一次手机震动 | 保留；`限流器` 由 `NEGATIVE_PATTERNS` 挡掉。残余同上，进核验清单 |
| **`速率限制`** | `FACT_CHANGE_EXT`（**仅 P0**） | ⊂ `速率限制器` | **仅 P0 告警** | 一次手机震动 | 保留；`速率限制器` 由 `NEGATIVE_PATTERNS` 挡掉。残余同上，进核验清单 |
| **`deprecat`** | `FACT_CHANGE_EXT`（**仅 P0**） | **词干**（有意为之，覆盖 `deprecated` / `deprecation`）⇒ 讲「如何处理 deprecated API」的教程贴照样命中 | **仅 P0 告警** | 一次手机震动 | 保留，进核验清单 |
| `what is` ∧ `rate limit` | `PRECISE_FACT_COOCCUR`（**仅 advisor**） | 定义/排障型提问（「what is a **rate limit** error?」——含意图词但问的不是取值） | **仅 `/advisor` 前置闸** | **拒答，无兜底** | **由否定项关闭**（`error` 命中否定项 ⇒ 不拦）。共现的残余假阳仍进核验清单 |

**过宽面是【语料】的函数，不只是词表的函数（MUST 据此定复检的触发条件）**：上表 `FACT_CHANGE_EXT` 一栏的假阳（`rate limiter` / `限流器` / `deprecated` 教程贴）**打在什么量级上，取决于 P0 车道采到的是哪些源**。故离线回放（见 realtime-alerts「P0 实时告警质量可观测」）的强制重跑触发条件 MUST 为「**改词表 _或_ 改采集源集合**之后」，MUST NOT 只写「改词表后」——本变更自己就在改采集源集合（`sitemap` 进 `REALTIME_NEWS_SOURCES`）。

**LIKE 元字符禁令（MUST，且 MUST 可强制）**——词表常量 MUST NOT 含 `%`、`_`、`\`，且词表模块 MUST 在**加载时即断言**这一点（断言比测试更难被绕过：新增词的人不跑测试也会立刻炸）。理由是**同一份词表有两个出口**：P0 侧渲染成 SQL `LIKE ANY`（逐词包 `%`），advisor 侧走 TS `String.includes()`。`_` 是 LIKE 的**单字符通配符**（实测 `'gptX4 released' LIKE '%gpt_4%'` → `true`），而 TS 侧 `includes()` 把 `_` 当**字面量**——一个含 `_` 的词会让 **SQL 与 TS 两个出口静默分叉**，且没有任何测试会自然发现它。`\` 是 LIKE 的默认转义符，同禁。该断言同时保证词表**非空**，这是 P0 侧谓词函数「恒返回 `SQL`、永不返回 `undefined`」的前提。

**三组常量的穷举表（本文件是唯一 SOT，design / tasks MUST 引用不得抄副本）**：精确事实域的**核心词** MUST 由一处共享常量承载，被本前置闸与 realtime-alerts 的「精确事实变更」告警支路**共同消费**，MUST NOT 在两处各自维护副本（防漂移）。三组常量 MUST **逐词穷举**（不得留省略号——词表未穷举等同于两个闸的语料域未定义）：

| 词组 | 成员（穷举） | 消费者 |
|---|---|---|
| **`PRECISE_FACT_CORE`**（精确事实域**取值型**短语） | `价格` `定价` `计费` `订阅费` `会员费` `pricing`；`额度` `限额` `配额` `token 包` `token　包` `token包` `token package` `quota`；`weekly limit` `用量上限` | **两侧共享** |
| **`SELECTION_QUERY_EXT`**（提问词 / 主观词） | `多少钱` `预算` `费用` `收费` `性价比` `划算` `便宜` `套餐` `报价` `单价` `售价`；`选型` `选哪个` `推荐哪个` `怎么选`；`how much` `cost per` `per token` | **仅**本前置闸 |
| **`FACT_CHANGE_EXT`**（新闻标题措辞 + 运维泛词） | `deprecat` `sunset` `弃用` `停止支持` `限流` `rate limit` `usage limit` `速率限制` | **仅** P0 告警支路 |
| **`PRECISE_FACT_COOCCUR`**（**共现规则**：`NOT(否定项) ∧ 取值意图词 ∧ 事实名词`，非裸词） | **意图**（跨语言并集）：`what is` `what's` `current` `maximum` `how many`；`多少` `上限是` `最多` `最高`　**∧**　**事实名词**：`rate limit` `usage limit` `速率限制`　**∧ NOT 否定项**：`error` `429` `retry` `back off` `backoff` `handle` `handling` `maxed` `exceed` `avoid` `throttl` `怎么办` `怎么处理` `退避` `重试` `撞`。**否定项一票否决，优先于共现。**〔**MUST NOT 含**：裸 `max`（⊂ `max_tokens` / `maxed`）· `how much`（已是 `SELECTION_QUERY_EXT` 裸词 ⇒ 死规则）· `是多少`（⊂ `多少` ⇒ 死词）· 事实名词侧的 `用量上限`（已是核心裸词 ⇒ 死规则）· 否定项里的 `hit`（⊂ `white`）〕 | **仅**本前置闸 |

本闸消费 `PRECISE_FACT_CORE ∪ SELECTION_QUERY_EXT` 的裸词匹配 **∪** `PRECISE_FACT_COOCCUR` 的共现匹配；P0 告警支路消费 `PRECISE_FACT_CORE ∪ FACT_CHANGE_EXT`（**纯裸词，不消费共现规则**——其 SQL `LIKE ANY` 谓词形态由 realtime-alerts 定死）。

核心内 `token 包` 的三个变体（半角空格 / **全角空格 U+3000** / 无空格）MUST 全部在表内：半角变体匹配不到全角标题，而中文标题里用全角空格分隔中英文是常态——漏掉全角变体等于对一类常见标题恒不命中，且这类漏词**恒不可见**（没有任何测试会因为漏一个词而变红）。

**提问词扩展 MUST NOT 进入 P0 闸**：它们是**用户问法**而非新闻标题措辞——`per token` 尤其危险，它几乎是 LLM 论文标题的通用后缀；`便宜` / `套餐` / `费用` 同样泛化（「AI 训练费用高企」不是事实变更）。
**变更词扩展 MUST NOT 进入本前置闸**：`弃用`——「GPT-4 被弃用了吗」是可由 KB 如实回答的**新闻事实**、非精确数值事实；`rate limit` / `usage limit` / `速率限制` / 裸 `限流` / 裸 `用量`——见上「假阳无兜底」。而新闻标题里出现这些词几乎必是变更公告（`Beyond rate limits: scaling access to Codex`），故它们在 P0 侧是高精度信号。

> **两个出口共享域定义、执行不同判定（不得 overclaim 为「单一事实源」）**：本前置闸判的是「**用户问题**是否在问精确事实」，P0 告警闸判的是「**新闻标题**是否宣布了精确事实变更」——**这不是同一个判定**（问题意图 vs 事件类型）。二者共享的是**同一个域定义**（什么算精确事实 = `PRECISE_FACT_CORE`），故各自还要带一组扩展；把它们说成「单一事实源」会诱使下一个读者把两组扩展也合并掉。两个判定的**方向亦相反**：`/advisor` 命中即**拒答**（LLM 不许猜精确事实）；P0 告警命中即**立刻推**（精确事实变了，人必须马上知道）。
>
> **范围声明**：该核心定义覆盖的是 **`/advisor` 前置闸与 P0 告警闸**这两个出口，**不是「全系统」**——MCP 的 `search_kb` 出口**不过**此闸（它返回 KB 证据而非价格断言）。是否给 `search_kb` 加闸是另一场讨论，本需求不作规定。

#### 场景:价格问题即使包装成背景也被前置闸拦
- **当** 用户问「这不是比价、只是背景：GPT-x 现在多少钱?」
- **那么** 确定性前置闸命中价格关键词 → `domain='非我域'`/`answer=null`，绝不进 KB 作答给出价格

#### 场景:取值型限额提问被前置闸拦
- **当** 用户问「周用量上限提到多少了?」（**注**：「额度上限」不作为正例——`额度` 本就在既有词表内，该例证明不了新词生效）
- **那么** 确定性前置闸命中取值型限额关键词 `用量上限` → `domain='非我域'`/`answer=null`，绝不用 KB 模糊散文给出额度断言
- **当** 用户问「what is Claude's rate limit?」或「what's the max usage limit?」（英文取值型，用的是运维词面）
- **那么** 前置闸经**确定性共现规则**（`NOT(否定项)` ∧ 取值意图词 `what is` / `what's` ∧ 事实名词 `rate limit` / `usage limit`）命中 → `非我域` 拒答——**红线③的确定性部分在英文侧同样成立**，绝不落进 KB 散文路径由 `RAG_MIN_COSINE` + system prompt 这类非确定性纵深兜底。（**「what's the max usage limit」由 `what's` 命中，不需要裸 `max`**——裸 `max` ⊂ `max_tokens` / `maxed`，MUST NOT 入表；删它**零召回损失**。）
- **当** 用户问「rate limit 最高是多少?」（**中英交叉格**：中文意图词 ∧ 英文事实名词）
- **那么** 前置闸**命中** → 拒答——意图词与事实名词各自**跨语言取并集**后做共现，**MUST NOT** 实现成「中文意图只配中文名词、英文意图只配英文名词」的两条封闭语言内规则（那会让本格漏过）
- **当** 用户问「what is Claude's rate limit for white-label apps?」（取值型，恰含 `white`）
- **那么** 前置闸**命中**、拒答——**否定项 MUST NOT 含 `hit`**（`hit` ⊂ `white`，会把这条取值型提问误放行）。**否定项自身同样要过子串自检**

#### 场景:中英文运维类提问不被误拦
- **当** 用户问「API 限流了怎么办 / 429 怎么处理?」「429 怎么退避重试?」「怎么降低 token 用量?」「GPT-5 的使用量大吗?」「how to handle rate limit errors from the Claude API?」「我一直撞 rate limit 怎么办?」「速率限制撞了怎么退避重试?」
- **那么** 前置闸**不**命中、正常进入 KB 检索作答路径——这些是运维/经验类问题，拒答它们属过度拦截，且本闸的假阳**无任何兜底**
- **且** 两道判定都不命中：① 裸词侧——裸 `限流` / 裸 `用量` / `rate limit` / `usage limit` / `速率限制` 均不在本闸词表内（仅在 P0 变更词扩展内）；② **共现侧——`NOT(否定项)` 一票否决**（`怎么办` / `怎么处理` / `429` / `退避` / `重试` / `撞` / `handle` / `error` 均在否定项内），**且**多数问法本就不含取值意图词
- **当** 用户问「how do I set **max_tokens** to avoid hitting the rate limit?」「I **maxed out** my rate limit, how do I back off?」「how to handle **current** rate limit errors?」「**what is a rate limit error**?」「Show HN: a **rate limiter** for LLM APIs」（这些**含**取值意图词或其子串，**光靠共现挡不住**）
- **那么** 前置闸**仍不**命中——**MUST 由否定项一票否决**（`avoid` / `maxed` / `back off` / `handle` / `error`），且 `max_tokens` 一格另需「**裸 `max` MUST NOT 入意图词表**」（`max` ⊂ `max_tokens`）、`rate limiter` 一格靠「**无取值意图词**」。**系统 MUST NOT 声称「共现比裸词窄 ⇒ 自动放过运维型」**——不带否定项时这五条**全部被误拦**（实测），把运维型放回去的是**否定项**

#### 场景:中文用量上限的运维问法被误拦(有意保留的代价)
- **当** 用户问「Codex 的用量上限撞了之后多久恢复?」（运维问法，问的是恢复机制、不是取值）
- **那么** 前置闸**命中**裸词 `用量上限` → `非我域` **拒答**——这是**已登记的假阳、无兜底**，与其英文版（`usage limit` 撞了多久恢复，**不**被拦）构成有意的中英不对称：核心以裸词保留 `用量上限` 是为保住招牌用例「周用量上限提到多少了」的召回。该词 MUST 在上线核验清单内，但**其处置 MUST NOT 是「移出核心、改由共现承载」**——`用量上限` 是核心裸词 ⇒ 那条共现规则**恒 no-op（死规则）**；且 P0 支路**不消费共现** ⇒ 移出核心会让 P0 的招牌用例「周用量上限提升 50%」**静默失联**（而离线回放的唯一命中样本由 `额度` 命中，**复检抓不到这次回归**）。**任何「召回不变」的说法都是假的**——它只算了 `/advisor` 一个出口。**MUST NOT** 给本闸加 LLM 复核

#### 场景:器物名否定模式在两个出口同时一票否决
- **当** 用户问「what is a **rate limiter**?」（经**共现**分支：意图词 `what is` ∧ 事实名词 `rate limit` 子串），**或**问「这个 **rate limiter** 的**定价**怎么算」（经**裸词**分支：命中核心裸词 `定价`）
- **那么** 前置闸**均不命中**、正常进入 KB 检索作答路径——`NEGATIVE_PATTERNS` 在 `/advisor` 侧 **MUST 一票否决【两条分支】**（共现**与**裸词），判定序为「先判否定项 → 命中即整闸返回 `false` → 再判裸词 / 共现」。**只把它并进共现的否定项 MUST NOT 被采用**——裸词分支会漏拦，而这两类提问都是工具帖 / 定义提问，拒答它们是**无兜底的假阳**
- **当** P0 支路 B 的候选谓词遇到 HN 的真实标题「**Show HN: A Rate Limiter for LLM APIs**」（**Title Case**，非全小写）
- **那么** 该事件**不**取得告警资格——否定合取项 MUST 复用与正向支路**同一个** `lower(representative_title)` 表达式。**写成裸 `representative_title LIKE ANY (…)` MUST NOT 被采用**：词表全小写而 PG 的 `LIKE` 区分大小写 ⇒ 正向（有 `lower()`）命中 `%rate limit%`、否定（无 `lower()`）匹配不到 `%rate limiter%` ⇒ `NOT(false)` = `true` ⇒ **手机照震**，且因全小写样例的测试恒绿而**无人察觉**
- **当** 厂商发布真的限流变更公告「Improved **rate limiting**」/「**Beyond rate limits**: scaling access to Codex and Sora」/「… and 3000× **Rate Limit** Increase」（末条为生产实测的 Title Case 真命中）
- **那么** 三条**均照常命中**支路 B——**`rate limiting` MUST NOT 入 `NEGATIVE_PATTERNS`**（它是公告的常用动名词，不是器物名）。漏掉一条真的限流变更**正是支路 B 要防的失效**；而误震一次博文只是烦人、可恢复

#### 场景:英文取值型提问漏过前置闸由纵深防御兜底
- **当** 用户问「Claude rate limits?」这类**无取值意图词的裸名词短语**（既不含核心词，也不满足共现规则的意图词一侧）
- **那么** 前置闸**不**命中（**收窄后的残余洞**——带意图词的「what is Claude's rate limit?」已由共现规则确定性拦截，见上一场景）；该问落入 KB 检索路径，其守卫为**非确定性纵深**（`RAG_MIN_COSINE=0.3` + system prompt 自律），**不是**确定性红线。系统 MUST NOT 声称此路径有不变量级保证，亦 MUST NOT 因共现规则已落地而声称英文侧的洞已完全关闭

#### 场景:弃用类新闻提问不被前置闸拦
- **当** 用户问「GPT-4 被弃用了吗?」
- **那么** 前置闸**不**命中（变更词不在本闸词表内）、正常进入 KB 检索作答路径——它是可如实引用的新闻事实，非精确数值事实

#### 场景:删除存量死词不改变前置闸的命中集
- **当** 从提问词扩展中删除 `性价比最高`（⊂ `性价比`）、`哪个划算` / `哪个更划算`（⊂ `划算`）、`how much does`（⊂ `how much`）四个死词，并对「性价比最高的编程订阅是哪个?」「how much does Claude Code cost?」等原本由它们描述的提问重跑本闸
- **那么** 判定结果**逐条不变**（仍命中 `性价比` / `划算` / `how much`）——`isPriceOrSelectionQuery` 是 `some(kw => q.includes(kw))`，更短的词先满足，死词永不独立命中

#### 场景:含 LIKE 元字符的词在模块加载时即被拒
- **当** 有人向三组常量中任一组加入含 `%`、`_` 或 `\` 的词
- **那么** 词表模块**加载即抛错**（不是等测试跑到）——`_` 在 SQL `LIKE` 侧是单字符通配符、在 TS `includes()` 侧是字面量，两个出口会就此**静默分叉**；该断言同时保证词表非空，是 P0 侧谓词恒返回 `SQL`（而非 `undefined`）的前提
