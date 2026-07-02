## 上下文

比价页现状是「文档/报纸」视觉隐喻，用户三次反馈仍「不像 2026 产品」。两份独立评估收敛：**根因是设计语言（全平/无层次/无 token/无 webfont/emoji 状态/直角控件）与主界面（表作主角）**，不是配色。本变更是**两段式的第一段（A）**：只升级设计语言到「分层产品界面」，套在既有 5 列表+详情行结构上；答案优先 IA + 推荐器上网是变更 B。

技术事实（已核）：现 CSP = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`（字体被 `default-src 'none'` 拦，需加 `font-src 'self'`）；服务经 `createModelRadarWebApp`（Hono 4.12）`c.html()`，`@hono/node-server` 已在 deps（`serveStatic` 可用）；现无静态路由、无打包器。

## 目标 / 非目标

**目标：** 把比价页从「文档」翻成「分层产品界面」——层次/圆角/阴影/token/签名色+状态ramp、自托管 Latin webfont（数字+标题）、CSS View Transitions 转场、弃 emoji 改 CSS 状态标记、暗色-ready；套在既有 5 列表结构上，答案优先 IA 留给 B。

**非目标：** 不做答案优先 IA / 不接推荐器上网（B）；不改 money-path / 判定口径 / DTO；不引客户端 JS 框架 / filter island；不引中文 webfont；暗色实际调色延后。

## 决策（grill Q1–Q8）

**D1 — 近零客户端 JS（Q1=A）。** 交互仍 SSR GET / 原生元素；「2026 感」靠设计系统 + CSS View Transitions（纯 CSS）拿，不引框架/island。答案优先流程（B）也一个 GET 往返即可，故本期无需 JS；表已将在 B 降为证据层，「即时筛选 island」价值被消解、不做。

**D2 — 自托管 Latin webfont + serveStatic + CSP font-src（Q2=A）。** 数字用 tabular 面（价格列对齐扫读的核心）、标题用有性格的 grotesk（**避开 Inter/Space Grotesk 等 AI 收敛款**，选如 Hanken Grotesk / Geist / General Sans 一类，实现时定）；中文仍系统字体（苹方/雅黑优秀、中文 webfont 体积大不划算）。经 Hono `serveStatic` 供子集 `.woff2`（Latin + 数字子集，~10–20KB）+ `@font-face` + `font-display:swap`；CSP **加 `font-src 'self'`**。这是首个静态资源路由、无打包器（字体是静态文件）。备选「零资源纯系统字体」被否——用户要最大设计感、且价格数字专属面是实打实杠杆。

**D3 — 分层表面系统 + token 化 + 暗色-ready（Q3=A）。** page bg 微冷中性 → surface(#fff 抬升卡：圆角 8–12px + 微阴影 + ring 边)；比价表/筛选区各成抬升面板；弃 `border-radius:0` 与全平。颜色/间距/圆角/阴影/字阶全 CSS 变量。本期只交付亮色（全对比 ≥4.5:1），`prefers-color-scheme` 暗色作 fast-follow（token 留缝，届时只加暗色值 + 二次对比审计）。一个克制签名强调色 + 语义状态 ramp（fresh/stale/estimate/discontinued）。**禁**紫渐变 / glassmorphism / emoji-UI / hero-metric 巨号数字 / 侧边条 / 每段小标签（impeccable 明令）。

**D4 — CSS View Transitions（Q1 附带）。** `@view-transition { navigation: auto }`（纯 CSS，跨文档 MPA 转场，给现有整页 GET 往返 app 般动效），`prefers-reduced-motion` 关。零 JS、优雅降级。

**D5 — 弃 emoji 状态 → CSS 标记。** 现 `AgeBadgeView`/`AvailabilityBadgeView`/`EstimatedRounds`/最划算/最佳周期用 🟢🟡🔴⭐🏆🚫❓⚠ 装饰（AI-slop tell）。改为 CSS 绘制的圆点/形状记号（`::before`/伪元素/小 span，纯 CSS）。**文字标签一字不改**——状态仍由文字承载（不单靠颜色/形状），a11y 契约（emoji 曾 `aria-hidden`，现无 emoji、标记 `aria-hidden`）不变。

**D6 — 吸收 layout-refresh 的表结构与红线。** 5 列主行 / 全宽详情行 `aria-labelledby=plan-{id}` / `.detail-row` wrapper 非 `<dl>` grid / 季年付明细在详情 / availability+待复核入套餐格 / 陈旧入新鲜度列 / `bestPeriodSummary` 三元谓词+`displayMonthly` / 停售两行同降权 / carry-over ARIA / tabular 金额 / 四问 / 未核诚实 / XSS 单闸——**全部沿用、工作区已实现代码作基座**；本变更只换 `PAGE_CSS` + 字体 + 转场 + 去 emoji，不动这些结构与判定。

**D7 — 主流程近零 JS、a11y 契约不动。** 焦点环（新签名色 ≥3:1）、目标 ≥24px、reflow 横滚、skip-link、aria-sort/aria-current、sourceHost 链接名、lang/title/地标——全保留，只随新 token 重着色（对比仍 ≥4.5:1）。

## 风险 / 权衡

- **首个静态资源路由 + 字体 + CSP 改动** → 引入新基建面（serveStatic、字体子集、`font-src`）。缓解：字体是静态文件无需打包器、子集小、`font-src 'self'` 只放行同源、SSR 主体不变；测试断言 CSP 含 font-src、`@font-face`/`@view-transition` 存在。
- **font-display:swap 的 FOUT** → Latin 换字瞬间回退系统字体。缓解：`swap` 保证文字始终可读（无不可见期）；中文本就系统字体不受影响。
- **暗色 token-ready 但未交付** → 有人期待暗色。缓解：明确 fast-follow、token 已留缝、本期只承诺亮色。
- **弃 emoji 后状态辨识度** → 靠 CSS 标记 + 文字。缓解：文字标签一字未动（承载状态），标记只装饰；review 期 Accessibility 复核「状态不单靠颜色/形状」。
- **View Transitions 浏览器支持** → 旧浏览器无转场。缓解：纯增强、无则直接切换、不影响功能/a11y。
- **spec-code 漂移**（主规范仍 A-3 老布局 + emoji 承载、代码已 5 列 + 详情行）→ **已解决**：spec delta 用 8 条 MODIFIED 把既有需求（只读SSR/age徽标/估算/XSS-CSP/季年付折算/季年付溯源/最佳周期 共 7 条对齐 + WCAG 实质增强）同步到「详情行 + 主行最佳周期列 + CSS 记号 + font-src」现实，非仅 prose「吸收」；判定口径/money-path 不改。`目的` 概述段的 ⚠/🟢🟡 措辞由归档任务（tasks 0.2）同步。归档后主规范内部一致。
- **a11y 实现期回归风险**（新设计语言的 shadow/ring/色记号/webfont/转场恰是 forced-colors 会剥离、box-shadow 焦点环会被裁、tinted 面会跌破对比度的高发区）→ 缓解（已写进 WCAG MODIFIED 与 tasks）：focus 用 `outline` 非 box-shadow；面板分隔用真实 `border` + `@media (forced-colors: active)` 兜底；签名 accent **设计期定死**（承焦点环 ≥3:1 与白字填充 ≥4.5:1 双角色）；对比度**逐层**核对（page-bg / surface / tinted pill）非只对 `#fff`；reduced-motion 须置零 `::view-transition-*` 伪元素而非仅省 at-rule；swap 换字用 `size-adjust` 压价格列 CLS；数字面须确含 `tnum`；暗色块本期**全有或全无**不半填。
