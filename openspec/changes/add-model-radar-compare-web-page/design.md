## 上下文

5c 交付了只读快照（`src/mr/snapshot/`：内容哈希 version/ETag、离散 `stale`、fail-closed）+ 比价/检索 API（`src/mr/api/model-radar.ts`）+ 桶2 数据红线；5d-A 补了快照跨进程失效（HTTP server 进程缓存对其它进程的写一致）。**还缺 UI**。本变更（5d-B）上项目首个真前端：Hono JSX SSR 只读比价页。技术栈与已锁决策见 `docs/model-radar-tech-plan.md`「Q1 技术栈」+「5d 决策记录」（决策 3 先 ship 诚实空壳 / 决策 4 per-fact age）。前端读 5c 快照、不碰规范化表、不写库。

## 目标 / 非目标

**目标：**
- 浏览器 10s 内答四问：谁含 GLM-5.2 / 谁支持 Claude Code / 同档谁最划算 / **谁最近被核对·谁最陈旧**（快照无价格变更时间线，故不答「谁最近变价」）；每格可溯源（`source_url`/age/`source_confidence`）。
- per-fact age 进快照 DTO（决策 4）：日粒度、**按 UTC 截断**、数据派生、进哈希仍稳定。
- 诚实呈现未核价 + 待复核（决策 3）：不冒充已核、不从未核价编「最划算」。
- 复用 5c 快照 + 5d-A 跨进程一致性；新增面最小、零新运行时依赖（`hono/jsx` 在既有 hono 内）。

**非目标：**
- 不引 SPA/React/Next/打包器；页面不做写、不做登录鉴权（公开只读）。
- 哈希里不放连续 age/raw 秒级时间戳；不做跨桶价比较；不做超出 snapshot API 既供数据的交互。
- 不做 5d-C（browser/egress gate、真价勘验、人工策展）；不做 CDN/R2 托管；不做推荐器（5e）。

## 决策

### D1. per-fact age：`lastCheckedDate` per-provenance、日粒度、数据派生、进哈希（决策 4）

5c 服务表征**只暴露离散 `stale: boolean`**、且既有主规范正式条款明禁「也不暴露 `lastCheckedDate`」。本变更**修订**该条款（compare-api delta 走 `## 修改需求`）：给**每条事实行 provenance（含 plan 价格事实 + limit/client/model + 关联源）**加 `lastCheckedDate`（**日粒度** ISO 日期），由 builder 从该行 `last_checked` 在单事务 point-in-time 派生。**价格事实的 date = `trunc(plan.last_checked)`**（单行列，非跨事实聚合——「不暴露 plan 级聚合 date」禁的是「跨所有源取 max/min」，不禁价格行自身的 date）。关联源在 `snapshotSourceSchema`（与 `snapshotProvenanceSchema` 两套 schema，仅 `mr_source.last_checked` 可 NULL → 该项 date 可缺省）。

- **为何进哈希仍稳定**：`lastCheckedDate = trunc_UTC(fact.last_checked)`，是该 DB 行值的**纯函数、完全与 `now` 无关**——`now`（build/render 时钟）推进、**即便跨过任何 UTC 自然日界，也不改变它**；仅当 fact `last_checked` 被**写**到新 UTC 日才变（一次 DB 写、非时间流逝）。故 `now` 推进**永不**因 `lastCheckedDate` 改哈希——快照哈希对 now 的唯一敏感仍是既有 `stale`（跨 staleness 阈值翻转）。每日滚动的「N 天前」是 `render_now − lastCheckedDate`、**只在 render 层算、不入哈希**——勿把这个 render-only 的日界滚动与 hashed `lastCheckedDate` 混为一谈（前者每日变、后者只在重核写时变）。**截断必须按固定 UTC**（`toISOString().slice(0,10)`）——按进程本地 TZ 会让同一 `timestamptz` 瞬间在不同 `process.env.TZ` 进程截成不同日 → 哈希分叉 → 破 5d-A 跨进程一致性（须加「同瞬间不同 TZ 同 date」测 + 「无写 now 跨午夜哈希仍稳定」测）。
- **为何 per-provenance、不 plan 级聚合**：plan 级「取哪条源的 date」有聚合歧义（5c 已为此丢弃 `lastCheckedDate`）；per-fact 行无歧义——每条事实带自己的 date。
- **徽标分两层粒度**（禁混用）：**per-fact** 🟢 今日 / 🟡 N 天前 由 `render_now − lastCheckedDate` 在渲染层算（不进哈希）；**plan 级** 🔴 待复核/陈旧 来自既有 plan 级 `stale`/`reviewStatus.pending`（快照**无 per-fact stale 字段**，禁用 plan 级 stale 冒充 per-cell——会把一个 child 陈旧污染整行）。

替代：①plan 级聚合 date 进哈希 → 拒（聚合歧义，5c 已弃）；②raw 秒级 `last_checked` 或 render-now 进哈希 → 拒（连续量/now 致每周期漂移，违 5c 稳定性）。

### D2. Hono JSX SSR、不引 SPA/打包器

页面在服务端用 `hono/jsx` 从快照渲染完整 HTML。读多写少 + 一个小 JSON + 写入罕见 → SSR 直读快照最省，ISR/SPA 是大炮打蚊子（tech-plan ponytail）。CSS v1 **内联 `<style>`**（免 serveStatic + MIME；量起来再外置同容器）。

替代：Next/React-SPA + ISR → 拒（一个页面、一个小 JSON、写罕见，SSR 已满足；SPA 框架延后到交互复杂度真要求）。

### D3. 读路径：复用 5c 快照、只读、fail-closed

页面经既有 `getModelRadarSnapshot()`（冷启动 build-from-DB、fail-closed）取快照；**不查规范化表、不写库**。5d-A 的跨进程失效 + 周期 rebuild 保证 server 进程缓存新鲜。冷启动首建失败 → 503（沿用 5c）。**HTML 页不挂 version-304**：page body 含 live `render_now` 派生的相对 age（「N 天前」），若用 snapshot version 作 ETag，快照未变而日界已过时会 304 出陈旧「今日」（重新引入 5c 力避的 304-with-stale，且违「诚实呈现新鲜度」）。SSR 从内存快照极廉、每请求重渲即可；JSON `/model-radar/snapshot` 的内容哈希 ETag 不受影响（它不含 render-time age）。

### D4. 过滤/排序：服务端在快照对象上做、SSR query-param chips

筛选 chips（model / tool / protocol / currency / budget）= **query 参数**（**渐进增强：无 JS 也可用**）。**过滤/排序/最划算必须经既有 `queryModelRadarSnapshot(snapshot, params)`** 取 `groups`/`cheapestPlanId`/`comparable`/`unknownCount`——它是守「未知价不入 cheapest / NULL 不当 0 / 同 (category,currency) 分组」的 vetted money-path 函数；**禁止**在裸 `getModelRadarSnapshot()` 对象上手搓 cheapest（绕过守卫 + 对 `currentPrice=null` 直接 `formatMoney` 会 SSR NPE）。裸快照只用于取结构字段；render 对 null 价显式占位、不 format。若需即时客户端重排再加一个**极小原生 island**（非框架、**非 Preact**）——v1 默认纯 SSR，island 仅在交互真要求时加；island 须**外联同源脚本**（CSP `script-src 'self'` 不放行内联 `<script>`），其结果数变更须 `aria-live`（a11y ⑬）；island 若内联快照只内联桶2（不把其它桶随 HTML 下发）。

**调用边界（防 `.strict()` 400）**：`getModelRadarSnapshot()` 返回 `{ snapshot, version }`——须传 `.snapshot` 给 `queryModelRadarSnapshot`；`params` 是 `.strict()` 的 `modelRadarQueryParamsSchema` 输出，**页面自有 query-param（估算旋钮、freshness 排序等 web-only）不在该 schema**——路由必须只把 API 子集喂 `modelRadarQueryParamsSchema`（`ZodError → 400`），web-only param 留在 strict schema 外、在 render 层用。**`queryModelRadarSnapshot` 只做价格排序/cheapest（per (category,currency)），无新鲜度排序**；Q4「最近被核对/最陈旧」的排序是 **render 层对 per-fact `lastCheckedDate` 的重排**（取 plan 的 min/最旧 fact date 作排序键、仅 render 层、不入 DTO/哈希、不碰 money-path）；**关联源行 date 为 null（从未抓）排序上视为最陈旧**（plan 经既有 stale 聚合本已判陈旧），不得让 null-date plan 误排为新鲜。`unknownCount` 挂在该 category 的 `currency=null` 组（已核币种组上恒 0，`query.ts:171`；`query.ts:170` 是 `comparable:true`）——「另有 N 未核未参与」披露须**跨引该 category 的 null 组**取 N。「已核 <2 不输出最划算」须**数 plans.length≥2**（`comparable=true` 对单 plan 已核组也成立，仅 comparable 不足判）。

### D5. 「估算中等任务轮次」带旋钮区间、视觉次于官方额度、挂 ⚠

由快照既供的限额事实（limit 行）+ 一个**假设旋钮**（如每轮 token 量）算出一个**区间**；**只在快照既供数据上算，不引入新事实**。渲染上**视觉次于**官方原始额度（小字/次级色）、显式挂 ⚠ 估算。旋钮 v1 用 query-param 或极小 island；默认假设给一个保守值 + 可调。绝不把估算当事实、绝不进哈希。

### D6. 桶2 UI gate + 诚实呈现未核/待核（决策 3）

数据本就跨桶入库；本期页面 facet 到 `category==='coding_plan'`（枚举字面，多模型 Coding Plan），其余桶 v2 翻 tab（近零代码）。未核价（占位 NULL + `needs_login_recheck`）**显式呈现为「待核」、不参与「最划算」、不冒充已核 provenance**；这是诚实空壳的本体——结构/兼容/最近被核对三问即便价未核也可答，「最划算」= 已核中最低 + 显式披露「另有 N 个未核价未参与」（`unknownCount`），全未核或已核仅一个时不输出最划算标签（标「待核」而非编造）。

### D7. 首个公开页的输出编码 / href scheme 闸 / CSP（安全基线）

页面把快照 DB 串渲进 HTML，是项目**首个** HTML 渲染 `mr_*` 的面。`hono/jsx` 默认转义文本/属性值（挡 HTML 注入），**但不挡 URL scheme**。fact-row provenance 的 `source_url` 录入侧仅过 `mrSourceUrlSchema`（`validators.ts:42`，只拒空白、**不校 scheme**；`assertUrlAllowed` 只施于 `mr_source` 行）→ `javascript:`/`data:` 可入库 → 渲成可点 `<a href>` = 存储型 XSS。故：所有快照串经默认转义、禁 `raw()`/`dangerouslySetInnerHTML`；`source_url` 渲链接前 **gate scheme ∈ {http,https}** 且拒含 userinfo 的 `good.com@evil.com` 钓鱼向量，否则降级纯文本；响应挂 **CSP 头**（首个公开页基线 + 防 5d-C 流入抓取内容时的纵深）：`default-src 'none'`（收口 object/connect/img/font… 等未声明取数指令）+ `script-src 'self'`（脚本仍只同源、留未来同源 island）+ **`style-src 'self' 'unsafe-inline'`**（内联 `<style>` 非 script-XSS 向量、页面无内联脚本；`default-src 'none'` 配**显式** style-src 不拦内联样式）+ `base-uri 'none'`（防注入 `<base>` 劫持相对链接/表单）+ `form-action 'self'` + `frame-ancestors 'none'`（防点击劫持）。注意只禁 `default-src 'self'`（它无 `'unsafe-inline'` 会拦内联 `<style>` → 裸样式 + 破 a11y CSS），`'none'` + 显式 style-src 则安全。并把「复核 fact-row provenance source_url 录入是否应同样过 `assertUrlAllowed`（防御纵深）」列为本变更 task。

### D8. 可访问性（WCAG 2.2 AA，原生优先）

首个公开页须键盘 + 屏幕阅读器可用，**原生语义优先于 ARIA**（最好的 ARIA 是不写 ARIA）：原生 `<table>`+`<caption>`+`<th scope>` 解决表语义；`<details>/<summary>` 解决无 JS 行展开 + 键盘 + 语义；`<input type=range>`/`<select>` 解决估算旋钮。徽标含**文字标签**（非仅色/emoji）；排序列 `aria-sort`；可见焦点；`lang`/`title`/地标/skip-link；对比 ≥4.5:1。详见 compare-web spec「WCAG 2.2 AA」需求。

## 风险 / 权衡

- **per-fact age 误入哈希漂移 / 跨进程 TZ 分叉** → 若把 render-now/raw 秒级塞进 DTO 则每周期漂移；若按进程本地 TZ 截断则不同 TZ 进程对同一瞬间产出不同 date → **破 5d-A 跨进程一致性**。缓解：`lastCheckedDate` 日粒度、数据派生（=`trunc_UTC(last_checked)`、完全 now 无关）、**固定 UTC 截断**；「N 天前」只在 render 算、不进 DTO（测试钉「**无写 now 推进即便跨午夜 → 哈希不变**；fact `last_checked` 被写到新 UTC 日 → 哈希变；同瞬间不同 `process.env.TZ` → 同 date 同哈希」）。
- **SSR-only 交互受限** → 若四问需要富交互（即时多维过滤）→ 缓解：渐进增强（query-param chips 无 JS 可用）+ 仅在真要求时加极小原生 island，不引框架。
- **页面多为未核价（决策 3）** → 视觉上「一片待核」。缓解：这是刻意的诚实呈现、不是缺陷；四问中三问不依赖价；「最划算」在价未核时标「待核」降级。真价经 5d-C 流入后自然填满。
- **首个前端、无既有前端测试范式** → 缓解：SSR 渲染可对 HTML 字符串/DOM 断言（四问可答 + 每格溯源 + 未核不入最划算 + 桶2 gate），无需浏览器 e2e；island（若有）留一个最小交互测试。

## 待解问题

- 估算旋钮的默认假设值 + 控件形态（slider vs select、query-param vs island）——design 给方向，具体在实现期定。
- 过滤是否需要一个客户端 island 才能达「10s 答四问」，还是纯 SSR query-param 足够——实现期按实际交互验。
