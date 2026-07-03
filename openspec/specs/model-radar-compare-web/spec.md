# model-radar-compare-web 规范

## 目的
Model Radar（P5 / 5d-B）Web 比价页：项目首个公开只读 Web 前端。由 Hono JSX 服务端渲染，数据只经既有 `getModelRadarSnapshot()` 取只读快照（不查规范化 `mr_*`、不写库、不 bump version），在浏览器内 10 秒答四问（谁含某模型 / 谁支持某工具协议 / 同档谁最划算 / 谁最近被核对或最陈旧）且每格可溯源。陈旧（plan 级聚合）与 age（per-fact `lastCheckedDate`）徽标按各自粒度诚实呈现；估算轮次做成带旋钮区间、视觉次于官方额度、标为估算（CSS 记号 + 文字标签，不以 emoji 承载）；未核价显式占位、不参与「最划算」、披露未参与数。作为首个公开页强制输出编码与 `source_url` scheme 闸（防存储型 XSS）+ CSP，本期 UI gate 到桶2（coding_plan），并满足 WCAG 2.2 AA（原生语义优先）。比价/检索 API（model-radar-compare-api）、只读快照构建（同上）不在本规范。
## 需求
### 需求:只读 SSR 比价页从快照渲染、不查规范化表、不写库

比价页必须由 Hono JSX（`hono/jsx`）**服务端渲染**，数据**只**经既有 `getModelRadarSnapshot()`（冷启动 build-from-DB、fail-closed）取快照；**禁止**查规范化 `mr_*` 表、**禁止**任何写库或 bump version；不引 SPA/React/打包器、不做登录鉴权（公开只读）。**`GET /model-radar` 由答案优先页承载**（推荐器结果作主体，见 `model-radar-answer-first-web`），既有比价表作该页内**可展开的「证据抽屉」**（默认折叠原生 `<details>`、无 JS）嵌入；比价表的口径/结构/最划算/provenance/money-path 不变、仅呈现位置改变。**页面每请求以 live `render_now` 重渲，禁止用 snapshot version 作 HTML 的 ETag/304**——HTML 含 render-time 派生的相对 age（「N 天前」），version-304 会在快照未变而日界已过时服务陈旧 age（304-with-stale-render，违下「诚实呈现新鲜度」）；JSON `/model-radar/snapshot` API 的内容哈希 ETag 不受本页影响、照旧。冷启动首建失败必须返回 503（沿用 5c fail-closed），禁止渲染坏快照。

#### 场景:页面只读渲染、不触发写
- **当** 浏览器请求 `/model-radar`
- **那么** 服务端经 `getModelRadarSnapshot()` 取快照并 SSR 出答案优先 HTML（比价表在证据抽屉内）；`mr_*` 与既有表无任何写、version 不被 bump

#### 场景:HTML 页不挂 version-304、age 始终 live
- **当** 快照一周未变（version 不变）但已跨数个 UTC 日界，浏览器再次请求
- **那么** 页面以当日 `render_now` 重渲、age 文案随之更新（如「3 天前核对」），不返回 304-with-stale 的「今日核对」

#### 场景:冷启动首建失败 fail-closed
- **当** 进程冷缓存下快照首建失败（DB 不可达等）
- **那么** 页面返回 503，而非渲染空/坏快照

### 需求:比价页必须能在浏览器 10 秒内答四问且每格可溯源

页面必须支持回答四问：①谁含某模型（如 GLM-5.2）②谁支持某工具/协议（如 Claude Code）③同档谁最划算 ④**谁最近被核对 / 谁最陈旧**（按 per-fact `lastCheckedDate` / `stale`——快照不含价格变更时间线，故本期不答「谁最近变价」，见非目标）。**答案优先下，Q3（同档谁最划算）由页面顶部的答案卡（推荐器 `primary`）直接给出，Q1/Q2/Q4 由证据抽屉内的比价表回答**（表口径不变）。setup 输入（model / tool / protocol / currency / 预算 `maxMonthlyPrice` / usageProfile）以 query 参数提交、渐进增强、无 JS 可用（措辞面向「描述你的配置」，见 `model-radar-answer-first-web`）。**注意（与 A 的筛选 chip 不同）：`currency` / `maxMonthlyPrice` / `usageProfile` 只驱动答案（recommend），不再过滤证据抽屉的比价表**——抽屉表查询只传召回维度 `{category,model,tool,protocol}`，使超预算/他币种 plan 仍作证据可见（见 `model-radar-answer-first-web`「证据抽屉」需求），MUST NOT 把 currency/budget 重新接进抽屉表查询。**价格排序与「最划算」必须经既有 `queryModelRadarSnapshot(snapshot, params)` / 推荐器 `recommend()`** 取 per-group `cheapestPlanId`/`comparable`/`unknownCount` 与 `primary`——**禁止**在裸快照对象上手搓 cheapest（绕过守「未知价不入 cheapest / NULL 不当 0 / 同 (category,currency) 分组」的 vetted 函数）。**答案卡 primary 与抽屉表「最划算」皆经 vetted 引擎（均不手搓），但口径不同、可合法分歧**：`recommend()` primary 是「最便宜 **eligible**」（额外排除 待复核/超预算/撞窗 exceeds/未核），`queryModelRadarSnapshot` cheapest 仅排除停售——故当表内最便宜非停售 plan 恰为待复核/超预算/撞窗时，二者**指向不同 plan**。此为按各自口径的**预期分歧、非 bug**；页面 MUST NOT 断言二者相等，且当表「最划算」不是答案 primary 时，落选缘由由答案区 guidance/explanation 交代（表仍以 A 既有标级呈现）。**调用边界**：`getModelRadarSnapshot()` 返回 `{snapshot,version}`、须传 `.snapshot`；喂引擎/查询的入参经各自 schema 校验，估算旋钮/Q4 排序等 web-only param 留 schema 外、render 层用。**Q4「最近被核对/最陈旧」排序是 render 层对 per-fact `lastCheckedDate` 的重排**（取 plan 最旧 fact date 作键，不经 `queryModelRadarSnapshot`、不入 DTO/哈希、不碰 money-path）。render 对 `currentPrice=null` 必须显式占位、**禁止** format（防 SSR NPE）。每条价/兼容/额度事实必须可溯源——展开后呈现该事实的 `source_url`、`lastCheckedDate`（render 为 age 徽标）、`source_confidence`。

#### 场景:Q3 由答案卡直接答
- **当** 用户想知道「同档谁最划算」
- **那么** 页面顶部答案卡直接给出推荐器 `primary`（含月成本/撞窗结论），无需自己扫表

#### 场景:Q1/Q2/Q4 由证据抽屉表答、每格可溯源
- **当** 用户展开证据抽屉按模型/工具协议/新鲜度查看
- **那么** 抽屉内比价表据 per-fact `lastCheckedDate`+`stale` 与筛选呈现，每行可展开看该事实 `source_url`+age+`source_confidence`

#### 场景:答案与表最划算皆 vetted、可合法分歧
- **当** 页面给答案卡 primary 或抽屉表「同档最划算」
- **那么** 二者皆来自 vetted 引擎（`recommend`/`queryModelRadarSnapshot`，未知价不入）、不在裸快照上手搓；二者口径不同（primary 额外排除待复核/超预算/撞窗），**可指向不同 plan**，页面不断言相等，分歧时落选缘由由答案区交代

### 需求:陈旧（plan 级）与 age（per-fact）徽标必须按各自粒度诚实呈现

**徽标分两层粒度，禁止混用**：① **plan 级** 陈旧/待复核记号——来自 `freshness.stale` / `reviewStatus.pending`（plan 级聚合，快照无 per-fact stale 字段）；**禁止**用 plan 级 stale 冒充某一格的 per-cell stale（会把一个 child 陈旧污染成整行所有格陈旧）。② **per-fact** 今日核对 / N 天前——按该事实 provenance 的 `lastCheckedDate` 在 render 时算（`render_now − lastCheckedDate`）；关联源行 `lastCheckedDate` 为 null（从未抓的 browser 源）时显示「待核/从未核对」、**不**显示今日/N 天前记号（且其 plan 经既有 stale 聚合判陈旧）。**禁止**把未知/陈旧伪装成新鲜。状态记号 MUST 由 **CSS 绘制**（配语义状态 ramp 上色）+ 文字标签承载、**禁止仅靠颜色/形状/emoji 承载状态**、**禁止**用 emoji 字符（🟢🟡🔴 等）当记号（见可访问性需求与「弃 emoji 改 CSS 记号」需求）。

#### 场景:plan 级 待复核记号
- **当** 某 plan 在快照中 `stale` 为 true 或 `reviewStatus.pending` 为 true
- **那么** 该 plan 显示 plan 级「待复核/陈旧」记号（CSS 绘制 + 文字标签），而非把它当作某一格的 per-cell 状态

#### 场景:per-fact age 徽标
- **当** 某事实 provenance 的 `lastCheckedDate` 为今日 / N 天前
- **那么** 该格显示「今日核对」/「N 天前核对」（CSS 记号 + 文字，render 时按 `render_now − lastCheckedDate` 算，不进哈希），非 emoji 字符

### 需求:估算中等任务轮次必须做成带旋钮区间、视觉次于官方额度、挂 ⚠ 估算

「估算中等任务轮次」必须由快照既供的限额事实 + 一个可调假设旋钮算出**区间**，**禁止引入快照之外的新事实**、**禁止**进内容哈希（旋钮值是 URL query 参数、在 render 层算）。渲染必须**视觉次于**官方原始额度并显式标为「估算」——该「估算」记号 MUST 由 **CSS 绘制**（次级/告警色）+ 文字「估算」标签承载、**禁止**用 emoji 字符（⚠ 等）当记号（标题「⚠」为历史命名标识、非渲染输出要求）。某 plan 限额 `value` 为 NULL（不限/占位）时必须优雅降级（不输出区间、不 NPE）。

#### 场景:估算区间标记为估算且次于官方额度
- **当** 页面展示某 plan 的估算轮次
- **那么** 显示为标注「估算」（CSS 记号 + 文字，非 emoji）的区间、视觉次于官方原始额度，随旋钮假设仅在既供限额数据上重算；limit.value 为 NULL 时不输出区间

### 需求:未核价必须诚实呈现、不参与「最划算」、并披露未参与数

未核价（占位 NULL / `needs_login_recheck`）必须显式呈现为「待核」，**禁止**冒充已核 provenance、**禁止**纳入「同档最划算」判定。「最划算」= **已核价中最低**；若该档有 N 个未核价，必须并显「**另有 N 个未核价未参与**」（`unknownCount` 挂该 category 的 `currency=null` 组、已核币种组上恒 0，须**跨引该 null 组**取 N，勿读已核组上的 0）；**已核 <2 时不输出**最划算标签（标「待核」而非编造名次——须**数 plans.length≥2**，`comparable=true` 对单 plan 已核组也成立、仅凭 `comparable` 不足判）。

#### 场景:最划算披露未核数、不编造
- **当** 某档内已核价 ≥2 且另有 N≥1 个未核价
- **那么** 「最划算」标已核中最低 + 「另有 N 个未核价未参与」；若已核 <2，则不输出最划算、标「待核」

### 需求:首个公开页必须做输出编码与 href scheme 闸（防存储型 XSS）

页面把快照中的 DB 字符串渲进 HTML。所有快照串必须经 `hono/jsx` 默认转义，**禁止** `raw()` / `dangerouslySetInnerHTML`。`source_url` 渲为 `<a href>` 前**必须 gate scheme ∈ {`http`,`https`}**，否则**降级为纯文本**（fact-row provenance 的 `source_url` 录入侧仅过 `mrSourceUrlSchema`、不校 scheme，`javascript:`/`data:` 可入库 → 公开页直接渲链接即存储型 XSS）；scheme 闸还须拒含 userinfo 的 `https://good.com@evil.com`（仍 http(s) 但诱导误判主机的钓鱼向量）。响应必须挂 **CSP 头**（首个公开页基线 + 防 5d-C 流入抓取内容时的纵深）：`default-src 'none'` 收口未声明取数指令（object/connect/img… 全拦）+ `script-src 'self'`（脚本只同源）+ `style-src 'self' 'unsafe-inline'`（容内联 `<style>`，内联样式非 script-XSS 向量、页面无内联脚本）+ **`font-src 'self'`（放行同源自托管 webfont；未列 `font-src` 时字体由 `default-src 'none'` 兜底拦截，故自托管字体 MUST 显式加此指令、且 MUST NOT 放行任何外部/CDN 源）** + `base-uri 'none'`（防注入 `<base>` 劫持相对链接/表单）+ `form-action 'self'` + `frame-ancestors 'none'`（防点击劫持）。注意 `default-src 'none'` 配**显式** `style-src`/`font-src` 不拦内联 `<style>`/同源字体（与禁 `default-src 'self'` 不矛盾——`'self'` 无 `'unsafe-inline'` 才会拦内联样式 → 裸样式 + 破自家 a11y CSS）。（「复核 fact-row provenance `source_url` 录入是否应同样过 `assertUrlAllowed`」为既有防御纵深待办，源自 XSS 闸原始变更、非本视觉变更范围。）

#### 场景:危险 scheme 的 source_url 降级纯文本
- **当** 某事实 provenance 的 `source_url` 为 `javascript:...` 或 `data:...`
- **那么** 页面渲染为纯文本、不生成可点 `<a href>`，且 CSP 头限制脚本来源

#### 场景:CSP 放行同源字体、拒外部源
- **当** 页面加载自托管 `.woff2`（同源 serveStatic 路由）
- **那么** CSP 含 `font-src 'self'` 使同源字体加载成功，且不含任何外部/CDN 字体源（外部字体 URL 被拦）

### 需求:本期页面必须 UI gate 到桶2（coding_plan）

数据跨桶入库，但本期页面必须 facet 到 `category==='coding_plan'`（多模型 Coding Plan，枚举字面）；其余桶不在本期 UI 暴露（v2 翻 tab）。gate 必须在 UI/查询层，**禁止**改数据层或删其它桶数据；chips 不含 category facet（用户无文档化手段切桶）。

#### 场景:页面只显 coding_plan
- **当** 用户访问比价页
- **那么** 仅 `category==='coding_plan'` 的 plan 可见；其它桶数据仍在库但本期 UI 不暴露

### 需求:比价页必须满足 WCAG 2.2 AA 可访问性（原生优先）

比价页 MUST 满足 WCAG 2.2 AA、原生语义优先：原生 `<table>/<caption>/<th scope>`、`<details>/<summary>`、`<dl>/<dt>/<dd>`、`<form>`；屏幕阅读器可逐格读出比价表且列/行头关联保留；键盘可达筛选/排序/溯源且有**可见焦点环**。**焦点环 MUST 用 `outline`（+`outline-offset`）绘制、MUST NOT 用 `box-shadow`**（box-shadow 焦点环在 `forced-colors` 下被剥离、且会被圆角面板的 `overflow:hidden` 裁掉）；焦点环签名色对相邻背景 ≥3:1。**签名强调色 MUST 在设计阶段定死具体值**（非留待实现微调）——它同时承担焦点环（≥3:1 vs 相邻表面）与选中态/最划算填充（白字其上时 ≥4.5:1）两个对比角色，取值 MUST 满足更严的 4.5:1。目标尺寸 ≥24px（chip/sort-link/summary ≥24px、表单控件 ≥28px）；`.table-scroll` 单向横滚满足 reflow（1.4.10/1.4.4）、且抬升面板化后**只有 `<table>` 保留横滚，筛选区/面板 MUST 流式换行不产生第二处横滚**（320px/400% 下 body 无表外横滚）；`.skip-link`（2.4.1）、`<th aria-sort>` + 方向性排序链接可访问名、chip `aria-current`/`aria-pressed` + 文字标记且**可键盘清除**、溯源链接「查看来源 + host」名（`sourceHost`，2.4.4）、`<html lang>` + 反映筛选的 `<title>` + header/nav/main 地标（2.4.1/3.1.1/1.3.1）MUST 保留。**估算旋钮 MUST 优先原生 `<input type="range">` 或 `<select>`（有 label、键盘可调、query-param 无 JS 回退）**；行展开溯源 MUST 键盘可达、无 JS 也可用（原生 `<details>/<summary>`；若改用 JS toggle 则须 `<button aria-expanded aria-controls>`——本期无 JS 故 native details 承载）；若后续加无刷新重排 island，结果数/「无结果」变化 MUST `aria-live="polite"`/`role=status`（本期纯 SSR 整页刷新，由 title/焦点承载、免此条）。**状态 MUST NOT 仅靠颜色/形状/emoji 承载**——每状态带文字标签，视觉记号由 CSS 绘制（弃 emoji，见上）。**所有文字/背景色对 MUST ≥4.5:1、且 MUST 对其真实所在的层（page-bg / 抬升 surface / 状态色 tinted pill）逐层核对**（次级/估算/待核/停售置灰文字 MUST NOT 只对 `#fff` 达标却在 tinted 面上跌破）；状态色 MUST NOT 作为同色相 tinted 面上的正文文字。**`forced-colors: active`（Windows 高对比）MUST 有兜底**：抬升面板 MUST 用真实 `border`（非仅 `box-shadow`）承载分隔、装饰性 CSS 记号在此模式下消失可接受（状态由文字标签承载）。视觉系统经内联 `<style>` + 同源自托管字体落地，CSP `style-src 'self' 'unsafe-inline'` + `font-src 'self'`、MUST NOT 引外部资源或客户端 JS 框架。全量替换 `PAGE_CSS` 时上述承载类/标记/ARIA MUST 逐条保留（SSR 结构测显式断言）。

#### 场景:屏幕阅读器可逐格读出比价表且状态不单靠颜色
- **当** 屏幕阅读器用户浏览比价表
- **那么** 原生表语义 + 列/行头关联可读；每状态由文字标签承载（CSS 记号装饰、无 emoji）；详情经原生 `<details>` 可达、`<dl>` 列表语义保留

#### 场景:键盘可达、焦点可见、目标达标、reflow
- **当** 键盘用户操作筛选/排序/展开/溯源，或在 320px/400% 缩放下
- **那么** 每交互元素有 `outline` 可见焦点环（签名色 ≥3:1、不被面板 overflow 裁剪）、目标 ≥24px；比价表单向横滚不丢内容、面板无第二处横滚；skip-link/aria-sort/aria-current/地标/lang/title 均在

#### 场景:高对比模式与逐层对比达标
- **当** 用户启用 `forced-colors: active`，或次级/估算/停售文字落在 tinted 面上
- **那么** 抬升面板以真实 `border` 保持分隔、焦点环（outline）仍可见、文字对其真实背景层 ≥4.5:1；装饰记号消失但文字标签仍承载状态

### 需求:比价页必须呈现季/年付周期价并同时给出折算月价

比价页 MUST 在每个 plan 的**详情行内**（价格格只留 canonical 月价 + 最划算，季/年付明细 MUST NOT 占主行价格格）渲染已在快照 DTO 就绪的季/年付 `periodPrices` 明细，每条明细 MUST 同时显示原始周期价与 `effectiveMonthly` 折算月价（如 `季付 CNY 297（≈CNY 99/月）`，币种沿代码既有「币种代码 + 空格 + 金额」呈现约定、非货币符号）。`effectiveMonthly` MUST 直接读取 DTO 已算好的值、MUST NOT 重算；DTO 原值是**未取整浮点**（如 `1099/12=91.58333…`），故 render 层 MUST 在**展示前**四舍五入到最多两位小数**并去掉末尾多余的 0**（整数不显 `.00`：`79`（非 `79.00`）、`91.58`；即 `String(Math.round(n*100)/100)` 语义，而非 `toFixed(2)`）、MUST NOT 直接输出原始长浮点；该展示取整 MUST NOT 改写 DTO 值、MUST NOT 进入 money-path 或最佳周期判定（判定用未取整精确值）。周期价 `priceStatus=unknown` 时 MUST 显「待核」占位、MUST NOT 编造折算月价。月价 `priceStatus=unknown`（待核）MUST NOT 遮蔽同 plan 已核的周期价——价格格月价段与详情行周期段 MUST 各自独立渲染。

#### 场景:已核周期价同时显原始价与折算月价
- **当** 一个 plan 有 `billingPeriod=annual`、`priceStatus=known`、原始年付价与非空 `effectiveMonthly`
- **那么** 详情行内渲染年付明细，同时显示原始年付价与括号内折算月价（`≈CNY N/月`，N 四舍五入到最多两位小数并去末尾 0——整数如 `79` 不显 `79.00`）

#### 场景:未核周期价显待核不折算
- **当** 一个 plan 的季付 `priceStatus=unknown`（`effectiveMonthly` 必为 null）
- **那么** 渲染「季付 待核」明细，不显任何折算月价数字

#### 场景:月价待核不遮蔽已核周期价
- **当** 一个 plan 的 canonical 月价 `priceStatus=unknown` 但年付 `priceStatus=known`
- **那么** 价格格月价段显「待核」，详情行年付已核明细仍照实渲染（原始价 + 折算月价）

### 需求:比价页必须仅在周期价真比月价便宜时标注最佳周期

最佳周期判定 MUST 收敛在**单一** render 层纯函数 `bestPeriod(plan)`（组件层 MUST NOT 另设并行抑制分支，防两处守卫互相假设对方负责而漏判）。`bestPeriod` MUST 仅比较**币种与 canonical 月价相同**（`periodPrice.currency === plan.currency`）的已核周期价——币种不同的周期价 MUST 被排除出最佳周期比较（金额精确、不做跨币/跨桶 FX 红线）；仅当某入选周期价的 `effectiveMonthly` **严格低于** canonical 月价时返回该 `billingPeriod`，否则返回 null。以下情形 `bestPeriod` MUST 返回 null（即不标注）：月付最低、无同币种已核周期价、折算与月价平局、canonical 月价 `priceStatus=unknown`（无合法基线）、`availability=discontinued`（停售不可买、不推荐去买）。当多个同币种入选周期价 `effectiveMonthly` **并列最低且均严格低于月价**时，MUST 以确定性规则择一（择更长承诺周期，即 annual 优先于 quarterly），避免徽标目标不确定。**呈现落位（随详情行重排对齐）**：获胜周期摘要（周期名 + 折算月价，无则 `—`）MUST 呈现在主行「最佳周期」列（5 列结构，见「主行 5 列」需求）；详情行内对应周期明细 MAY 附获胜记号（CSS 绘制 + 文字，见「弃 emoji」需求）。徽标/摘要 MUST 只标明获胜周期（如「年付」）、MUST NOT 附省额数字。判定 MUST 用**未取整的精确** `effectiveMonthly` 与 `Number(plan.currentPrice)` 比较（非展示用的两位取整值）——故在取整边界上，摘要可能出现而两条展示金额看起来相同（如精确 33.3299 严格低于 33.33，两者都显 `33.33`），此为按精确事实判定的预期行为、非 bug。最佳周期判定与周期明细渲染为 render 层纯展示，MUST NOT 进入「最划算」/价格排序，MUST NOT 向快照内容哈希新增任何输入，MUST NOT 改变以 canonical 月价为准的 money-path 口径。

#### 场景:年付折算严格低于月价则标最佳周期
- **当** 一个在售 plan 的年付 `effectiveMonthly` 严格小于其 canonical 月价
- **那么** 主行「最佳周期」列显示「年付」摘要（周期名 + 折算月价），详情行年付明细可附获胜记号，且不显省额数字

#### 场景:月付最低或平局不标最佳周期
- **当** 一个 plan 的 canonical 月价 ≤ 所有已核周期价的 `effectiveMonthly`
- **那么** 主行「最佳周期」列显 `—`，不标注任何最佳周期摘要/记号

#### 场景:月价缺基线不标最佳周期
- **当** 一个 plan 的 canonical 月价 `priceStatus=unknown`
- **那么** 即使存在已核周期价，也不标注最佳周期（主行列显 `—`）

#### 场景:周期币种不同于月价币种不参与最佳周期
- **当** 一个 plan 的 canonical 月价为 `CNY`，而某已核周期价币种为 `USD`（其数值折算 `effectiveMonthly` 恰低于月价数值）
- **那么** 该异币种周期价 MUST NOT 参与最佳周期比较、MUST NOT 触发摘要/记号（不做跨币 FX）；该周期明细仍以其自身币种在详情行正常展示

#### 场景:同币种周期并列最低按确定性规则择一
- **当** 一个 plan 的季付与年付 `effectiveMonthly` 并列最低且均严格低于月价
- **那么** 摘要确定性地落在年付（更长承诺周期），不出现不确定目标

#### 场景:最佳周期与周期呈现不改 money-path
- **当** 渲染最佳周期摘要与周期明细
- **那么** 「最划算」评定与价格排序仍只依据 canonical 月价，且本 render-only 变更 MUST NOT 向快照内容哈希新增任何输入（`periodPrices`/`effectiveMonthly` 作为 DTO 字段已由既有快照契约纳入内容哈希，本变更不改其构成）

### 需求:比价页必须诚实呈现 availability 生命周期并对停售方案降权

比价页 MUST 按 plan 的 `availability` 呈现产品生命周期状态：`discontinued` MUST 显「已停售」徽标、MUST 对整行做视觉降权（置灰 + 月价删除线）、MUST 抑制该行最佳周期徽标（经 `bestPeriod` 单一判定实现，见上），且 MUST NOT 参与「最划算」评定；`unknown` MUST 显次级「状态未知」以区别于「正常」（避免未迁移旧行被冒充在售）；`on_sale` MUST NOT 出任何 availability 标（默认态）。availability 与 `source_confidence`、`reviewStatus.pending` 三者正交，MUST 各自独立呈现、MUST NOT 相互冒充；具体地，availability 的呈现 MUST 独立于既有「陈旧 / 待复核 / 正常」状态判定——`availability=unknown` MUST NOT 因 plan 恰为「不陈旧且不待复核」而被吞进「正常」而丢失（现有状态格对 `!stale && !pending` 提前返回「正常」，故 availability 呈现 MUST 先于/独立于该分支求值）。停售行置灰后的正文文字 MUST 仍满足对比度 ≥4.5:1（状态由「已停售」徽标 + 删除线承载，置灰仅为装饰降权）。

#### 场景:停售方案降权且不参与最划算
- **当** 一个 plan 的 `availability=discontinued`
- **那么** 该行显「已停售」徽标、整行置灰且月价删除线、无最佳周期徽标，且不被评为该组「最划算」

#### 场景:未知生命周期显次级态
- **当** 一个 plan 的 `availability=unknown` 且该 plan 既不陈旧也不待复核（现有状态格会对此提前返回「正常」）
- **那么** 仍显次级「状态未知」标识、MUST NOT 因命中「正常」提前返回而被吞掉

#### 场景:在售方案不出生命周期标
- **当** 一个 plan 的 `availability=on_sale`
- **那么** 不渲染任何 availability 徽标

### 需求:季/年付周期价必须逐条可溯源且新鲜度纳入 plan 聚合

比价页 MUST 为每条季/年付周期价在溯源展开区列出独立的 provenance 行，含 `source_url`（经 `safeHref` scheme 闸，危险 scheme 降级纯文本）、`source_confidence` 与 per-fact age 徽标。周期价的 `last_checked` MUST 纳入该 plan「最旧事实」新鲜度徽标的计算。详情行内的周期价明细 MUST NOT 各自内联 age 徽标（新鲜度由新鲜度列的 plan 最旧徽标与溯源展开区逐条覆盖）。

#### 场景:溯源区逐条列出周期价来源
- **当** 展开一个含已核年付价的 plan 的「溯源」
- **那么** 展开区出现独立「年付价」行，含经 scheme 闸的来源链接、置信度与 age 徽标

#### 场景:周期价新鲜度纳入 plan 最旧徽标
- **当** 一个 plan 的年付价 `last_checked` 早于其它所有事实
- **那么** 该 plan「数据新鲜度」列的最旧徽标反映该年付价的核对日

### 需求:比价页必须采用分层产品界面设计系统（token 化、暗色-ready）

比价页 MUST 采用「分层产品界面」视觉语言（而非平面文档/报纸）：page 背景为微冷中性、内容承载于**抬升表面**（`surface` 卡：圆角 + 微阴影 + 描边 ring），比价表与筛选区各成抬升面板；MUST NOT 使用 `border-radius: 0` 的全平直角风。设计 token MUST 全部经 CSS 自定义属性表达（颜色角色 / 间距 / 圆角 / 阴影 / 字阶），使暗色为 token 替换即可（本期只交付亮色、`prefers-color-scheme` 暗色作后续；亮色所有文字/背景对 MUST ≥4.5:1、UI/焦点 ≥3:1）。MUST 用一个克制的签名强调色 + 语义状态 ramp（fresh / stale / estimate / discontinued）；MUST NOT 使用紫色渐变、glassmorphism 装饰、emoji 作 UI、巨号 hero-metric 数字、彩色侧边条、或每段小标签（AI-slop 反模式）。视觉系统仍 MUST 满足既有 a11y（焦点环、目标 ≥24px、reflow）。

#### 场景:抬升表面而非全平文档
- **当** 渲染比价页
- **那么** 内容位于圆角+微阴影+描边的抬升 `surface` 面板上、page 背景与表面有可辨层次；不出现 `border-radius:0` 全平直角风

#### 场景:token 化且暗色-ready
- **当** 审阅样式
- **那么** 颜色/间距/圆角/阴影/字阶均由 CSS 变量定义；亮色全部文字/背景对 ≥4.5:1（UI/焦点 ≥3:1）；暗色仅需替换 token 值（本期不交付暗色实际调色）

### 需求:比价页必须自托管 Latin webfont 并相应放行 CSP font-src

比价页 MUST 经 Hono `serveStatic` 静态路由自托管一款 Latin 字体（价格/数字用 tabular 数字面、标题用有性格的 grotesk——**MUST NOT 用已收敛的 Inter/Space Grotesk 等**），以 `@font-face` + `font-display: swap` 加载；**中文 MUST 仍用系统字体栈**（苹方/雅黑等，MUST NOT 引入中文 webfont）。字体 MUST 子集化（Latin + 数字）且同源自托管（零外部/CDN）。CSP MUST 相应加入 `font-src 'self'`（现 `default-src 'none'` 会拦字体）；MUST NOT 放行任何外部源。价格金额 MUST 用 tabular 数字（同列小数对齐可竖读）。

#### 场景:自托管字体经 serveStatic + font-src
- **当** 页面加载字体
- **那么** 字体 `.woff2` 由同源 `serveStatic` 路由提供、经 `@font-face`+`font-display:swap` 应用于 Latin/数字；CSP 含 `font-src 'self'`、不含任何外部源；中文文字仍系统字体

#### 场景:换字期文字始终可读
- **当** webfont 尚未加载完成
- **那么** `font-display:swap` 保证 Latin 文字先以系统字体显示（无不可见期）；中文不受影响

### 需求:比价页必须以 CSS View Transitions 转场且无客户端 JS

比价页 MUST 用 CSS `@view-transition { navigation: auto }`（纯 CSS、跨文档）为现有整页 GET 导航（筛选/排序/移除 chip）提供 app 般转场；MUST NOT 依赖客户端 JS 实现转场或任何交互（交互仍 SSR GET / 原生元素、无框架、无 filter island）。转场 MUST 在 `prefers-reduced-motion: reduce` 下降级为无动画/即时切换——**MUST 显式把 `::view-transition-old(*)` / `::view-transition-new(*)` / `::view-transition-group(*)` 的动画置零（`animation: none` 或 `animation-duration: 0s`），MUST NOT 仅省略 `@view-transition` at-rule**（跨文档默认交叉淡入仍会在 reduce 下动）；无转场时功能与 a11y 不受影响（优雅降级）。

#### 场景:整页导航有转场、无 JS
- **当** 用户提交筛选或点排序（整页 GET 往返）
- **那么** 经 `@view-transition` 呈现转场；全程无客户端 JS；旧浏览器无转场但功能正常

#### 场景:尊重减少动效
- **当** 用户系统设 `prefers-reduced-motion: reduce`
- **那么** 转场降级为即时切换、无动画

### 需求:比价页状态标记必须由 CSS 绘制承载、不以 emoji 承载

比价页的状态视觉记号（新鲜度今日/N天前/待核、最划算、最佳周期、已停售、状态未知、待复核、⚠估算）MUST 由 CSS 绘制（圆点/形状/伪元素/小 span），MUST NOT 用装饰 emoji（🟢🟡🔴🟠⭐🏆🚫❓⚠ 等）承载。每个状态 MUST 仍带**文字标签**（状态不单靠颜色/形状/emoji，沿用既有 WCAG 契约）；CSS 绘制的记号 MUST `aria-hidden` 或纯装饰、不承载可及名。此为纯呈现替换，MUST NOT 改变状态的判定逻辑或文字。

#### 场景:状态由 CSS 记号 + 文字、无 emoji
- **当** 渲染任一状态徽标（如陈旧/最划算/待复核）
- **那么** 视觉记号由 CSS 绘制、无 emoji 字符；文字标签照旧呈现并承载状态；屏幕阅读器读到文字标签（记号装饰不可及）

### 需求:比价页主行必须为精简 5 列且每 plan 有全宽可展开详情行

比价页 MUST 将每个 plan 呈现为：① 主 `<tr>` 恰含 5 列 `套餐（名 + availability/待复核 状态标）· 厂商 · 月价（+最划算）· 最佳周期（周期名+折算月价摘要，无则 —）· 数据新鲜度（含陈旧态）`；② 紧随全宽详情行 `<tr><td colspan="5" aria-labelledby="plan-{plan.id}"><details><summary>{套餐名} 详情</summary>…</details></td></tr>`（原生 `<details>`、无 JS、行头 id 由 `plan.id` 派生保证页面唯一）。详情内 MUST 用分区 `<dl>`，其 grid 落在每对 `<dt>+<dd>` 的 `.detail-row` wrapper 上、MUST NOT 对 `<dl>` 元素本身用 `display:grid/flex`（保 Safari/VO 的 description-list role）；无数据段用 `—` 占位。模型/工具协议/额度(+估算)/季年付明细/溯源 MUST 收进详情、MUST NOT 占主行列。停售 plan 的主行与详情行 MUST 同挂降权样式。四问 MUST 仍可答（筛选驱动 + 主行月价/最划算/新鲜度可扫读）。（本结构沿用自被吸收的 layout-refresh、工作区已实现；本变更只换设计系统、不改此结构。）

#### 场景:主行 5 列、细节在详情
- **当** 渲染一个 plan
- **那么** 主 `<tr>` 只出现 套餐/厂商/月价/最佳周期/新鲜度 五列；模型/工具协议/额度/季年付/溯源 在其下全宽 `<details>` 详情行的分区 `<dl>` 内

#### 场景:详情行携带 plan 身份且 dl role 不丢
- **当** 展开某 plan 详情（无 JS）
- **那么** `<summary>` 含 plan 名、详情 `<td>` `aria-labelledby` 指向该 plan 行头 id；`.detail-row` wrapper 承载 grid、`<dl>` 本身不 `display:grid`（列表语义保留）

