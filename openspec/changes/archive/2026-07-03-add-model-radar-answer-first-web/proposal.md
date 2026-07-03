## 为什么

Model Radar 现有 Web 前端（变更 A）是一张**比价表**——信息密集、但要用户自己扫读得结论。项目定位是「AI 工具**选型顾问**」，不是「表格浏览器」。而选型引擎（5e 推荐器 `recommend()`，`src/mr/recommend/recommend.ts`）**已经建好**：确定性规则召回 + `fitsWindow` 撞窗原语 + 四态有序 `verdict` + 空结果诚实 guidance——但它**只暴露在 MCP 工具**里，网页用户看不到。

本变更（**B，两段式的第二段**，A 设计系统已合并归档、是前置）把推荐器搬上网页作**主角**，翻转信息架构：从「一张表」翻成「**先给答案 + 表作证据**」。答案层复用现有 `recommend()` 引擎（**不改判定/口径**），表层复用变更 A 的 5 列表 + 详情行（降为可展开证据抽屉）。

## 变更内容

- **推荐器上网作 hero（新 capability `model-radar-answer-first-web`）**：`GET /model-radar` 从「表优先」翻成「答案优先」。SSR 读 query 参数 → 组 `RecommendInput`（model? / tool? / protocol? / currency? / maxMonthlyPrice? / usageProfile: light|medium|heavy）→ `await recommend(snapshot, input)` → 渲染答案。**只做呈现层**，召回/评分/verdict/guidance 全由 `recommend()` 产出。
- **答案卡（primary）在最上**：`verdict==='primary'` 候选 → 方案名 + 厂商 + 月成本 + **撞窗结论 `fitsWindow`（fits/exceeds/unknown）** + 规则 reasons + provenance + **新鲜度头条（`candidate.stale` + 价格事实核对日 age，候选自带；全量最旧事实在证据抽屉 Q4）**。其下 **3 张备选卡**（`verdict==='alternative'` 前 3）；答案区另有渲染 `result.explanation` 的「说明」区（交代备选/落选/分歧缘由）。
- **筛选区改叙「描述你的配置」**：同一批 query 参数，措辞从「过滤器」翻成「说清你的编程场景」（渐进增强、无 JS 可用、原生控件）。
- **比价表降为证据抽屉**：变更 A 的 5 列表 + 详情行**原样收进**一个默认折叠的原生 `<details>`「查看全部对比（证据）」区，作答案依据；表口径/结构/A 既有标级不变（复用组件），**不注入 recommend 的 verdict/超预算/撞窗列**。答案 primary 与表「最划算」皆经 vetted 引擎但口径不同（primary 额外排除待复核/超预算/撞窗），**可合法指向不同 plan**——页面不断言二者相等，分歧时缘由由答案区交代。
- **setup 校验/适配边界**：`GET /model-radar` 在调 `recommend()` 前于 web 层校验 setup 参数（`modelRadarQueryParamsSchema`，ZodError→400）、把预算 wire 串 `"100 CNY"` 派生为数值+币种、非法 `usageProfile` clamp 默认——**恢复翻转后被移进引擎内部的 compare-api `ZodError→400` 边界**，防公开页因畸形入参崩溃/fail-open。
- **thin-data 诚实红线（硬约束，复用引擎已有诚实语义）**：`primary` 不存在（无 eligible / 空召回）时 MUST 渲染 `recommend()` 的 `result.explanation`（含 guidance + 诚实候选标级），**MUST NOT 编造首选或把任何候选提升为推荐卡**；`fitsWindow==='unknown'` 警告作一等公民、DOM 序先于结论；`insufficient_data`（未核价/待复核）与 `not_recommended`（停售/超预算/撞窗 exceeds）候选 MUST NOT 进答案/备选卡（随抽屉 A 表以 A 标级呈现、缘由在答案区）。
- **mobile-first**：答案卡 / 备选卡 / 证据抽屉窄屏优先单列堆叠。

### 非目标

- **不改推荐器引擎**：`recommend.ts` / `schema.ts` / `explain.ts` / MCP 工具的召回/评分/`verdict`/`fitsWindow`/guidance 逻辑一律不动——本变更只**调用** `recommend()` 并渲染其结构化输出。
- **不改 money-path / 判定口径 / DTO / 数据层 / 快照**（仍 `getModelRadarSnapshot()` 只读、不查规范化表、不写库）。
- **不引客户端 JS 框架 / filter island**（近零 JS：SSR GET + 原生元素；复用 A 的 View Transitions）。
- **不做多桶**（仍 `coding_plan` gate）、**不做账号 / 个性化**。
- 不改变更 A 已交付的比价表口径/结构（只重定位为抽屉）。

## 功能 (Capabilities)

### 新增功能

- `model-radar-answer-first-web`: 答案优先页——SSR 调 `recommend()` 渲染 primary 答案卡 + 3 备选 + 「描述你的配置」输入区 + 新鲜度头条 + thin-data 诚实空态 + 证据抽屉容器；复用变更 A 设计系统与 WCAG 契约；mobile-first。

### 修改功能

- `model-radar-compare-web`: `GET /model-radar` 路由**改由答案优先页承载**（新 capability），既有 5 列比价表 + 详情行**降为该页内可展开的「证据抽屉」组件**（默认折叠、原生 `<details>`、无 JS）；表的口径 / 结构 / a11y 契约 / money-path **不变**，仅呈现位置从「页面主体」变为「答案下方的证据区」。四问仍可答（答案卡答「同档谁最划算」，抽屉答其余三问）。

## 影响

- **代码**：新增 `src/mr/web/answer.tsx`（答案卡 / 备选卡 / 「描述你的配置」`<fieldset>` 输入区 / 空态组件）；`src/mr/web/model-radar-page.tsx`（`GET /model-radar` handler 转 async：**先校验/适配 setup 参数（schema→400、预算 wire→数值+币种、usageProfile clamp）** → `await recommend(...)` → 组装答案页外壳 + 内嵌既有比价表作 `<details>` 抽屉）；`src/mr/web/components.tsx`（比价表组件重定位进抽屉、加答案区所需 CSS token 复用）；`render.ts` 判定逻辑不改（可加纯呈现 helper 映射 verdict/fitsWindow → 文案/记号）；调用 `recommend()`（`src/mr/recommend/recommend.ts`，不改）。
- **测试**：`src/mr/web/__tests__` 新增答案页断言（primary 卡 / 3 备选 / 空态显 guidance 不编造 / fitsWindow=unknown 警告先行 / 证据抽屉含比价表 / 四问可答 / a11y carry-over）；复用注入式快照 provider（不触 DB）。
- **红线**：thin-data 诚实（无假 primary、unknown 警告一等公民）；money-path / 推荐器引擎口径不改；SSR 近零 JS；WCAG 2.2 AA（复用 A：forced-colors / outline 焦点 / 逐层对比度 / 目标 ≥24px / reflow）；XSS `safeHref` 单闸；`coding_plan` gate；快照只读。
