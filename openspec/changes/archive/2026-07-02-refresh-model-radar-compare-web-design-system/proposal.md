## 为什么

比价页经两次换皮（「账本/精密仪表」→「墙报式编排」）后用户仍反馈「不像 2026 前端产品」。两份独立评估（Product Manager + Frontend Developer）+ grill Q1–Q8 得出诊断：**问题不在配色，在设计语言与主界面**——现状是「文档/报纸」隐喻（全平白面、发丝线、直角控件、emoji 当状态、无层次/token/webfont），2026 产品读作**分层产品界面**（背景→表面→抬升的层次、圆角+微阴影、专属字体、克制动效、CSS 状态标记）。本变更（**A，两段式的第一段**）只做**设计语言升级**，套用在现有 5 列表 + 详情行结构上；**答案优先 IA + 推荐器上网是后续变更 B**，不在本期。

本变更**取代并吸收**已删除的 `refresh-model-radar-compare-web-layout`（墙报表格版从未合并）：其经 3 轮 review 磨出的「表作证据层」结构与红线全部沿用，工作区已实现代码作基座。

## 变更内容

- **设计语言：文档 → 分层产品界面。** page bg 微冷中性 → surface 抬升面板（圆角 + 微阴影 + ring 边）；比价表 / 筛选区各成抬升卡；弃 `border-radius:0` 与全平；统一间距节奏。
- **设计 token 化 + 暗色-ready。** 颜色 / 间距 / 圆角 / 阴影 / 字阶全走 CSS 变量；本期只交付**亮色**（对比 ≥4.5:1），`prefers-color-scheme` 暗色作紧接 fast-follow（token 已留缝）。一个克制签名强调色 + 语义状态 ramp（fresh / stale / estimate / discontinued），无紫渐变 / 无 glassmorphism / 无 emoji-UI。
- **自托管 Latin webfont（数字 + 标题）。** 经 Hono `serveStatic` 静态路由供子集 `.woff2` + `@font-face` + `font-display:swap`；**CSP 加 `font-src 'self'`**（现 `default-src 'none'` 拦字体）。数字用 tabular 面（价格列对齐扫读）、标题用 grotesk；**中文仍系统字体**（苹方/雅黑，不引中文 webfont）。这是项目**首个静态资源路由**、无打包器。
- **CSS View Transitions 转场。** `@view-transition { navigation: auto }`（纯 CSS、无 JS）给现有整页 GET 往返 app 般转场；`prefers-reduced-motion` 兜底。
- **弃 emoji 当状态 → CSS 绘制标记。** 现状用 🟢🟡🔴⭐🏆🚫❓⚠ 承载状态（AI-slop tell）→ 改 CSS 绘制的圆点/形状记号；**文字标签保留不变**（状态仍不单靠颜色/emoji，a11y 契约不动）。
- **沿用的表结构与红线**（吸收自 layout-refresh，工作区已实现）：主行 5 列（套餐/厂商/月价/最佳周期/新鲜度）、全宽 `<details>` 详情行 `aria-labelledby=plan-{id}`、分区 `<dl>` 用 `.detail-row` wrapper（非 `<dl>` 自身 grid）、季年付明细在详情、availability+待复核入套餐格、陈旧入新鲜度列、`bestPeriodSummary` 三元谓词 + 复用 `displayMonthly`、停售主行+详情行同降权、四问可答、未核诚实、XSS `safeHref` 单闸、carry-over ARIA、tabular 金额。

### 非目标

- **不做答案优先 IA、不接推荐器上网**（变更 B）；本期主界面仍是比价表。
- **不改 money-path / 判定口径 / DTO / 数据层 / 快照**；`bestPeriod`/`cheapestInfo`/`displayMonthly`/`safeHref` 逻辑不动。
- **不引客户端 JS 框架、不做 filter island**（近零 JS：交互仍 SSR GET / 原生元素；View Transitions 是纯 CSS）。
- **暗色实际调色延后**（本期 token-ready + 亮色）。
- **不引中文 webfont**（中文系统字体）。

## 功能 (Capabilities)

### 新增功能

（无独立新 capability——在既有 `model-radar-compare-web` 上换设计系统。）

### 修改功能

- `model-radar-compare-web`: **新增** 5 项呈现/基建需求——分层设计系统、自托管 webfont+CSP font-src+serveStatic、CSS View Transitions、弃 emoji 改 CSS 记号、5 列主行+全宽详情行结构；**修改** 8 项既有需求把主规范同步到「详情行 + 主行最佳周期列 + CSS 记号」现实（工作区经吸收的 layout-refresh 已实现、主规范仍描述旧 A-3）：① 只读SSR（scenario 去 🟢🟡 age emoji）② age/陈旧徽标（去 🟢🟡🔴、改 CSS 记号）③ 估算（去 ⚠、改 CSS 记号）④ XSS/CSP（CSP 加 `font-src 'self'`、订正「font 全拦」表述）⑤ 季/年付折算（明细移入详情行、价格格只留月价）⑥ 季/年付溯源（去「价格格内的周期子行」措辞）⑦ 最佳周期（「子行」→详情行明细、获胜摘要入主行列）⑧ WCAG（叠加 forced-colors 兜底、focus 用 outline 非 box-shadow、accent 定死、逐层对比度；保留原 ①–⑬ 全部 a11y 子条含⑨估算旋钮）。money-path / 判定口径 / effectiveMonthly 取整 / 逐条溯源 / staleness 诚实 / XSS 单闸 / coding_plan gate **一律不改**。

## 影响

- **代码**：`src/mr/web/components.tsx`（`PAGE_CSS` 全量替换为 token 化产品仪表面板系统 + View Transitions；`AgeBadgeView`/`AvailabilityBadgeView`/`EstimatedRounds` 等 emoji → CSS 标记，文字标签保留）；`src/mr/web/render.ts`（`ageBadge`/`availabilityBadge` **去掉 `emoji` 呈现字段**——判定逻辑 age 天数/生命周期归类不动，仅移除呈现载体）；`src/mr/web/model-radar-page.tsx`（CSP 加 `font-src 'self'`；`createModelRadarWebApp` 挂 `serveStatic` 供 `@font-face` 字体）；新增 `src/mr/web/assets/`（子集 `.woff2`）。
- **基建**：首个静态资源路由（`serveStatic`）+ 首个自托管字体资源；无打包器（字体是静态文件、非构建产物）。
- **测试**：`src/mr/web/__tests__` 更新——SSR 串断言状态由**文字标签**判定（已如此，emoji 移除不影响文字断言）；carry-over CSS/ARIA 硬清单沿用；新增 `font-src` in CSP、`@view-transition`、`@font-face`、CSS 标记存在断言；对比度值由 review 期 Accessibility 计算。
- **红线**：WCAG 2.2 AA（亮色全对比 ≥4.5:1、焦点环、目标 ≥24px、reflow）、状态不单靠颜色（文字标签承载）、XSS `safeHref` 单闸、money-path 只经 vetted 函数、无客户端 JS 框架、coding_plan gate 不变。
