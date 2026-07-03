# 实现任务

## 1. 路由改答案优先：调 recommend() 组装答案页（`model-radar-page.tsx`）

- [x] 1.1 `GET /model-radar` handler 转 **async**：解析 query → 组 `RecommendInput`（仅 model/tool/protocol/currency/maxMonthlyPrice/usageProfile；沿用注入式 `getSnapshot`）→ `await recommend(snapshot, input)`；快照 fail-closed 503、CSP、serveStatic 字体路由、no-version-304 全部沿用
- [x] 1.2 按结果 `verdict` 分流组装页面外壳：答案区（primary 卡 或 无-primary 时引擎 guidance）→ 备选区（前 3 alternative）→「描述你的配置」输入区 → 证据抽屉（既有比价表）；**MUST NOT** 在 web 层重排/重判/重算 primary 或手搓 cheapest
- [x] 1.3 引擎入参边界：`getModelRadarSnapshot()` 取 `.snapshot`；web-only 参数不喂引擎；`currentPrice=null` 显式占位不 format
- [x] 1.4 **setup 校验/适配边界（在 `await recommend()` 之前，防公开页崩溃/fail-open）**：① schema 参数（model/tool/protocol/currency/**`maxMonthlyPrice`**——用既有 wire 键名、**不新造 `budget` 键**）经 `modelRadarQueryParamsSchema` 校验（该 schema 已 strict + superRefine、是 `ZodEffects`，**直接 `.parse()`、不调 `.strict()`**），ZodError → **400**（不让其流进 recommend 抛 500）；② 预算 wire `maxMonthlyPrice="100 CNY"` 解析为 `{amount,currency}` → 派生数值 `maxMonthlyPrice=amount` + **币种优先级 `currency = 显式 currency ?? 预算串币种 ?? 默认`**（显式与串币种冲突 → 400），MUST NOT 把串当数值；③ `usageProfile`（web-only、不在 schema）校验枚举（light/medium/heavy），非法 **clamp 到引擎默认**（软旋钮，防 `USAGE_KNOBS[非法]` TypeError；不崩、不 400）；校验只做解析/边界/映射，不复制引擎判定

## 2. 答案层组件（新增 `src/mr/web/answer.tsx`）

- [x] 2.1 `AnswerCard`（hero，primary）：方案名 + 厂商 + 月成本（primary 恒已核，复用币种呈现约定/取整 helper）+ **fitsWindow 结论**（fits 够用/exceeds 不够/unknown 未知）+ reasons + provenance（经 `safeHref`）+ **新鲜度**（`candidate.stale` + 该候选 `provenance.lastCheckedDate` 价格事实 age，均取自 RankedCandidate 自带字段；**不**声称聚合「最旧事实」——全量 per-fact 最旧在抽屉 A 表 Q4 列）
- [x] 2.2 `ExplanationNote`（**所有状态**的答案区从属「推荐说明」区，非卡，`white-space: pre-line` 保 `\n`）：**原样**渲染 `result.explanation`（引擎全量逐候选叙述：含首选复述 + 备选 + 落选，每条带诚实标级 + reasons/provenance + guidance）——无 primary 时是唯一答案内容（醒目）；有 primary 时卡下方从属（视觉次于卡/可折叠、明确 label，不作竞争的第二答案），已含更便宜 plan 落选缘由；**与卡的首选/备选重复是有意的**（零判定/honesty 优先），**MUST NOT** 裁剪/解析串剔除首选行，MUST NOT 编造首选或把候选另提升为 answer/alternative 卡
- [x] 2.3 `AlternativeCards`（前 3 alternative）：方案/厂商/月成本（恒已核）/fitsWindow/provenance；>3 显「另有 N 个备选」并以**页内锚点**指向证据抽屉（可操作、非静默截断）
- [x] 2.4 `SetupForm`（「描述你的配置」）：原生 `<form>` + **`<fieldset>`+`<legend>「描述你的配置」`分组**；控件（usageProfile 用带 label 的 `<select>` light/medium/heavy）、query 参数、无 JS 回退；每控件保留 `<label for>` 可及名（改措辞不剥离）；复用 A 的 `--border-control`/outline 焦点/目标 ≥24px
- [x] 2.5 `fitsWindow==='unknown'` 时 `AnswerCard` 把「额度未知、无法确认是否够用」警告**在 DOM/源序上先于结论元素**（一等公民、非用 CSS `order` 视觉前置）；纯呈现 helper（映射 verdict/fitsWindow → 文案/CSS 记号）可放 render.ts，但**判定逻辑不改**

## 3. 证据抽屉 + CSS（`components.tsx`）

- [x] 3.1 把变更 A 的比价表（`GroupTable` 等）**原样复用**包进 `<details>`（默认折叠、原生无 JS、aria 契约随组件带入），`<summary>` **描述性**点明「查看全部方案对比与依据（含各方案含哪些模型/工具、新鲜度）」（2.4.6）；**抽屉表查询只传召回维度 `{category,model,tool,protocol}`、不传 `currency`/`maxMonthlyPrice`**（否则 `matchesFilters` 滤掉超预算/他币种 plan，使答案区引用的落选候选在证据里不可见）；以 A 表原样 + A 既有标级（停售/未核/待复核/陈旧/最划算）呈现；**MUST NOT 向 A 表注入 recommend 的 verdict/超预算/撞窗列**（口径/结构不变）
- [x] 3.2 答案卡/备选卡/输入区/抽屉的 CSS：复用 A 的 surface/token/圆角/阴影/accent/状态 ramp；答案卡为最高抬升 surface；**mobile-first 单列堆叠**（窄屏优先、320px 无表外双向横滚）；状态记号 CSS 绘制 + 文字（无 emoji）
- [x] 3.3 复用 A 的 a11y：forced-colors 兜底真实 border、outline 焦点、逐层对比度 ≥4.5:1/UI ≥3:1、skip-link/地标/`lang`/反映 setup 的 `<title>`、View Transitions（reduced-motion 置零伪元素）

## 4. 测试（`src/mr/web/__tests__`）

- [x] 4.1 primary 答案卡：注入含 eligible 的快照 → 断言页顶答案卡含 primary 方案名/月成本/fitsWindow 结论/新鲜度；备选区含前 3 alternative + >3 时的溢出披露
- [x] 4.2 **thin-data 诚实**：注入全未核/停售快照（无 eligible）→ 断言答案区显引擎 `explanation`、**无任何 plan 出现在 answer/alternative 卡元素内**（断言 card 元素，非裸 `not.toContain(name)`——explanation 文本本就含带诚实标级的候选名）；fitsWindow=unknown → 断言警告元素在 DOM 序上**先于**结论元素；not_recommended/insufficient_data 不进答案/备选卡
- [x] 4.3 输入 + 空态 + **校验边界**：裸 `/model-radar` 有 eligible 给默认答案、无则显 guidance（皆不空白）；`usageProfile=heavy` 改变答案；`?usageProfile=ultra` → 不崩（clamp 默认）；`?model=glm`（缺冒号）→ **400 非 500**；`maxMonthlyPrice="100 CNY"` 解析为数值+币种（`?maxMonthlyPrice=100 USD` 无显式 currency → 用串币种 USD 非默认 CNY）；无 JS 提交即整页 GET
- [x] 4.4 证据抽屉 + 四问：断言比价表在 `<details>` 证据区内（非 main 顶层）、口径/标级不变、**未注入 verdict 列**、抽屉表按召回维度过滤（超预算/他币种 plan 仍可见）；答案卡答 Q3、抽屉表答 Q1/Q2/Q4；primary 与该组 cheapest 皆 vetted 不手搓、口径不同可分歧——断言**用 recommend 自身输出对账**：`primary.planId===cheapestPlanId ∨ candidates.find(c=>c.planId===cheapestPlanId)?.verdict ∈ {not_recommended, insufficient_data} ∨ 该 cheapest 不在同币种候选集`（对所有分歧因 待复核/超预算/撞窗 均可满足、不依赖 A 表标级，不断言恒等）；注入「更便宜候选超预算/撞窗」快照 → 断言 primary≠cheapest 且答案区说明交代其缘由
- [x] 4.5 carry-over + **新表面**：a11y 硬清单（skip-link/地标/aria/th scope/detail-row/无 emoji/`<fieldset><legend>`）、新表面覆盖（答案卡/备选卡逐层对比度实测 ≥4.5:1、SetupForm 控件目标 ≥24px、320px 单列无表外横滚、forced-colors 卡真实 border、outline 焦点、thin-data 态 `<title>` 有意义）、money-path/判定/recommend.ts 无回归；全量本域测绿、tsc 0

## 5. 目视校验

- [x] 5.1 起本地 dev server（注入 fixture 快照）浏览器核对：答案卡 hero / 3 备选 / 「描述你的配置」/ 证据抽屉展开 / 空态诚实 / 窄屏单列；必要时微调 CSS

## 6. 设计精修 + review-loop 修复（实现后，见 design.md E1–E6）

- [x] 6.1 深色定论面板 hero + 品牌头（E1）：答案卡 `--brand-navy` 面板、品牌标识 + tagline；深色面板文字/徽标/焦点环对 brand-navy 真实底逐层重验 ≥4.5:1（UI/焦点 ≥3:1）
- [x] 6.2 推荐说明 = 结构化表 + 折叠原文（E2）：从 `result.candidates` 渲染逐候选 判级/月成本/撞窗/缘由表（落选按 verdict 标级），引擎 `explanation` 原文降为可折叠 `<details>`
- [x] 6.3 版块次序 答案卡 → 备选账本 → 推荐说明表 → 表单 → 证据抽屉（E3）；备选改语义 `<ol>` 去视觉序号
- [x] 6.4 **[review-loop 修复]** 无 primary 时引擎 `explanation` 原文 `<details>` 默认展开（`open={!hasPrimary}`）——修零候选态答案区近空白
- [x] 6.5 **[review-loop 修复]** 表单回显生效 setup（E4）：`usageProfile` 缺省/非法回显引擎默认档（非浏览器首项，防自相矛盾 + 静默降档）；`currency` 回显生效币种
- [x] 6.6 **[review-loop 修复]** web-only `usageProfile` 随证据抽屉排序链接保留（点排序不静默丢失回落默认）
- [x] 6.7 **[review-loop 修复]** 预算数额溢出非有限值（`Infinity`）在预算解析边界即拒 → 400（防流进 `recommend()` 的 `.finite()` 抛 500）
- [x] 6.8 **[review-loop 修复]** 深色答案卡焦点环改 accent-lift（对深底 7.4:1；默认 accent 仅 2.74:1，破 WCAG 2.4.11/1.4.11）
- [x] 6.9 **[review-loop 修复]** 修内联 `<style>` 内 `>` 子代组合符被 hono/jsx 转义为 `&gt;` 致失效的死规则（`.evidence-drawer > summary` 改类名 `.evidence-summary`）
- [x] 6.10 文案精简 + 去冗余重置（E6）：删页头孤立「清除配置」链接（表单「重置」为单一入口）、收紧说明/提示/summary 文案（保 a11y 可及名与诚实标注）
- [x] 6.11 回归测试：新增 usageProfile 默认档 / 排序链接保留 / 非有限预算→400 / 无 primary 原文展开 四项断言；全量本域测绿（tsc 0）
