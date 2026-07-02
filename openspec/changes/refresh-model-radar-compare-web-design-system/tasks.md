# 实现任务

## 0. 规范对齐（本变更 8 条 MODIFIED 落地前提，纯 spec，无代码）

- [x] 0.1 确认 spec delta 已把主规范同步到「详情行 + 主行最佳周期列 + CSS 记号」现实：8 条 MODIFIED 覆盖 只读SSR(scenario 去 🟢🟡)、age徽标(去 🟢🟡🔴)、估算(去 ⚠)、XSS/CSP(加 font-src)、季年付折算(移入详情行)、季年付溯源(去「价格格内的周期子行」措辞)、最佳周期(子行→详情行明细 + 摘要入主行列)、WCAG(叠加 forced-colors/outline/accent/逐层对比度，保留 ①–⑬ 全部子条含⑨估算旋钮)；实现须与改后需求一致，不得回到旧「价格格内子行 / emoji 承载」措辞
- [ ] 0.2 归档时同步 `specs/model-radar-compare-web/spec.md` 的 `## 目的` 段：把「挂 ⚠ 估算」改为「标为估算」（去 ⚠），使 capability 概述与需求一致、不残留 emoji 承载措辞

## 1. 字体资产 + serveStatic 路由 + CSP font-src（首个静态资源路由）

- [x] 1.1 选定并加入子集化 Latin 字体资产到 `src/mr/web/assets/`：一款有性格的 grotesk（标题）+ 一款**确含 tabular 数字（`tnum`）**的数字面（价格/数字），`.woff2`，Latin+数字子集（避开 Inter/Space Grotesk 等收敛款；总体积尽量 <30KB）；记录来源/许可（OFL 等）
- [x] 1.2 在 `createModelRadarWebApp`（`src/mr/web/model-radar-page.tsx`）挂 `serveStatic`（`@hono/node-server/serve-static`）路由，**契约钉死**：路由前缀 `/model-radar/assets/*`、root 解析到 `src/mr/web/assets`、`rewriteRequestPath` 剥前缀映射到 root、`onFound` 设 `Content-Type: font/woff2` + 长缓存头（`Cache-Control: public, max-age=…, immutable`）；**MUST NOT** 把 root 放宽到仓库其它目录，路径穿越（`../`）MUST 拒。**注意 `@hono/node-server` serveStatic 的 `root` 是 cwd 相对**——容器化/编译产物运行时须保证工作目录含 `src/mr/web/assets`（GHCR 镜像须打进字体资产、或 root 用相对进程 cwd 的稳定解析），否则 prod 字体 404；加一条 prod smoke 验证字体可达
- [x] 1.3 CSP 常量加入 `font-src 'self'`（`src/mr/web/model-radar-page.tsx`），保留其余全部指令、不放行任何外部源；更新文件顶部 CSP 注释（「同源字体放行、其余取数指令仍全拦」，非「font 全拦」）
- [x] 1.4 `@font-face`（在 `PAGE_CSS`）声明两款字体、`font-display: swap`、`src: url(/model-radar/assets/…)`；字体栈：Latin/数字用 webfont、中文回退系统字体栈（苹方/雅黑），价格金额 `font-variant-numeric: tabular-nums`；**加 `size-adjust`/`ascent-override`（或就近选度量相近的回退）压 swap 换字时价格列的 CLS 抖动**

## 2. PAGE_CSS 换设计系统：分层表面 + token + 签名色/状态 ramp + View Transitions

- [x] 2.1 在 `PAGE_CSS`（`src/mr/web/components.tsx`）建立 CSS 变量 token 层：颜色角色（page-bg/surface/ink/muted/ring/accent + 状态 ramp fresh/stale/estimate/discontinued）、间距阶、圆角阶、阴影阶、字阶；`:root` 亮色值；**签名 accent 取值定死**（同时满足焦点环 ≥3:1 与白字填充 ≥4.5:1 两角色，取更严的 4.5:1）；`prefers-color-scheme: dark` 结构留位——本期 dark 块要么**完全不写、要么完整**，**MUST NOT 只填一半**（半填暗色块会被暗色浏览器采用 → 低对比）
- [x] 2.2 全量替换 `PAGE_CSS` 视觉层为分层产品界面：page 微冷背景 → 比价表/筛选区各成抬升 `surface` 面板（圆角 + 微阴影 + **真实 `border`/ring 边**，非仅 box-shadow）；弃 `border-radius:0` 与全平；筛选区/面板**流式换行、不产生第二处横滚**（仅 `<table>` 保留横滚）；统一间距节奏；一个克制签名强调色贯穿焦点/最划算/交互态；**禁**紫渐变/glassmorphism/emoji-UI/hero-metric 巨号/侧边条/每段小标签
- [x] 2.3 加 `@view-transition { navigation: auto }`（纯 CSS 跨文档转场）；`@media (prefers-reduced-motion: reduce)` 兜底**须把 `::view-transition-old(*)`/`::view-transition-new(*)`/`::view-transition-group(*)` 动画置零**（`animation: none`），非仅省略 at-rule
- [x] 2.4 **焦点环 MUST 用 `outline`（+`outline-offset`）、MUST NOT 用 box-shadow**（forced-colors 剥离 + 圆角面板 overflow 裁剪）；逐层核对对比度——文字/背景对 ≥4.5:1 须对**其真实所在层**（page-bg / 抬升 surface / 状态色 tinted pill）分别验，{muted、estimate、stale/待复核、discontinued 置灰}逐项对真实背景达标、状态色不作同色相 tinted 面上正文；UI/焦点环 ≥3:1、交互目标 ≥24px（表单控件 ≥28px）、`.table-scroll` 单向横滚 reflow；保留 skip-link/aria-sort/aria-current/地标等既有 a11y 结构
- [x] 2.5 `@media (forced-colors: active)` 兜底：抬升面板用真实 `border` 承载分隔（box-shadow 会被剥离）、focus outline 仍可见；装饰性 CSS 记号在此模式消失可接受（状态由文字标签承载）

## 3. 状态标记：emoji → CSS 绘制（文字标签不动，含 render.ts 呈现字段）

- [x] 3.1 移除全部状态 emoji 字符 **`🟢🟡🔴🟠⭐🏆🚫❓⚠`（9 个，含 🟠 待复核）**、改 CSS 绘制记号（伪元素/小 span，用状态 ramp token 上色，各状态**尽量形状可辨**不只靠色）：`components.tsx` 的 `AgeBadgeView`/`AvailabilityBadgeView`/`EstimatedRounds`/最划算/最佳周期/已停售/待复核/状态未知；**并改 `render.ts` 的 `ageBadge`/`availabilityBadge`**——它们当前把 `emoji: '🟢'/'🟡'/'🚫'/'❓'` 作为 badge 数据返回，须去掉该 `emoji` 呈现字段（或组件停读 `badge.emoji` 后删该死字段）
- [x] 3.2 CSS 记号 `aria-hidden`/纯装饰、不承载可及名；每状态的**文字标签一字不改**（状态仍由文字承载，不单靠颜色/形状）；**render.ts 的判定逻辑（age 天数计算、生命周期 kind/label 归类）完全不动，仅去掉其 badge 的 emoji 呈现字段**——判定不变、呈现载体换 CSS

## 4. 测试更新（`src/mr/web/__tests__`）

- [x] 4.1 更新/新增断言：CSP 含 `font-src 'self'`（且不含外部字体源）；SSR 输出含 `@font-face`、`@view-transition`；serveStatic 路由 `/model-radar/assets/*.woff2` 返回 200 + `Content-Type: font/woff2`，assets 外路径 / 穿越（`../`）返回 404/拒
- [x] 4.2 状态断言改为**文字标签**判定；**断言 SSR 输出与 `render.ts` badge 均无残留状态 emoji 字符（含 🟠）**、CSS 记号类/结构存在；carry-over ARIA/CSS 硬清单（aria-labelledby=plan-*、.detail-row、aria-sort、skip-link、th scope、caption、季年付明细在详情行而非价格格）逐条仍在
- [x] 4.3 全量 `pnpm test`（或项目脚本）绿；确认 money-path / 判定口径 / 结构测无回归（本域 web 测 83/83 绿 + `tsc --noEmit` 0 error；全量套件另有 350 文件因本机缺 `.env` 与 `.claude/worktrees/*` 兄弟副本被 vitest 收录而 env 校验失败——环境前置条件，与本次改动无关）

## 5. 目视校验

- [x] 5.1 用 `scratchpad/render-demo.mts` 重渲染预览、浏览器打开核对分层表面/字体/转场/无 emoji/逐层对比度观感；必要时微调 token（accent 已定死不再动）
