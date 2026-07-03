# model-radar-answer-first-web 规范

## 目的
待定 - 由归档变更 add-model-radar-answer-first-web 创建。归档后请更新目的。
## 需求
### 需求:答案优先页必须由推荐器引擎驱动、只做呈现层不重判定

`GET /model-radar` MUST 呈现为**答案优先**页：SSR 把校验后的 setup 参数适配成 `RecommendInput`（见下「输入校验边界」需求），调 **`await recommend(getModelRadarSnapshot().snapshot, input)`**（`src/mr/recommend/recommend.ts`，本变更 MUST NOT 改其召回/评分/`verdict`/`fitsWindow`/guidance 逻辑），并按结果 `candidates[].verdict` 四态分流渲染（`candidates` 扁平，web 按 verdict **过滤**取 primary/alternative，非重排/重判）。页面 MUST NOT 在 web 层重排 / 重判 / 重算 primary 或手搓 cheapest（沿用「不在裸快照上手搓、经 vetted 引擎」红线）。`monthlyCost`/`currency` 展示 MUST 复用既有「币种代码 + 空格 + 金额」约定与展示取整 helper、MUST NOT 进 money-path。页面仍只读（`getModelRadarSnapshot()`，不查规范化 `mr_*`、不写库、不 bump version）、冷启动首建失败 MUST 返回 503（fail-closed）、MUST NOT 用 snapshot version 作 HTML 的 ETag/304（沿用比价页 live-age 约定）。

#### 场景:答案由引擎输出映射而非 web 重判
- **当** 用户带 setup 参数请求 `/model-radar`
- **那么** 页面调 `recommend()` 取结构化结果，按 `candidates[].verdict` 过滤渲染答案/备选/证据，不在 web 层另算 primary 或排序

#### 场景:只读 + fail-closed 沿用
- **当** 冷启动首建快照失败
- **那么** 页面返回 503、不渲坏快照；正常路径只读取快照、无任何写库 / version bump

### 需求:setup 参数必须经 web 层校验并适配为 RecommendInput，畸形输入不得使页面崩溃

页面 MUST 在调 `recommend()` **之前**于 web 层校验 / 适配 setup query 参数——`recommend()` / `recall` 内部对畸形入参会抛（`recall` 的 `modelRadarQueryParamsSchema.parse` 对无冒号 `model` / 空 `tool`·`protocol` 抛 ZodError；`USAGE_KNOBS[非法 usageProfile]` 为 undefined → `knobs.demandedRounds` **TypeError 崩**），公开页 MUST NOT 因此返回未捕获 500 / 崩溃（fail-open）。具体：① schema 内参数（`model`/`tool`/`protocol`/`currency`/`maxMonthlyPrice`——**用既有 wire 键名 `maxMonthlyPrice`（值形如 `"100 CNY"`），不新造 `budget` 键**，否则 strict schema 拒未知键）MUST 经既有 `modelRadarQueryParamsSchema` 校验（该 schema **本已 strict + superRefine**、是 `ZodEffects`、**无 `.strict()` 方法**，直接 `.parse()`），ZodError → **400**（沿用 compare-api 边界，MUST NOT 让其流进 `recommend()` 抛）；② **预算格式适配**：`maxMonthlyPrice` wire 串经 schema 解析为 `{amount, currency}`，MUST 派生 `recommend()` 需要的**数值** `maxMonthlyPrice=amount`；**币种优先级 `currency = 显式 currency 参数 ?? 预算串币种 ?? 默认`**（避免 `?maxMonthlyPrice=100 USD` 无显式 currency 时把 USD 金额误配默认 CNY 组），显式 `currency` 与预算串币种并存且不一致 → 400（schema superRefine 已守）；预算 wire 串**数额溢出为非有限值**（如 400 位数字经 `Number()` 溢出 `Infinity`）MUST 在预算解析边界即拒 → 400（否则 `Infinity` 流进 `recommend()` 的 `maxMonthlyPrice: z.number().finite()` 抛未捕获 500）；③ web-only 的 `usageProfile` 不在 schema 内、且 schema 已 `.strict()`（拒未知键）——故 MUST **先从待 `.parse()` 的 query map 里剔除 `usageProfile`（及其它 web-only 键）**，否则每个带 `usageProfile` 的请求都会因未知键 400；`usageProfile` 单独校验枚举（light/medium/heavy），非法值 **clamp 到引擎默认**（软旋钮、只影响 fitsWindow 估算，clamp 不崩不 400、不隐藏硬错误）。（`currency` 非法由本 schema 直接 →400、不进 `recommend()`。）校验/适配 MUST NOT 复制或绕过引擎判定，只做「解析 + 边界 + 映射」。

#### 场景:畸形 usageProfile 不崩溃
- **当** 请求 `/model-radar?usageProfile=ultra`（非法枚举）
- **那么** 页面 clamp 到引擎默认 usageProfile 正常给答案，不抛 TypeError / 不返回 500

#### 场景:畸形 schema 参数 → 400
- **当** 请求 `/model-radar?model=glm`（缺冒号，`modelRadarQueryParamsSchema` 判非法）
- **那么** 页面在 web 层返回 400，MUST NOT 让 ZodError 流进 `recommend()` 成未捕获 500

#### 场景:预算数额溢出非有限值 → 400 非 500
- **当** 请求 `/model-radar?maxMonthlyPrice=<400 位数字> CNY`（`Number()` 溢出 `Infinity`）
- **那么** 预算解析边界即拒、返回 400，MUST NOT 让 `Infinity` 流进 `recommend()` 的 `.finite()` 抛未捕获 500

#### 场景:预算 wire 格式适配为数值 + 币种优先级
- **当** 用户设 `maxMonthlyPrice="100 CNY"`（既有键名）
- **那么** web 解析出数值 `maxMonthlyPrice=100` + `currency=CNY`（币种取 `显式 currency ?? 预算串币种 ?? 默认`）喂 `recommend()`，不把串当数值；显式 `currency` 与预算串币种冲突则 400

### 需求:答案卡必须呈现唯一 primary 首选含月成本撞窗结论与新鲜度

页面 MUST 把 `verdict==='primary'` 的候选（引擎保证至多 1 个）渲染为**页面最上的答案卡（hero）**，含：方案名 + 厂商 + `monthlyCost`（月成本；primary 恒为已核价，非空）+ `currency` + **`fitsWindow` 撞窗结论**（`fits`「额度够用」/`exceeds`「额度不够」/`unknown`「额度未知」）+ 引擎给的 `reasons`（规则原因）+ 该方案 `provenance`（经 `safeHref` scheme 闸）+ **新鲜度**（`candidate.stale` 陈旧标 + 该候选 `provenance.lastCheckedDate` 的价格事实 age，均取自 `RankedCandidate` 自带字段、显式置于卡上；**全量 per-fact「最旧事实」新鲜度在证据抽屉的 A 表 Q4 列**，答案卡不声称聚合最旧）。答案卡 MUST 只呈现引擎判定，MUST NOT 附 web 自撰的推荐结论。

#### 场景:primary 答案卡呈现完整结论
- **当** 引擎返回一个 `primary` 候选
- **那么** 答案卡显示 方案/厂商/月成本/币种/fitsWindow 结论/reasons/provenance/新鲜度（stale + 价格事实核对日），且不出现 web 自撰的额外推荐话术

#### 场景:陈旧或待复核方案入选仍诚实标注
- **当** `primary` 候选 `stale=true`
- **那么** 答案卡显式标「陈旧」，不把它伪装成新鲜

### 需求:备选卡必须呈现至多 3 个 alternative

页面 MUST 在答案卡下方渲染 `verdict==='alternative'` 的候选作**备选卡**，至多 3 张（引擎 `candidates` 已按同币种已核升序，web 过滤 alternative 取前 3、不重排）；若 alternative 多于 3，MUST 显「另有 N 个备选」并以**页内锚点**指向证据抽屉（非静默截断、非无操作路径）。每张备选卡含 方案 + 厂商 + 月成本（恒已核）+ `fitsWindow` + provenance。备选卡 MUST NOT 冒充 primary。

#### 场景:前 3 备选 + 溢出可达披露
- **当** 引擎返回 5 个 `alternative`
- **那么** 渲染前 3 张备选卡 + 显「另有 2 个备选」并链到证据抽屉（可操作锚点），不静默丢弃

### 需求:thin-data 诚实红线——无假 primary、撞窗未知警告先行、落选不进卡

页面 MUST 守 thin-data 诚实（复用引擎已有诚实语义、MUST NOT 在 web 复制或绕过判定）：① 答案区 MUST 提供**从属的「推荐说明」区**，含两层：**(a) 结构化「推荐说明表」**——从 `result.candidates`（结构化字段、**非解析 `explanation` 串**）渲染，逐候选一行：判级（【首选】/【备选】/【不推荐】/【待核】，CSS 上色 + 文字、无 emoji）/ 月成本（`monthlyCost!==null && currency!==null` 否则显「待核」）/ `fitsWindow` 撞窗 / 缘由（`reasons`），**含全部落选候选**（`not_recommended`/`insufficient_data` 按其自身 `verdict` 如实标级，非隐藏）；**(b) 引擎全量 `result.explanation` 原文**（引擎逐候选叙述含首选复述 + guidance）作可折叠 `<details>`，**MUST 原样透传不裁剪**（`white-space: pre-line` 保 `\n`/`\n\n`）。**无 primary 时**推荐说明区是唯一答案内容、呈现醒目：原文 `<details>` MUST **默认展开（`open`）**，不让 guidance 折在默认收起的抽屉里使答案区近空白；**有 primary 时**它在卡下方作从属说明（视觉次于卡、原文 `<details>` 折叠、明确 label，不读作与答案卡竞争的第二答案），其中已含「更便宜 plan 为何未入选（超预算/撞窗/待复核）」的缘由。**与卡的重复（首选/备选在表与卡各现一次）是有意的**——honesty/零判定优先于去重；表 MUST 从结构化 `candidates` 渲染、**MUST NOT** 解析/裁剪 `explanation` 串来构造或剔除行，MUST NOT 编造首选或把落选候选**提升为 answer/alternative 卡**；② `fitsWindow==='unknown'` 的答案卡 MUST 把「额度未知、无法确认是否够用」警告**置于结论之前、且在 DOM/源序上先于结论元素**（一等公民、非脚注、非仅 CSS 视觉重排）；③ `not_recommended`（停售/超预算/撞窗 exceeds）与 `insufficient_data`（未核价/待复核）候选 MUST NOT 进答案/备选卡——它们随证据抽屉的 A 表以 **A 自身既有标级**（停售/未核/待复核/陈旧/最划算）呈现，「超预算/撞窗」等 recommend eligibility 缘由**不注入 A 表**（A 表无此列）、由①的答案区说明交代。

#### 场景:无 eligible 显 explanation 不编造
- **当** 召回集内无 eligible 候选（全部未核/停售/超预算）
- **那么** 答案位显引擎 `explanation`（含 guidance 与诚实候选标级），页面不出现任何被**提升为答案/备选卡**的方案

#### 场景:推荐说明表从结构化 candidates 渲染、落选如实标级
- **当** 候选集含首选 + 备选 + 停售/未核候选
- **那么** 推荐说明表逐候选一行显 判级/月成本/撞窗/缘由，停售候选标【不推荐】、未核候选标【待核】且月成本显「待核」；表从 `candidates` 结构化渲染，不解析 `explanation` 串

#### 场景:无 primary 时引擎原文默认展开
- **当** 无 primary（含零候选时推荐说明表为空）
- **那么** 引擎 `explanation` 原文的 `<details>` 默认展开（`open`）、guidance 可见不折叠；有 primary 时该 `<details>` 折叠、从属于答案卡

#### 场景:有 primary 但更便宜候选分歧时缘由仍可见
- **当** primary 存在，但抽屉表该组「最划算」是一个更便宜却 `not_recommended`（如超预算/撞窗）的 plan（primary ≠ cheapest）
- **那么** 答案卡下方「说明」区（渲染 `result.explanation`）交代该更便宜 plan 的落选缘由，用户不必困惑「为何不是最便宜的」；该 plan 仍在抽屉可见但不被提升为卡

#### 场景:撞窗未知警告 DOM 先于结论
- **当** `primary` 候选 `fitsWindow==='unknown'`（额度信息缺失）
- **那么** 答案卡在源序上先渲「额度未知、无法确认是否够用」警告元素、再渲结论（非用 CSS `order` 视觉前置）

#### 场景:落选候选不进卡、缘由在答案区
- **当** 某召回方案 `verdict` 为 `not_recommended` 或 `insufficient_data`
- **那么** 它不进答案/备选卡；在证据抽屉 A 表以 A 标级呈现，其落选缘由（超预算/撞窗/未核/停售）在答案区 guidance 说明

### 需求:「描述你的配置」输入区必须原生可用、分组可及且无 JS 回退

页面 MUST 提供「描述你的配置」输入区（措辞面向「说清你的编程场景」，非「过滤器」），收集 `model` / `tool` / `protocol` / `currency` / 预算（wire 键名 `maxMonthlyPrice`，值形如 `"100 CNY"`）/ `usageProfile`，MUST 用原生 `<form>` 且**用 `<fieldset>` + `<legend>「描述你的配置」` 分组**（给相关控件可及的组语义，1.3.1/3.3.2）；`usageProfile` 用带 label 的 `<select>`（light/medium/heavy）；每控件 MUST 保留 `<label for>`/包裹关联的可及名（改措辞不得剥离可及名）；经 query 参数提交、整页 GET、**渐进增强无 JS 可用**。表单回显 MUST 反映**生效的 setup**、不误导：`usageProfile` 缺省/非法时 MUST 回显**引擎默认档**（`DEFAULT_USAGE`，即页面实际据以算答案的档），MUST NOT 让 `<select>` 落到浏览器默认首项（否则表面显「轻度」而答案按「中度」算、自相矛盾，且未改表单提交即静默降档）；`currency` 回显**生效币种**（`显式 ?? 预算串币种`，预算 `100 USD` 无显式 currency 时下拉如实显 USD）。web-only 旋钮（`usageProfile` 等）MUST 随证据抽屉内的排序链接**保留**，点排序不得静默丢失该设定回落引擎默认。裸 `/model-radar`（无 setup）MUST 用引擎默认给答案：**有同币种 eligible 时给默认答案（引擎升序首个 eligible），无时显引擎 guidance**，二者皆不空白/不报错 + 提示「描述你的配置以精确」。输入控件 MUST 满足变更 A 的 a11y（`--border-control` ≥3:1 静息边框、outline 焦点、目标 ≥24px、label 关联）。

#### 场景:无 JS 提交即整页 GET
- **当** 用户填「描述你的配置」并提交（禁用 JS）
- **那么** 整页 GET 携 query 参数重渲、给对应答案；无客户端 JS 参与

#### 场景:裸页给默认答案或 guidance 皆不空白
- **当** 用户访问不带任何 setup 的 `/model-radar`
- **那么** 有同币种 eligible → 给引擎默认答案；无 → 显引擎 guidance；两种都不空白/不报错，并邀请描述配置

#### 场景:表单回显生效档、不误导
- **当** 裸 `/model-radar`（无 `usageProfile`）——页面按引擎默认档算答案
- **那么** `usageProfile` `<select>` 回显引擎默认档（非浏览器默认首项），表面档位与答案据以计算的档位一致

#### 场景:排序链接保留 usageProfile
- **当** 用户带 `?usageProfile=heavy` 后点证据抽屉表内的排序链接
- **那么** 排序链接 URL 保留 `usageProfile=heavy`，重渲不静默丢失该设定回落引擎默认 medium

### 需求:比价表必须作为可展开证据抽屉嵌入答案页且四问仍可答

页面 MUST 把变更 A 的比价表（5 列主行 + 详情行，**组件原样复用、口径/结构/最划算/provenance/A 既有标级不变**）整体包进默认折叠的原生 `<details>`「证据抽屉」（`<summary>` MUST 描述性、点明内含全部方案对比与依据即答 Q1/Q2/Q4，2.4.6；无 JS 可展开、`aria` 契约随组件带入）。抽屉的表查询 MUST **只传召回维度 `{category, model, tool, protocol}`**（与 recommend 的 `recall` 同维度）、**MUST NOT 传 `currency`/`maxMonthlyPrice`**——否则 A 的 `queryModelRadarSnapshot`(`matchesFilters`) 会按预算/币种**滤掉**超预算 / 他币种 plan，使答案区 guidance 引用的「放宽预算/他币种有 N 个」在证据里**不可见**。故超预算 / 撞窗 / 他币种的落选候选**仍在抽屉可见**（以 A 自身既有标级呈现，无注入 recommend 列），其落选缘由由答案区说明交代。**MUST NOT 向 A 表注入 recommend 的 `verdict`/超预算/撞窗列**（A 表无此列，注入即违「口径/结构不变」）。四问 MUST 仍可答：答案卡答 Q3（同档谁最划算），证据抽屉 A 表答 Q1（谁含某模型）/ Q2（谁支持某工具协议）/ Q4（谁最近被核对或最陈旧）。

#### 场景:证据抽屉含 A 表原样、默认折叠、summary 描述性
- **当** 渲染答案页
- **那么** 答案卡/备选卡下有默认折叠的 `<details>` 证据区，`<summary>` 点明内含「全部方案对比与依据」，展开即见变更 A 的比价表（口径/标级不变、无注入 verdict 列），无需 JS

#### 场景:四问经答案+抽屉可答
- **当** 用户要回答四问
- **那么** 答案卡答「同档最划算」，证据抽屉 A 表答「谁含某模型/谁支持某工具协议/谁最近被核对或最陈旧」

### 需求:答案页必须复用变更 A 的视觉系统与 WCAG 2.2 AA 契约且 mobile-first

答案页 MUST 复用变更 A 的产品仪表面板设计系统与 a11y 契约：分层 surface token、自托管 Hanken Grotesk、CSS View Transitions（reduced-motion 置零伪元素）、**`forced-colors` 兜底真实 border**、**`outline` 焦点环（非 box-shadow）**、目标 ≥24px、`.table-scroll` 单向横滚 reflow、skip-link / 地标 / `lang`；状态记号 MUST 由 CSS 绘制 + 文字标签承载（无 emoji）；`source_url` MUST 经 `safeHref` 单闸（危险 scheme 降级纯文本）；CSP（含 `font-src 'self'`）与 `coding_plan` gate 不变。**新表面（答案卡为深色定论面板 hero、备选账本、警告文本）的逐层文字对比度 ≥4.5:1 / UI ≥3:1 MUST 对其真实背景值重新核验**（MUST NOT 因「复用 A token」假定达标——A 只验过自身浅色表面；尤其警告/次级文字、**焦点环**在深色答案卡底上）。**深色答案卡上的 `outline` 焦点环 MUST 对深底 ≥3:1**：页面默认 accent 焦点色对深色答案卡底仅 2.74:1（破 WCAG 2.4.11/1.4.11），故卡内焦点环 MUST 改用对深底达标的色（如 accent-lift ≈7.4:1）。`<title>` MUST 反映 setup 且在**所有四态**（含无 primary 的 guidance 态）保持有意义（无答案时不用「答案」措辞误导，2.4.2）。布局 MUST **mobile-first**：答案卡 / 备选卡 / 证据抽屉在窄屏优先单列堆叠、320px 无表外双向横滚（仅 `.table-scroll` 单向横滚）。

#### 场景:窄屏单列堆叠可用
- **当** 在 320px 宽 / 400% 缩放下浏览答案页
- **那么** 答案卡/备选卡/输入区/抽屉单列堆叠、无表外双向横滚、所有交互目标 ≥24px、焦点环可见

#### 场景:新表面对比度按真实背景重验
- **当** 答案卡/备选卡上呈现正文、警告、次级、provenance 链接文字
- **那么** 各文字对其真实卡背景值实测 ≥4.5:1（UI/焦点 ≥3:1），不沿用 A 表面的达标假定

#### 场景:thin-data 态 title 仍有意义
- **当** 无 primary（guidance 态）
- **那么** `<title>` 反映 setup 且不用「答案/推荐」误导措辞（如「未找到匹配 · Model Radar」）

