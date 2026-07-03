## 修改需求

> 说明：本变更把 `/model-radar` 从「表优先」翻成「答案优先」（推荐器上网作主角，见新增 capability `model-radar-answer-first-web`）。既有比价表的**口径 / 结构 / 最划算 / provenance / money-path / a11y 一律不变**，仅**呈现位置**从「页面主体」变为「答案下方可展开的证据抽屉」。以下 2 条需求同步这一重定位；其余比价表需求（5 列主行 / 详情行 / 季年付 / availability / WCAG 等）不变、继续约束抽屉内的表。

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
