## MODIFIED Requirements

### 需求:解释层 v1 为模板、带规则依据 + provenance、LLM 不参与、接口对 v2 留证据缝

> **需求名为历史命名**（v1 时期，「LLM 不参与」曾是全称约束），**以正文为准**：5e v2 起，LLM 以**可选证据叙述段**参与解释，但**权威结论只出程序侧、叙述段数字来源封闭**。需求名保留原样：归档守卫按名匹配整条替换（与本仓其他历史命名同理）。

**模板层语义不变（v1 原样保留，恒为兜底）**：模板解释层 MUST 保留 v1 全部语义——固定话术填候选事实 + 命中/落选的规则原因（`RankedCandidate.reasons`）+ per-fact `source_url`/`lastCheckedDate`/`source_confidence` 溯源；每条首选/备选/不推荐/待核给「为什么」的规则依据（含「已停售」「最佳周期=年付/季付，有效月价 ¥X，含预付锁期」等话术）。模板层纯字符串拼接、MUST 永不失败——降级链兜底恒可达。

**解释输出的结构**：`explanation = 模板段 + 可选证据叙述段 + 参考清单`（成功时各段以 `\n\n` 相接；无 KB 命中则参考清单整段省略、不留空段）。**权威结论只由程序侧产出**：`recommend()` 既有 guidance（非空时）与模板段构成**确定性权威前缀、恒在 LLM 段之前**，模板段是候选级结论与数字的唯一权威载体；叙述段是**非权威背景补充**（只写「最近发生了什么」），MUST NOT 含结论词表内词；**数字来源封闭**：模板段数字来自 candidates（v1 不变），叙述段数字 MUST ⊆ 守卫①白名单——「从 X 到 Y @日期」的证据引用因此合法，白名单外的**新数字**进不来。此为红线③（精确事实绝不交 LLM）的结构落点：数字与结论的**产出权**恒在程序侧。

**「逐字节 = v1」判定基线**：v1 完整 explanation 由 `recommend()` 对 guidance 与解释层返回值做既有拼装（`recommend.ts` 的 join 逻辑，本变更不动）。回落语义 MUST 为：**回落/跳过时 v2 渲染器返回 `renderTemplate(input)` 原值**——上游拼装不变 ⇒ 最终 `RecommendationResult.explanation` 与 v1 逐字节相等；该断言 MUST 在最终 explanation 层测（覆盖普通 / 空召回 / 全待核 / 他币种路径）。

**接口（v1 接口 = v2 接口，杜绝换层重构）**：解释层接口 MUST 为 `ExplanationInput → Promise<explanation>`，`ExplanationInput { query, candidates: RankedCandidate[], evidence?: RecommendEvidence }`；规则原因仍在 `RankedCandidate.reasons` 内、不另设顶层冗余字段。`evidence` 槽由 v1 的 `unknown` 定型为：`RecommendEvidence { kbHits: {docId, planId, title, url: string|null, cosine}[], priceChanges: {planId, vendorName, planName, from: string|null, to, currency, changedAt}[], pendingReview: planName[] }`。**`recommend()` 永不填 `evidence`**（仍只传 `{query, candidates}`，`recommend.ts` 零改动）——v2 注入点是 Explainer 函数本身，`evidence` 槽是 v2 渲染器内部「装配结果 → 叙述子渲染」的通道兼测试注入缝。`evidence === undefined` ⇔ **入参侧未装配**；装配过但无证据 = 三空数组。模板层继续忽略 `query`/`evidence`。

**证据装配（纯读、注入式，MUST 绝不阻塞也绝不挂起）**：
- **kbHits**：对排序后前 3 条候选（`ExplanationInput.candidates` 保持 `recommend()` 输出序——已核升序、未核殿后），以「`vendorName` + `name`」（candidates 自带字段）为查询调用既有 env-clean 检索核心（`searchKbCore`）——装配只**调用**核心、不修改其语义与参数；每候选 top-k 与余弦地板均为模块常量，命中按地板过滤、地板下全灭 ⇒ 该子源为空；跨候选命中按 `docId` 去重（保最高 cosine）；`title = kbTitle ?? '(无标题)'`，`url` = `sourceUrls` 为字符串数组时首个合法 `http(s)` 项（同守卫③ URL 闸口径）、否则 null，`docId` 保留。
- **priceChanges**：直接 SQL 读 `mr_price_history` 近 30 天（模块常量）内**全部候选** plan 的变更行；`from = old_value`（可 NULL——首录行，话术「新录得价」）、行内带 `currency`；`changedAt` 素材与话术只渲染 `YYYY-MM-DD`（**UTC 口径**，时分秒不入素材）。
- **pendingReview**：从 `candidates[].reasons`（`kind='pending_review'`）**派生**、不回库——与 verdict 判定同源同时点，杜绝双真相源。
- 任一子源抛错 ⇒ 该子源空数组 + 结构化日志 + 继续；**装配整体 MUST 设 deadline**（模块常量；race 只弃置不取消底层调用）——超时按全失败（三空 + 日志）处理，挂起的 embed/DB 调用不得拖住请求；三源全空 ⇒ 跳过 LLM 调用。推荐主流程 MUST NOT 因证据装配或解释层任何失败而失败。

**LLM 证据叙述段的机械守卫（程序判定、弃用即回落）**：

*canonical 文本（守卫与发射的唯一消费对象）*：素材与 LLM 叙述段进入守卫前 MUST 先规范化为 canonical 形式 = `sanitizeText` 净化 → **NFKC 归一**（全角 ASCII 折半角；`［１］→[1]`；小/上标连字符 U+FE63/U+207B 等经此消解）→ **负号映射**（U+2212 数学负号族 + **完整 `\p{Dash_Punctuation}` 类**（含 U+058A 等手枚举易漏项）→ `-`）→ **剔除全部不可见拼接码点**：`\p{Default_Ignorable_Code_Point}`（覆盖 Cf 零宽/bidi + 变体选择符 U+FE0F 类）**并**剔 C1 控制符 `[-]`（Cc、NFKC 不折、`sanitizeText` 只保 C0 外的 `\t\n\r`——C1 会拆开结论词/URL/数字而对目标端不可见）（**素材侧此四步在长度封顶之前**）。**发射进最终 explanation 的叙述段即 canonical 文本**（保留合法 `[n]`）——**所有不可见拼接类**（零宽 Cf / bidi / 变体选择符 / C1 控制符）由此在**校验与显示两面同时消除**：这一族「校验值 ≠ 显示值」结构性关闭（同形字/IDN 等**可见**近似不属本族——它们显示端本就可辨，由溯源链与人工缓解，登记于诚实边界）；三道守卫全部消费 canonical 文本（守卫①②在剥离合法 `[n]` 的副本上比对）；**LLM 返回值的空判定 MUST 在 canonical 化之后**（纯不可见/零宽返回值 canonical 后为空 ⇒ 按渲染失败回落，不得标 `llm`、不产空段）。

*统一提取管线*（白名单构造侧与叙述段比对侧 MUST 共用同一实现；输入 = canonical 文本）：识别并**消费** `YYYY-MM-DD` 日期模式（**须带数字边界 `(?<!\d)…(?!\d)`**——否则 `12025-07-17` 会消费内层 `2025-07-17`、残留 `1` 放行虚构 5 位年 `12025`；年/月/日数值入集合，连字符不残留为负号）→ 余文剔千分位分隔（仅 `\d{1,3}(,\d{3})+` 模式内的逗号）→ 按 `[-+]?(\d+(\.\d+)?|\.\d+)` 提取，其中 **`-`/`+` 仅当处段首或前一字符为任一非 `[A-Za-z0-9]` 字符时视为符号（汉字/空白/标点均算）；前一字符为字母或数字 ⇒ 视为连字符、不消费**（「GLM-4.6」「GLM 4.6」均得 `4.6`；「跌到-25」与独立「-25」均得 `-25` ≠ `25`；`.5` ≡ `0.5`）→ parseFloat 数值集合。**叙述段比对侧 MUST fail-closed 于不可验证数字**：某数字 token parseFloat 后非有限（`Infinity`/`NaN`，如 400 位数）或 `|val| > Number.MAX_SAFE_INTEGER`（浮点折叠使 `…992`≡`…993`），**或叙述段含科学计数法记号 `\d[eE][±]\d`**（`4.6e1` 会被拆成 `{4.6,1}`、二者若均在白名单则放行显示为 `46` 的新数字）⇒ 该数字无法可靠归一比对、整段弃用（绝不因「提取器丢弃了它」而盲放白名单外数字）。构造侧（白名单）忽略该标记、逐字节不变。

- **守卫① 数字白名单**：白名单在拼 prompt 时同步构造 = 对**每段进入 prompt 的最终素材文本**（候选 `vendorName`/`name`、kbHits `title`、价格变更行渲染文本、待复核标渲染文本——名称/标题内的版本数字自然入集）跑上述管线 ∪ 显式数值字段（candidates `monthlyCost`、priceChanges `from`/`to`）∪ prompt 框架数值（窗口天数常量 + 本次各证据数组长度活值）。**prompt MUST NOT 含 `query`**。守卫在剥除合法引用标记（守卫③）后的叙述段上跑同一管线，任一数字 ∉ 白名单 ⇒ 整段弃用。
- **守卫② 结论词禁令**：封闭词表常量（初始集：中文子串「首选」「备选」「不推荐」「推荐」「建议选」；拉丁 token 按非字母数字切分、小写全等：`primary` / `recommend` / `recommended` / `best`）；命中 ⇒ 整段弃用。匹配无正则参与。**守卫②在剥离合法 `[n]` 之后的文本上跑（与守卫①同一文本——防「推[1]荐」类视觉合成结论词）。**
- **守卫③ 引用形态**：**编号素材 = 过地板后的 kbHits，按 prompt 出现顺序编号；参考清单与编号一一对应同序；价格变更行以 `from→to@日期` 模式话术引用、不参与编号**。LLM **引用 KB 素材时**以 `[n]` 编号（引用可选——零引用合法，参考清单仍全量列出）；叙述段每个 `[n]` MUST 满足 `1 ≤ n ≤ kbHits 条数`，越界 ⇒ 整段弃用（悬空引用）；剥离在 canonical 化**之后**执行（`［１］`类全角形态同按 `[n]` 处理）；合法 `[n]` 为结构记号、剥离后再跑守卫①；**`[n]` 紧邻数字（`\d[` 或 `]\d` 形态）⇒ 整段弃用**（防「[2]5」视觉合成白名单外数字）。叙述段含 URL 形态文本（`http` / `://`，**大小写不敏感**）⇒ 整段弃用——**URL MUST NOT 入 prompt**，只存在于代码拼接的参考清单（URL 闸：仅 `http`/`https` 协议放行**且拒 userinfo（`@` 形态）**；验证通过后 MUST **只渲染解析后的 `href`**、不拼接原始字符串——WHATWG URL 容忍的内嵌 CR/LF/tab 由此消除；在解释层内实现、与 web 层 safeHref 同口径但不反向依赖 web 层）。**参考清单渲染 MUST 每 kbHit 恒一物理行**：标题**先 canonical 化**（剔全部不可见拼接类——参考清单也是发射进 explanation 的组件，与叙述段同属发射面，否则不可信 KB 标题的 RLO/零宽会绕过叙述段的闭包漏到用户可见输出）**再**折叠 CR/LF/tab 与连续空白为单空格并截断（同素材封顶常量）后渲染——防标题内换行伪造独立结论段、防视觉重排。
- LLM 返回的叙述 **canonical 化后** trim 为空 ⇒ 按渲染失败回落（不得标 `llm`）。
- 弃用/失败 ⇒ 回落纯模板段（返回 `renderTemplate` 原值）+ 记原因。
- **守卫能力的诚实边界（登记，不虚称）**：守卫只见阿拉伯数字——汉字数字/拆写为已登记记法盲区（prompt 明令叙述段只用平记法阿拉伯数字；叙述段非权威、权威数字与结论恒在模板段）；科学计数法（`4.6e1`）已升为 fail-closed 弃用（见统一提取管线，不再是盲区）；白名单保证**来源封闭**、不保证**归因正确**（白名单内旧价被错述为现价，及千分位/日期成分/框架数值使小数字近乎自由的 false-pass，均属登记残余，由「从 X 到 Y @日期」模式话术与 prompt 缓解）；词表拦常见形态、同义改写不可机械穷尽——结论权威性的硬保证来自「确定性权威前缀恒在 LLM 段之前、模板段是候选级结论与数字的唯一权威载体」的结构，词表是缓解层；无数字无结论词的叙述性误导（含无 scheme 裸域名文本）同为登记残余（上游 KB 精选闸缓解）。**本守卫集为 fail-closed 缓解层，规则集就此封闭**：任何新发现的绕过形态，其失败模式恒落入「整段误杀 → 回落模板（降级成功）」或「非权威叙述段残余误导（本段登记类）」之一，MUST 登记入本残余类、不再逐条增设规则；**唯一例外**：能使叙述段获得结论或数字产出权（即破坏「权威前缀在前、结论与数字只出程序侧」结构）的形态不属本类，仍按缺陷处理。本声明禁止的是新增守卫规则；守卫②词表条目与各模块常量的调整不在此限（匹配语义不变）。

**层选择与降级链**：新主 env `MR_RECOMMEND_EXPLAIN`（`template` | `llm`，默认 `template` ⇒ 部署即惰性）。`llm` 模式降级链 MUST 为：证据三源全空 → 跳过 LLM（标记 `template`）；LLM 失败/超时/空叙述 → 回落（`llm-fallback-template`）；守卫①②③任一弃用 → 回落（`llm-fallback-template`）；通过 → 模板段 + 叙述段 + 参考清单（`llm`）。渲染器主体 MUST 整包 try/catch——守卫/拼装/净化自身抛错同样回落，绝不向 `recommend()` 传播；**调用方构造与注入 LLM 层的过程同样 MUST fail-open**：构造抛错 ⇒ 装模板层 + 记错，绝不使页面/工具失败。LLM 调用 MUST 为 `generateObject` + `{narrative: string}` schema（全仓「Agent 输出结构化 JSON + schema 校验」不变量）；超时用解释段专用模块常量（较批管线口径更紧；两进程 import 同一常量、无漂移面）；**重试口径 MUST 为：非超时瞬态错误且剩余预算充足（下限为模块常量）时重试 1 次，总预算恒为该超时常量、不因重试扩大**（瞬态 = 网络层错误与 HTTP 429/5xx；4xx 业务错与 schema 校验失败非瞬态；超时/abort 恒不重试）；**底层 SDK 内建重试 MUST 显式关闭**（`generateObject` 传 `maxRetries: 0`）——重试唯一控制权在本层，否则 SDK 默认重试会叠乘调用次数并重试规范排除的超时类错误——满足全仓「外部 API 调用必须有重试和错误日志」不变量，错误日志经观测行保留。

**两进程装配（env-clean 铁律不破）**：Explainer 由调用方注入（`recommend()` 既有第三参），层选择逻辑 MUST NOT 进入 `recommend()` 本体。v2 渲染器模块 MUST env-clean：LLM provider 以**注入凭据**在模块内构造（仿 `src/kb/embed-clean.ts` 款式），MUST NOT import 既有 `agents/llm-client.ts`（其顶层值 import 主 env）或任何触全局 parseEnv 的模块。**Web 调用方**读主 env；**MCP 调用方**经既有 `mcpEnvSchema` + `getContext().env` 读——`MR_RECOMMEND_EXPLAIN` 与 `LLM_MODEL` 补入 mcpEnvSchema（optional，**非致命款式**：mcpEnvSchema 是整对象 safeParse，非法值 MUST 按未设置处理 + 一行 stderr（发射点在 env 解析后置检查）、不崩 server）。**key 集合 = LLM_API_KEY + LLM_BASE_URL + LLM_MODEL + EMBEDDING_MODEL 四项**：配置 `llm` 且任一缺 ⇒ 装模板层 + stderr 一行列出缺失变量名（静默回落会让「配了 llm 却永远模板」不可诊断）；未配置 `llm` 不刷 stderr。四 key 判定与 stderr 在 MCP 调用方侧（工厂只对注入凭据做防御断言）。

**prompt 注入面**：证据文本入 prompt 前 MUST **canonical 化**（见「机械守卫」canonical 段：sanitizeText + NFKC 归一 + 负号映射 + 剔 Cf）并每段长度封顶（模块常量）——prompt 素材与白名单从 canonical 截断**之后**的同一份最终素材构造；URL 不入 prompt；prompt 明令：只用平记法阿拉伯数字、**不复述现价与结论（现价以模板段为准）**、历史价格变更只按提供的 `from→to@日期` 字段叙述、只补背景与变化。注入诱导的数字/结论/URL 由守卫①②③弃用兜底。

**可观测**：辖域 = `llm` 模式（v2 渲染器被注入）的每次渲染，MUST 经 **deps 注入的 log sink 尽力（best-effort）**结构化记录：渲染层三值标记（`template` / `llm` / `llm-fallback-template`）、证据命中统计（KB 条数 / top cosine / 价格变更条数 / 待复核条数）、守卫弃用原因（若有）——log sink 自身抛错 MUST NOT 影响返回值（成功与回落路径的记录调用自身均包 try）。web 注 stdout logger；**MCP MUST 注 stderr**——MCP 进程的 stdout 是 JSON-RPC 专用通道，MUST NOT 写观测。标记 `template` 的两义（默认模板模式 vs llm 证据全空）由「有无该行日志 + 命中统计」分辨；默认模板模式零观测（v1 冻结）。该观测无落库无聚合 ⇒ MUST NOT 当作长期复算判据，仅作抽样窗口。

#### 场景:停售与最佳周期话术含规则原因 + 可溯源、无 LLM
- **当** 模板解释层渲染已停售候选或带年付最佳周期的候选（`MR_RECOMMEND_EXPLAIN=template`，默认值）
- **那么** 话术含 `RankedCandidate.reasons` 中的「已停售」或「最佳周期」原因 + 月成本 + 撞窗结论（估算则标警）+ `source_url`/`lastCheckedDate` 依据；不调用任何 LLM、不装配证据——v1 行为逐字节保留

#### 场景:llm 模式产出证据叙述段且结论仅在模板段
- **当** `MR_RECOMMEND_EXPLAIN=llm`、候选近 30 天有 `mr_price_history` 变更行且 KB 检索有过地板命中
- **那么** `explanation` = 模板段 + `\n\n` + 叙述段 + `\n\n` + 参考清单；叙述段以「从 X 到 Y @日期」引用价格变更、引用 KB 素材时以 `[n]` 编号（编号在 1..kbHits 条数内、与参考清单同序对应；数字——含名称内版本数字与引用编号剥离后的其余数字——均过守卫①）；无结论词表词、无 URL 形态文本；标记 `llm`

#### 场景:机械守卫弃用白名单外数字并回落模板
- **当** LLM 叙述段出现白名单外数字（如杜撰价格、独立「-25」带符号变体），或词表内结论词，或越界引用 `[9]`，或 `[n]` 紧邻数字，或 URL 形态文本
- **那么** 程序守卫整段弃用（数值比对下证据行 `"25.00"` 与叙述「25」相等、候选名「GLM-4.6」与裸写「4.6」均在白名单——皆不误杀）、explanation 回落纯模板段（最终层逐字节 = v1）、标记 `llm-fallback-template` 并记弃用原因

#### 场景:LLM 失败或超时不阻塞推荐
- **当** `llm` 模式下 LLM 调用失败或超时（解释段专用超时常量总预算，预算内有限重试后仍失败）、返回空叙述，或渲染器内部任意抛错（守卫/拼装/净化），或调用方构造 LLM 层抛错
- **那么** 推荐主流程照常返回（结论/候选/verdict 不受影响）、explanation 回落纯模板段；渲染器内失败 ⇒ 标记 `llm-fallback-template`；构造期抛错 ⇒ 直接装模板层、由调用方记错、不产 renderedBy 观测行（辖域见「可观测」段）——解释层任何失败 MUST NOT 使 `recommend()` 失败

#### 场景:证据全空或全部低于地板时跳过 LLM 调用
- **当** `llm` 模式下三源全空、装配全部失败或整体超过装配 deadline，或 KB 命中全部低于余弦地板且无价格变更、无待复核标
- **那么** 不发起 LLM 调用（无料可写、省成本）、explanation 为纯模板段、标记 `template`（与默认模板模式由命中统计日志分辨）；子源失败/超时已各自记结构化日志

#### 场景:MCP env-clean 进程缺 LLM key 时回落并提示
- **当** MCP env（`mcpEnvSchema` / `getContext().env`）配置 `MR_RECOMMEND_EXPLAIN=llm` 但四项 key（定义见「两进程装配」段）任一缺失
- **那么** MCP 工具装配模板层、正常返回推荐，stderr 一行列出缺失的变量名；未配置 `llm` 时不刷 stderr；全程不触全局 parseEnv、不使工具失败
