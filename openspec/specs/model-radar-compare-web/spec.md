# model-radar-compare-web 规范

## 目的
Model Radar（P5 / 5d-B）Web 比价页：项目首个公开只读 Web 前端。由 Hono JSX 服务端渲染，数据只经既有 `getModelRadarSnapshot()` 取只读快照（不查规范化 `mr_*`、不写库、不 bump version），在浏览器内 10 秒答四问（谁含某模型 / 谁支持某工具协议 / 同档谁最划算 / 谁最近被核对或最陈旧）且每格可溯源。陈旧（plan 级聚合）与 age（per-fact `lastCheckedDate`）徽标按各自粒度诚实呈现；估算轮次做成带旋钮区间、视觉次于官方额度、挂 ⚠ 估算；未核价显式占位、不参与「最划算」、披露未参与数。作为首个公开页强制输出编码与 `source_url` scheme 闸（防存储型 XSS）+ CSP，本期 UI gate 到桶2（coding_plan），并满足 WCAG 2.2 AA（原生语义优先）。比价/检索 API（model-radar-compare-api）、只读快照构建（同上）不在本规范。

## 需求
### 需求:只读 SSR 比价页从快照渲染、不查规范化表、不写库

比价页必须由 Hono JSX（`hono/jsx`）**服务端渲染**，数据**只**经既有 `getModelRadarSnapshot()`（冷启动 build-from-DB、fail-closed）取快照；**禁止**查规范化 `mr_*` 表、**禁止**任何写库或 bump version；不引 SPA/React/打包器、不做登录鉴权（公开只读）。**页面每请求以 live `render_now` 重渲，禁止用 snapshot version 作 HTML 的 ETag/304**——HTML 含 render-time 派生的相对 age（「N 天前」），version-304 会在快照未变而日界已过时服务陈旧 age（304-with-stale-render，违下「诚实呈现新鲜度」）；JSON `/model-radar/snapshot` API 的内容哈希 ETag 不受本页影响、照旧。冷启动首建失败必须返回 503（沿用 5c fail-closed），禁止渲染坏快照。

#### 场景:页面只读渲染、不触发写
- **当** 浏览器请求比价页
- **那么** 服务端经 `getModelRadarSnapshot()` 取快照并 SSR 出 HTML；`mr_*` 与既有表无任何写、version 不被 bump

#### 场景:HTML 页不挂 version-304、age 始终 live
- **当** 快照一周未变（version 不变）但已跨数个 UTC 日界，浏览器再次请求
- **那么** 页面以当日 `render_now` 重渲、age 文案随之更新（如「🟡 3 天前」），不返回 304-with-stale 的「🟢 今日」

#### 场景:冷启动首建失败 fail-closed
- **当** 进程冷缓存下快照首建失败（DB 不可达等）
- **那么** 页面返回 503，而非渲染空/坏快照

### 需求:比价页必须能在浏览器 10 秒内答四问且每格可溯源

页面必须支持回答四问：①谁含某模型（如 GLM-5.2）②谁支持某工具/协议（如 Claude Code）③同档谁最划算 ④**谁最近被核对 / 谁最陈旧**（按 per-fact `lastCheckedDate` / `stale`——快照不含价格变更时间线，故本期不答「谁最近变价」，见非目标）。必须提供筛选 chips（model / tool / protocol / currency / budget，query 参数、渐进增强、无 JS 可用）。**价格排序与「最划算」必须经既有 `queryModelRadarSnapshot(snapshot, params)`** 取 per-group `cheapestPlanId`/`comparable`/`unknownCount`——**禁止**在裸快照对象上手搓 cheapest（绕过守「未知价不入 cheapest / NULL 不当 0 / 同 (category,currency) 分组」的 vetted 函数）。**调用边界**：`getModelRadarSnapshot()` 返回 `{snapshot,version}`、须传 `.snapshot`；只把 API 子集喂 `.strict()` `modelRadarQueryParamsSchema`（ZodError→400），估算旋钮/Q4 排序等 web-only param 留 schema 外、render 层用。**Q4「最近被核对/最陈旧」排序是 render 层对 per-fact `lastCheckedDate` 的重排**（取 plan 最旧 fact date 作键，不经 `queryModelRadarSnapshot`、不入 DTO/哈希、不碰 money-path）。render 对 `currentPrice=null` 必须显式占位、**禁止** format（防 SSR NPE）。每条价/兼容/额度事实必须可溯源——展开后呈现该事实的 `source_url`、`lastCheckedDate`（render 为 age 徽标）、`source_confidence`。

#### 场景:按模型筛选答「谁含 GLM-5.2」
- **当** 用户选「含 GLM-5.2」chip
- **那么** 表只列含该模型的 plan，每行可展开看该兼容事实的来源

#### 场景:答「谁最近被核对 / 谁最陈旧」
- **当** 用户按核对新鲜度查看/排序
- **那么** 页面据 per-fact `lastCheckedDate` + plan 级 `stale` 呈现各 plan 的最近核对/陈旧状态（不声称呈现「最近变价」）

#### 场景:每格可溯源
- **当** 用户展开某 plan 的某条价/兼容/额度事实
- **那么** 呈现该事实的 `source_url` + age 徽标 + `source_confidence`，而非无出处的裸值

#### 场景:排序与最划算经 vetted 函数、不跨桶不跨币种
- **当** 用户按价排序或看「同档最划算」
- **那么** 结果来自 `queryModelRadarSnapshot` 的 per-(category,currency) `groups`/`cheapestPlanId`（未知价不入 cheapest），不在裸快照上手搓

### 需求:陈旧（plan 级）与 age（per-fact）徽标必须按各自粒度诚实呈现

**徽标分两层粒度，禁止混用**：① **plan 级** 🔴 待复核/陈旧——来自 `freshness.stale` / `reviewStatus.pending`（plan 级聚合，快照无 per-fact stale 字段）；**禁止**用 plan 级 stale 冒充某一格的 per-cell stale（会把一个 child 陈旧污染成整行所有格陈旧）。② **per-fact** 🟢 今日核对 / 🟡 N 天前——按该事实 provenance 的 `lastCheckedDate` 在 render 时算（`render_now − lastCheckedDate`）；关联源行 `lastCheckedDate` 为 null（从未抓的 browser 源）时显示「待核/从未核对」、**不**显示 🟢/🟡（且其 plan 经既有 stale 聚合判陈旧）。**禁止**把未知/陈旧伪装成新鲜。徽标**禁止仅靠颜色/emoji 承载状态**（见可访问性需求）。

#### 场景:plan 级 🔴 待复核
- **当** 某 plan 在快照中 `stale` 为 true 或 `reviewStatus.pending` 为 true
- **那么** 该 plan 显示 plan 级 🔴 待复核/陈旧标，而非把它当作某一格的 per-cell 状态

#### 场景:per-fact age 徽标
- **当** 某事实 provenance 的 `lastCheckedDate` 为今日 / N 天前
- **那么** 该格显示 🟢 今日 / 🟡 N 天前（render 时按 `render_now − lastCheckedDate` 算，不进哈希）

### 需求:估算中等任务轮次必须做成带旋钮区间、视觉次于官方额度、挂 ⚠ 估算

「估算中等任务轮次」必须由快照既供的限额事实 + 一个可调假设旋钮算出**区间**，**禁止引入快照之外的新事实**、**禁止**进内容哈希（旋钮值是 URL query 参数、在 render 层算）。渲染必须**视觉次于**官方原始额度并显式标 **⚠ 估算**。某 plan 限额 `value` 为 NULL（不限/占位）时必须优雅降级（不输出区间、不 NPE）。

#### 场景:估算区间标记为估算且次于官方额度
- **当** 页面展示某 plan 的估算轮次
- **那么** 显示为带 ⚠ 的区间、视觉次于官方原始额度，随旋钮假设仅在既供限额数据上重算；limit.value 为 NULL 时不输出区间

### 需求:未核价必须诚实呈现、不参与「最划算」、并披露未参与数

未核价（占位 NULL / `needs_login_recheck`）必须显式呈现为「待核」，**禁止**冒充已核 provenance、**禁止**纳入「同档最划算」判定。「最划算」= **已核价中最低**；若该档有 N 个未核价，必须并显「**另有 N 个未核价未参与**」（`unknownCount` 挂该 category 的 `currency=null` 组、已核币种组上恒 0，须**跨引该 null 组**取 N，勿读已核组上的 0）；**已核 <2 时不输出**最划算标签（标「待核」而非编造名次——须**数 plans.length≥2**，`comparable=true` 对单 plan 已核组也成立、仅凭 `comparable` 不足判）。

#### 场景:最划算披露未核数、不编造
- **当** 某档内已核价 ≥2 且另有 N≥1 个未核价
- **那么** 「最划算」标已核中最低 + 「另有 N 个未核价未参与」；若已核 <2，则不输出最划算、标「待核」

### 需求:首个公开页必须做输出编码与 href scheme 闸（防存储型 XSS）

页面把快照中的 DB 字符串渲进 HTML。所有快照串必须经 `hono/jsx` 默认转义，**禁止** `raw()` / `dangerouslySetInnerHTML`。`source_url` 渲为 `<a href>` 前**必须 gate scheme ∈ {`http`,`https`}**，否则**降级为纯文本**（fact-row provenance 的 `source_url` 录入侧仅过 `mrSourceUrlSchema`、不校 scheme，`javascript:`/`data:` 可入库 → 公开页直接渲链接即存储型 XSS）；scheme 闸还须拒含 userinfo 的 `https://good.com@evil.com`（仍 http(s) 但诱导误判主机的钓鱼向量）。响应必须挂 **CSP 头**（首个公开页基线 + 防 5d-C 流入抓取内容时的纵深）：`default-src 'none'` 收口未声明取数指令（object/connect/img/font… 全拦）+ `script-src 'self'`（脚本只同源）+ `style-src 'self' 'unsafe-inline'`（容内联 `<style>`，内联样式非 script-XSS 向量、页面无内联脚本）+ `base-uri 'none'`（防注入 `<base>` 劫持相对链接/表单）+ `form-action 'self'` + `frame-ancestors 'none'`（防点击劫持）。注意 `default-src 'none'` 配**显式** `style-src` 不拦内联 `<style>`（与禁 `default-src 'self'` 不矛盾——`'self'` 无 `'unsafe-inline'` 才会拦内联样式 → 裸样式 + 破自家 a11y CSS）。并把「复核 fact-row provenance `source_url` 录入是否应同样过 `assertUrlAllowed`」列为本变更 task（防御纵深）。

#### 场景:危险 scheme 的 source_url 降级纯文本
- **当** 某事实 provenance 的 `source_url` 为 `javascript:...` 或 `data:...`
- **那么** 页面渲染为纯文本、不生成可点 `<a href>`，且 CSP 头限制脚本来源

### 需求:本期页面必须 UI gate 到桶2（coding_plan）

数据跨桶入库，但本期页面必须 facet 到 `category==='coding_plan'`（多模型 Coding Plan，枚举字面）；其余桶不在本期 UI 暴露（v2 翻 tab）。gate 必须在 UI/查询层，**禁止**改数据层或删其它桶数据；chips 不含 category facet（用户无文档化手段切桶）。

#### 场景:页面只显 coding_plan
- **当** 用户访问比价页
- **那么** 仅 `category==='coding_plan'` 的 plan 可见；其它桶数据仍在库但本期 UI 不暴露

### 需求:比价页必须满足 WCAG 2.2 AA 可访问性（原生优先）

作为项目首个公开页，HTML 必须可被键盘与屏幕阅读器完整使用，**原生语义优先于 ARIA**：① 比价表必须是原生 `<table>` + `<caption>` + 列头 `<th scope="col">` + 行头（plan 名）`<th scope="row">`，**禁止** div-grid。② 行展开溯源必须键盘可达、无 JS 也可用——用原生 `<details>/<summary>` 或链接到展开态 URL；若用 JS toggle 则须 `<button aria-expanded aria-controls>`。③ 新鲜度/估算徽标**禁止仅靠颜色或 emoji**——必须含文字标签（今日核对/N 天前/待复核/⚠ 估算），emoji 作装饰（`aria-hidden`）。④ 排序经 query-param 链接：当前列 `<th aria-sort>`、排序控件有方向性可访问名（如「按价格升序」）。⑤ 筛选 chip 的已选态用 `aria-current`/`aria-pressed` + 文字标记、可键盘清除。⑥ 每个交互元素有**可见焦点指示**（焦点环对比 ≥3:1）。⑦ 文字对比 ≥4.5:1（含次级/估算/待核灰）。⑧ SSR 外壳：`<html lang="zh-Hans">`、描述性 `<title>`（随筛选反映当前态）、地标（`<nav>`/`<main>`/`<header>`）、跳到主内容 skip-link。⑨ 估算旋钮优先原生 `<input type="range">` 或 `<select>`（有 label、键盘可调、query-param 无 JS 回退）。⑩ **Reflow/Resize（1.4.10/1.4.4）**：宽比价表在 320px 宽下不得双向滚动、200% 文字 / 400% 缩放下无内容丢失/重叠——须给响应式策略（带键盘可滚的横向滚动容器或堆叠卡片，保留行/列头关联）。⑪ **目标尺寸（2.5.8，2.2 新增）**：chips / 排序控件 / `<summary>` 折叠 / range 拇指等交互目标 ≥24×24 CSS px（或满足间距例外）。⑫ **链接用途（2.4.4）**：`source_url` 的 `<a>` 须有描述性可访问名（如「查看来源」+ 站名），非裸 URL。⑬ **状态消息（4.1.3，仅 island 路径）**：若加无刷新重排 island，结果数/「无结果」变化须 `aria-live="polite"`/`role=status`；纯 SSR 整页刷新路径由 title/焦点承载、免此条。

#### 场景:屏幕阅读器可逐格读出比价表
- **当** 屏幕阅读器以表格模式浏览比价表
- **那么** 每格朗读出所属行头（plan）+ 列头（字段），徽标读出文字状态（如「待复核」）而非只读「圆圈」

#### 场景:键盘可达溯源与排序、有可见焦点
- **当** 用户仅用键盘 Tab 浏览
- **那么** 每个 chip / 排序控件 / 展开控件可聚焦（焦点可见）、可 Enter/Space 操作；禁用 JS 时溯源仍可达
