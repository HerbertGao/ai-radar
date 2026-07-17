# 设计

> **权威边界**：三道守卫、统一提取管线、降级链、两进程装配的 **MUST 级构造规则以 delta spec 同名段为唯一权威**（归档后只有 spec 存续）；本文件只留决策动机、代码事实与取舍理由，不复述规则文本。

## Context

推荐器解释层 v1 是模板（`src/mr/recommend/explain.ts` 的 `renderTemplate`），接口 `Explainer = (ExplanationInput) => Promise<string>` 已留 v2 缝（`evidence?: unknown`，`recommend()` 第三参可注入，`recommend.ts:310`）。v1 的完整 explanation 由 `recommend()` 拼成：`[guidance, narration].map(trim).filter(Boolean).join('\n\n')`（`recommend.ts:367-368`）——「逐字节 = v1」以该最终拼接为基线。

两个调用方、两种进程现实：

| 调用方 | 进程 | env 通道 |
|---|---|---|
| Web hero（`model-radar-page.tsx:181`，**公开 GET、每请求 `await recommend`**） | 主 app 进程 | 主 env（LLM/embedding 凭据必填或有默认、恒齐） |
| MCP 工具（`recommend-coding.ts:113`，**顶层 static import `recommend.js`**） | env-clean 纯查询进程；**stdout 是 JSON-RPC 专用通道（server.ts D7 铁律）**，观测只能走 stderr | 既有接缝 `mcpEnvSchema` + `getContext().env`（`src/mcp/env.ts`；search_kb 三凭据、`MR_STALENESS_THRESHOLD_DAYS` 先例）；铁律「纯查询只需 DATABASE_URL」；**parseMcpEnv 是整对象 safeParse**——新增字段须非致命款式（catch/preprocess），否则非法值炸掉整个解析 |

证据源均已在库：精选 KB（`long_term_value≥70`，`searchKbCore` env-clean、embed/dbh（db handle）注入、**无阈值恒 top-k**）、价格变更（`mr_price_history` append-only：`old_value` nullable、`new_value`/`currency` NOT NULL、无 plan_name 列）、待复核标（`RankedCandidate.reasons` 已含 `kind='pending_review'`，`recommend.ts:195-199`，与 verdict 同源）。**`RankedCandidate` 自带 `vendorName`/`name`**（schema.ts）——证据装配所需名称零回查。

既有共享 LLM 通道 `agents/llm-client.ts` **顶层值 import `config/env`**（→D4：故 LLM 调用一律凭据注入构造）。

## Goals / Non-Goals

**Goals**：解释层装上证据（KB + 变更流）与 LLM 叙述；红线③零妥协（结论与数字的**产出权**恒在程序侧）；两进程各自正确装配；解释层任何失败（含挂起与构造期抛错）不影响推荐主流程。
**Non-Goals**：召回 / 候选 schema / verdict / MCP 工具签名 / Web `explanation` 字符串形态改动；SAG / 多跳侧表；`search_coding_plans`；其他桶；KB 检索核心改动（装配只调用、不修改）；`/advisor` 链；证据观测建表；解释段结果缓存（公开页成本的 follow-up，见 Risks）。

## D1 结论权威在结构、数字来源封闭（守卫规则见 spec，此处只留决策）

**不采用**「LLM 重写整段解释 + 事后校验」——结论措辞漂移够不上机械判定。**采用**结构见 spec「解释输出的结构」段；红线③的结构落点是**产出权**：权威结论只出程序侧，叙述段数字只能 ⊆ 白名单。

守卫体系的**设计动机**（构造规则见 spec「机械守卫」段，唯一权威）：
- **canonical 文本**是防「校验 ≠ 显示」类攻击的结构解：守卫消费与最终发射共用同一份规范化字符串（净化+归一+剔 Cf），零宽拼接/bidi 重排整族失去存在面——逐条补比对侧规则永远追不上显示侧的花样，共用一份文本才是终点。
- 守卫①白名单按「全部入 prompt 素材 ∪ 显式数值字段 ∪ 框架数值」统一构造而非字段枚举——凡入 prompt 素材的数字都合法、其余都非法，一条规则闭合来源；符号上下文规则解决连字符/负号歧义（例子见 spec 与 tasks 3.6，不复述）。
- 守卫②词表封闭且无正则——同义改写不可穷尽，词表是缓解层，硬保证在结构（spec 诚实边界段）。
- 守卫③结构化引用（引用可选）——KB 标题/URL 不经 LLM 复述，引用义务与词表禁令、白名单互不相斥；编号域钉死为 kbHits（价格行走模式话术），悬空/错位/邻接合成三类形态全拦；SDK 内建重试显式关闭（`maxRetries: 0`），重试唯一控制权在本层。
- **规则集就此封闭**——声明全文与例外判据见 spec「诚实边界」段末，此处不复述。

## D2 evidence 类型化（形状与映射规则见 spec「接口」「证据装配」段）

设计取舍（spec 不承载理由）：`docId` 保留是为 ROADMAP 定序②与 `kb_documents` join 留键；**不引入索引结构**（planIndex 类）——candidates 自带 `vendorName`/`name`，自造索引就是自造「缺 plan」失败模式；`changedAt` 渲染口径取 **UTC**（`toISOString` 前 10 位）——素材与白名单同源单点实现，两进程恒一致；evidence 不建 Zod（不跨进程不入库），LLM 输出侧才有 schema。**`recommend()` 永不填 `evidence`**——v2 注入点是 Explainer 本身，`evidence` 槽是渲染器内部通道兼测试注入缝（`input.evidence ?? await assembleEvidence(...)`），`recommend.ts` 零改动。

## D3 证据装配（`src/mr/recommend/evidence.ts`，纯读、注入式）

`assembleEvidence(candidates, deps)`，deps = `{ dbh, embed, log }`。行为规则见 spec「证据装配」段；此处钉常量与理由：

- `EVIDENCE_COSINE_FLOOR = 0.6`（模块常量）——`searchKbCore` 无阈值恒 top-k，无地板则「全空跳过」形同虚设、低相关命中混进 prompt；初值无经验依据，待抽样窗校准（只动常量不动规范）。
- `PRICE_CHANGE_WINDOW_DAYS = 30`（模块常量，非 env）。
- `EVIDENCE_ASSEMBLY_TIMEOUT_MS = 5000`（模块常量）——embed 无 abort、DB 查询无时限，没有整体 deadline「绝不阻塞」在公开页语境不成立；**race 只弃置不取消**底层调用（长驻进程无害，迟到结果丢弃）。
- KB 查询集 = 排序后前 3 条候选（ordered 序：已核升序+未核殿后；含待核）——规则简单可测；>3 已核时待核候选无 KB 证据是接受的质量限制（Risks）。

## D4 层选择与两进程装配（规则见 spec「层选择与降级链」「两进程装配」段）

- 新主 env `MR_RECOMMEND_EXPLAIN` 默认 `template` ⇒ 部署即惰性（与本仓开关惯例同源）。
- **`explain-llm.ts` MUST env-clean**：工厂 `buildExplainer({ credentials: {apiKey, baseUrl, model}, dbh, embed, log, generateObjectFn? })` 返回 Explainer——provider 以注入凭据模块内构造（仿 `src/kb/embed-clean.ts`）；`generateObjectFn` 可选注入缝（默认真实调用 + `VITEST` 真调用守卫抛错，对齐 embed-clean 的 injectable-fn 款式）是 mock 测试（tasks 3.6/4.4）的构造前提。工厂只对注入凭据做防御断言；四 key 判定与 stderr 在 MCP 调用方（工厂收到的是已构造 embed 函数，无从判 EMBEDDING_MODEL 缺失）。
- MCP 侧选 `mcpEnvSchema` + `getContext().env` 而非直读 process.env：与 search_kb / MR_STALENESS 同接缝，`LLM_MODEL` 恰是 mcpEnvSchema 现缺的一项；非致命款式的实现路径 = `.catch(undefined)` + 解析后置检查（原始值存在而解析值 undefined ⇒ stderr 一行——raw 在 `parseMcpEnv(raw)` 形参作用域内，可行已核）。
- 超时 `EXPLAIN_LLM_TIMEOUT_MS = 8000`、重试剩余预算下限 `EXPLAIN_RETRY_MIN_REMAINING_MS = 2000`（均 explain-llm.ts 模块常量，两进程同一 SOT）——公开 GET 页语境，不继承批管线 60s 口径；重试口径见 spec「层选择与降级链」段——满足全仓「外部 API 调用必须有重试和错误日志」不变量（config.yaml:28，无例外机制，合规是唯一稳定路线）。
- LLM 调用 `generateObject` + `{narrative: z.string()}`——全仓结构化输出不变量 + abortSignal 超时先例。

## D5 降级链（规则与全部回落分支见 spec「层选择与降级链」段）

```
llm 模式（渲染器主体整包 try/catch；调用方构造亦 fail-open）：
  装配（5s deadline，子源失败→空）→ 三源全空？→ renderTemplate 原值，'template'
  → generateObject（8s 预算，内含有限重试）失败/超时/空叙述 → renderTemplate 原值，'llm-fallback-template'
  → 守卫③→①→②，任一弃用 → 同上回落
  → 通过 → renderTemplate 原值 + '\n\n' + 叙述段 + '\n\n' + 参考清单，'llm'
```

`renderTemplate` 永不失败（纯拼接）⇒ 兜底恒可达；回落/跳过返回原值 ⇒ 最终 explanation 逐字节 = v1。素材净化沿用 `src/collectors/sanitize.ts` 的 `sanitizeText` + 每段 `EVIDENCE_TEXT_MAX_LEN = 200` 封顶（白名单从截断后文本构造，见 spec）。

## D6 观测（规则见 spec「可观测」段）

设计动机：经 deps 注入 log sink 而非直写 console——MCP stdout 是协议通道（web 注 stdout logger、MCP 注 `console.error`）；best-effort（log 抛错不影响返回值）——「绝不传播」优先于「必须记录」。stdout 抽样窗、无落库 ⇒ 不可作长期复算判据；`EVIDENCE_COSINE_FLOOR` 校准与词表调整届时以生产只读 SQL + 人工抽样为准。

## Risks / Trade-offs

| 风险 | 处置 |
|---|---|
| KB 素材 prompt 注入面 | 净化 + 每段 200 封顶 + 结构化引用（URL 不入 prompt、守卫③拦 URL 形态）+ 守卫①②弃用兜底；无数字无结论词的**叙述性误导**（含裸域名）为登记残余（上游精选闸 ltv≥70 缓解） |
| 公开 GET 页成本/延迟放大（llm 模式每请求 ≤5s 装配 deadline + 8s LLM 预算，无鉴权无限流） | deadline + 预算封顶（重试不扩预算）+ 默认 template 零成本；按 (snapshot version, setup) 缓存叙述段为 follow-up、不进本变更 |
| 快照候选 vs live 价格变更的窗口（价改落库 → rebuild 间，秒级） | 接受登记：叙述「从 X 到 Y @日期」自带时间戳、与模板段现价非同一断言；价改已耦合 rebuild 触发；prompt 注明「现价以模板段为准」 |
| 白名单 false-pass 残余（归因错误；千分位/日期成分/框架数值使小数字近乎自由） | 方向被「模板段唯一权威结论」压住；模式话术 + prompt 缓解；登记、不加机制（规则集已封闭） |
| 白名单误杀（数字形态改写） | 统一管线（符号上下文、日期先消费、千分位仅模式内剔）消掉主要形态；仍误杀 ⇒ 回落模板，方向安全 |
| 待核候选排在 top-3 外时无 KB 证据 | 质量限制、非破坏；接受 |
| 证据段与模板段重复叙述 | 接受（并排是设计形态）；prompt 明示只补背景与变化 |

## Open Questions

（无）
