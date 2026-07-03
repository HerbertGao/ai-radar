## 上下文

推荐器 `recommend(snapshot, input, explain?) → Promise<RecommendationResult>`（`src/mr/recommend/recommend.ts`）**已建好并测过**：`recall` 按 model/tool/protocol 召回 → `classify` 有序短路判级（停售/未核/待复核/超预算/撞窗）→ 已核升序首个 eligible 取 `primary`、其余 `alternative`；空/无 eligible 时 `composeNoEligible` + `relaxationHints` 组装**诚实 guidance**（永不空手）。输出 `{ candidates: RankedCandidate[], explanation, query }`，`candidates` 扁平带四态 `verdict`（`primary`/`alternative`/`not_recommended`/`insufficient_data`），每候选含 `monthlyCost`(nullable) / `currency` / `priceStatus` / `availability` / `stale` / `fitsWindow`(fits/exceeds/unknown) / `reasons` / `provenance`。`currency`/`usageProfile` 有默认（`DEFAULT_CURRENCY`/`DEFAULT_USAGE`）。

现 Web（变更 A）`GET /model-radar` 是表优先 SSR。本变更把它翻成答案优先，**只加呈现层**、复用引擎全部判定与诚实语义。

## 目标 / 非目标

**目标**：`/model-radar` 答案优先——`recommend()` 结果渲成 primary 答案卡 + 3 备选 + 「描述你的配置」输入 + 新鲜度头条 + thin-data 空态 + 证据抽屉（既有比价表）；复用 A 设计系统 + WCAG；mobile-first。

**非目标**：不改 `recommend.ts`/`schema.ts`/`explain.ts`/MCP 工具；不改 money-path/DTO/数据层/快照；不引 JS 框架；不多桶/不个性化；不改比价表口径（只重定位）。

## 决策

**D1 — 路由：`/model-radar` 原地翻转，不新增路由。** 答案优先页取代表优先页作 `/model-radar` 主体；旧「纯表」视图作为页内证据抽屉存续（不设 `/model-radar/compare` 二级路由——避免 IA 分裂、grill Q4 = 单一答案优先入口）。`createModelRadarWebApp` 的 handler 由同步渲染改 **async**（`await recommend(snapshot, input)`）；`getSnapshot` 注入风格与 fail-closed 503、CSP、serveStatic 字体路由全部沿用。

**D2 — 呈现层只映射引擎输出，零判定。** handler：解析 query → 组 `RecommendInput`（只取引擎认的字段：model/tool/protocol/currency/maxMonthlyPrice/usageProfile；web-only 的估算旋钮等仍 render 层用）→ `await recommend(snapshot, input)` → 按 `verdict` 分流渲染。**MUST NOT** 在 web 层重排/重判/重算 primary（裸快照手搓 cheapest 是既有红线）。`monthlyCost`/`currency` 展示复用比价表既有「币种代码 + 空格 + 金额」呈现约定与取整 helper（不进 money-path）。

**D3 — verdict → 呈现分流（四态全覆盖）。**
- `primary` → **答案卡**（hero）：方案名 + 厂商 + 月成本 + fitsWindow 结论 + reasons（引擎给的规则原因）+ provenance + 新鲜度头条。至多 1 张（引擎保证唯一）。
- `alternative` → **备选卡**（前 3；若 >3，显「另有 N 个备选，见证据」）。
- `not_recommended` / `insufficient_data` → **不进答案/备选卡**；随证据抽屉 A 表以 **A 自身既有标级**（停售/未核/待复核）呈现（A 表无超预算/撞窗列，不注入），其 recommend 落选缘由（超预算/撞窗）由答案区「说明」区（`result.explanation`）交代，不冒充可推荐。
- **无 `primary`**（`primaryAssigned===false` 或空召回）→ 答案位显 `result` 的诚实 guidance（引擎 `explanation`/`composeNoEligible`/`relaxationHints` 文案），**MUST NOT** 造首选。

**D4 — thin-data 诚实红线（复用引擎，不在 web 复制判定）。** 诚实语义已在 `recommend()` 里（空手 guidance、未核不入 eligible、停售 not_recommended）。web 层义务：① **所有状态**在答案区原样渲染 `result.explanation` 作**从属「推荐说明」区**（引擎全量逐候选叙述、含首选复述）：无 primary 时唯一内容；有 primary 时卡下方从属说明（视觉次于卡/可折叠，不作竞争的第二答案），已含分歧候选落选缘由。**与卡重复是有意的**（零判定/honesty 优先），MUST NOT 裁剪串剔首选、MUST NOT 提升候选为卡；容器 `white-space: pre-line`（串含 `\n`）；② `fitsWindow==='unknown'` 的答案卡 MUST 把「额度未知」警告**DOM 序先于结论**（一等公民）；③ 新鲜度用 `candidate.stale` + 该候选价格事实 `provenance.lastCheckedDate` age（候选自带、非聚合「最旧事实」；全量 per-fact 最旧在抽屉 Q4）**上卡**。

**D5 — 「描述你的配置」输入区。** 复用变更 A 的原生控件驯化 + `--border-control` a11y；措辞从「筛选」翻「描述你的编程场景」（model / tool / protocol / currency / budget / usageProfile）；`usageProfile` 用原生 `<select>`（light/medium/heavy，有 label、query-param、无 JS 回退）。提交即整页 GET（渐进增强）。空提交（裸 `/model-radar`）→ 用引擎默认（usageProfile=medium、无维度过滤）：**有同币种 eligible 给默认答案、无则显引擎 guidance，皆不空白** + 提示「描述你的配置以精确」。

**D6 — 证据抽屉 = 既有比价表原样（不注入 verdict）。** 变更 A 的 5 列表 + 详情行**组件原样复用**，整体包进 `<details>`（默认折叠、原生无 JS、`aria` 契约随组件带入），`<summary>` 描述性点明内含全部方案对比与依据。表口径/结构/排序/最划算/provenance/**A 既有标级（停售/未核/待复核/陈旧/最划算）不变**；**抽屉表查询只传召回维度 `{category,model,tool,protocol}`、不传 `currency`/`maxMonthlyPrice`**——否则 A 的 `matchesFilters` 会滤掉超预算/他币种 plan，使答案区引用的落选候选在证据里不可见；故落选候选（超预算/撞窗/他币种）仍在抽屉可见。**关键：MUST NOT 向 A 表注入 recommend 的 `verdict`/超预算/撞窗列**——A 表无此列，注入即违「口径/结构不变」；落选缘由在答案区 explanation 交代，不进表。四问可答（答案答 Q3 最划算，抽屉 A 表答 Q1/Q2/Q4）。

**D7 — a11y / SSR / 视觉全复用变更 A。** 分层 surface、token、Hanken Grotesk、View Transitions、forced-colors 兜底、outline 焦点、目标 ≥24px、reflow、skip-link/地标/lang、XSS safeHref 单闸——一律沿用；答案卡/备选卡作新的抬升 surface 卡（同 token）。**新表面是 A 未验过的新 elevation**：其文字/警告/provenance 链接的逐层对比度 MUST 按真实卡背景值**重验**（不因「复用 token」假定达标）；`<title>` 在无-primary 的 guidance 态也须有意义（不用「答案」误导）。SetupForm 用 `<fieldset><legend>` 分组。近零 JS：全 SSR GET、原生 `<details>`/`<form>`/`<select>`。

**D8 — setup 参数在 web 层校验/适配，公开页不 fail-open。** `recommend()`/`recall` 对畸形入参会抛（无冒号 `model` / 空 `tool`·`protocol` → `recall` 的 `modelRadarQueryParamsSchema.parse` ZodError；非法 `usageProfile` → `USAGE_KNOBS[k]` undefined → `knobs.demandedRounds` TypeError 崩）。故 handler MUST 在 `await recommend()` **之前**做边界：schema 参数（键名用既有 **`maxMonthlyPrice`**，非 `budget`）经 `modelRadarQueryParamsSchema` **直接 `.parse()`**（该 schema 已 strict + superRefine、是 `ZodEffects`、无 `.strict()` 方法），ZodError→**400**；`maxMonthlyPrice="100 CNY"` 解析出**数值** amount + 币种（`currency = 显式 ?? 串币种 ?? 默认`，冲突→400）再喂引擎；web-only 的 `usageProfile`（及其它 web-only 键）MUST 先从待 `.parse()` 的 map 剔除（schema `.strict()` 拒未知键，否则每次带 usageProfile 都 400），单独校枚举、非法 **clamp 到默认**（不崩不 400）。（`currency` 非法由 schema 直接 →400、不进 `recommend()`。）这是**恢复 compare-api 既有 `ZodError→400` 边界**（翻转把 parse 移进 `recommend()` 内部后须在 web 层补回），非新增能力；校验只解析/映射、不复制引擎判定。

## 设计演进（实现 + review-loop 期落定）

原 D1–D8 框架不变，实现与 review-loop 期落定以下细化（均在既有约束内、**不改引擎/money-path/DTO**）：

- **E1 — 深色定论面板 hero + 品牌头。** 答案卡采深色 `--brand-navy` 面板作「分析师定论」材质、与浅色证据/账本分层（品牌官网气质、非平铺文档）；页头为品牌标识 + tagline。深色面板上的文字/徽标/焦点环对比度对 brand-navy 真实底**重验**：正文/次级/链接/状态徽标均 ≥4.5:1（链接 accent-lift 7.4:1）；**焦点环改 accent-lift**（页面默认 accent 对深底仅 2.74:1、破 WCAG 2.4.11）。
- **E2 — 推荐说明 = 结构化表 + 折叠原文（D4 细化）。** 「推荐说明」区从纯 `explanation` 串升级为**结构化「推荐说明表」**（从 `result.candidates` 渲染、零判定：逐候选 判级/月成本/撞窗/缘由、落选按 `verdict` 如实标级），引擎 `explanation` 全量原文降为其下**可折叠 `<details>`**（无 primary → 默认展开 `open`、有 primary → 折叠）。表**从结构化 candidates 渲染、不解析 explanation 串**；原文仍原样透传不裁剪——诚实红线不变，只把「零判定事实」结构化、把「引擎叙述」作原文备查。
- **E3 — 版块次序：答案卡 → 备选账本 → 推荐说明表 → 表单 → 证据抽屉。** 密集的推荐说明表置于轻量备选账本之下，给「强（深色答案）→ 轻（备选账本）→ 中（说明表）」节奏，避免两块重色面板相叠、避免说明表读作与答案卡竞争的第二答案。备选账本为语义 `<ol>`（去掉视觉序号，顺序由标记承载）。
- **E4 — 表单回显生效 setup（D5 细化）。** `usageProfile` 缺省/非法回显**引擎默认档**（非浏览器 `<select>` 首项，防「表面轻度、答案按中度算」自相矛盾 + 未改表单提交静默降档）；`currency` 回显生效币种；web-only 旋钮随抽屉排序链接**保留**（点排序不丢 usageProfile 回落默认）。
- **E5 — 预算非有限值边界即拒（D8 细化）。** 预算 wire 串数额溢出 `Infinity`（超大位数）在预算解析 schema 边界即 addIssue → 400（否则流进 `recommend()` 的 `.finite()` 抛 500）——单一 choke point、web + MCP 两路同护。
- **E6 — 去冗余重置入口。** 删页头孤立「清除配置」链接（对默认页是空操作、与表单「重置」重复），表单「重置」为单一「重来」入口；页面地标仍 banner + `role="search"` 表单 + main + skip-link。

## 风险 / 权衡

- **`recommend()` async 化 handler** → SSR handler 变 async 调用引擎。缓解：Hono handler 原生支持 async；`getSnapshot` 仍注入、`app.request` 直测；引擎纯函数无 IO（explain v1 模板亦无 IO），性能可忽略。
- **currency 默认与「不跨币比价」** → 引擎 per-currency，默认 `DEFAULT_CURRENCY`。缓解：默认币种给答案 + 「描述你的配置」可切币；引擎已处理「无该币种候选」guidance，web 直显。
- **答案 primary 与抽屉表「最划算」可合法分歧（非 bug）** → 二者**都经 vetted 引擎、均不手搓**，但**口径不同**：`recommend` primary = 最便宜 **eligible**（额外排除 待复核/超预算/撞窗 exceeds/未核，见 `recommend.ts:classify`），`queryModelRadarSnapshot` cheapest 仅排除**停售**（`query.ts:166`）。故表内最便宜非停售 plan 恰为待复核/超预算/撞窗时，二者**指向不同 plan**——这是预期分歧。缓解：页面 MUST NOT 断言二者相等；测试**用 recommend 自身输出对账**（不依赖 A 表标级）：`primary.planId===cheapestPlanId ∨ candidates.find(c=>c.planId===cheapestPlanId)?.verdict ∈ {not_recommended, insufficient_data} ∨ 该 cheapest 不在同币种候选集`——对所有分歧因（待复核/超预算/撞窗）均可满足，避免 flaky 测 + 避免有人为「修」它去手搓 cheapest 违 money-path；分歧时落选缘由由答案区 explanation 交代。
- **thin-data 空态易被做成「友好但编造」** → 缓解：空态**只透传引擎 guidance 字符串**，web 不自撰推荐；review 期 Reality Checker 专项校「无 primary 时不出现任何被包装成推荐的方案名」。
- **IA 翻转的回归面** → 比价表从主体变抽屉，A 的结构测需适配（表仍在 DOM、只是包在 details 内）。缓解：复用组件、结构测改断言「表在证据 `<details>` 内」而非「表在 main 顶层」。
