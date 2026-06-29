## 1. 快照 DTO per-fact age（后端面，先行——前端依赖；design D1）

- [x] 1.1 `src/mr/snapshot/dto.ts`：给 `snapshotProvenanceSchema`（plan 价格事实 + models/clients/limits）+ `snapshotSourceSchema`（关联源，仅其 date 可 NULL）加 `lastCheckedDate`（日粒度 ISO 日期）；plan 级**不**加聚合 date；**同步更新 dto.ts:9 / cache.ts / build.ts 里「绝不暴露 lastCheckedDate / ETag=服务表征纯函数」的过时注释**（与新规范一致）
- [x] 1.2 `src/mr/snapshot/build.ts`：在单事务 point-in-time 视图内，从各事实行 `last_checked` 派生 `lastCheckedDate`——**按固定 UTC 截断到日**（`toISOString().slice(0,10)` 或 SQL `AT TIME ZONE 'UTC'`，**禁进程本地 TZ**）；**价格事实 date = `trunc(plan.last_checked)`**（单行列，勿漏）；`mr_source.last_checked` NULL → date 缺省 + 仍判陈旧
- [x] 1.3 哈希稳定性单测：① **无 DB 写、`now` 推进即便跨 UTC 午夜 → 哈希/version 稳定**（`lastCheckedDate`=`trunc_UTC(last_checked)` 完全 now 无关，防回归到 now-leaky 实现 / 每日过度失效）；② 某事实 `last_checked` 被**写**到新 UTC 日 → 该 `lastCheckedDate` 变 + 哈希变；③ **跨进程 TZ 一致性**：同一 `last_checked` 瞬间在 `process.env.TZ=UTC` 与 `Asia/Shanghai` 下截出**同一** date 字符串 + **同一**哈希；④ 断言 DTO 不含 raw 秒级 `last_checked`、不含 plan 级聚合 date；关联源行 date 可 null

## 2. Hono JSX SSR 页面骨架 + 路由（design D3/D7）

- [x] 2.1 新增 `src/mr/web/`：Hono JSX（`hono/jsx`）路由 `GET /model-radar`，经 `getModelRadarSnapshot()` 取快照、SSR 出 HTML；**不查规范化表、不写库**；接进 `src/app.ts`
- [x] 2.2 **HTML 页不挂 version-304**：每请求以 live `render_now` 重渲（HTML 含 render-time 相对 age，version-304 会服务陈旧 age）；冷启动首建失败 → 503（沿用 5c，镜像 model-radar.ts try/catch）
- [x] 2.3 安全头 + 静态资源：响应挂 **CSP `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`**（`default-src 'none'` 收口未声明取数指令 + 脚本只同源 + 容内联 `<style>` + 防 `<base>`劫持/表单外泄/点击劫持；**禁 `default-src 'self'`**——它无 `'unsafe-inline'` 会拦内联 style 破 a11y CSS，但 `'none'`+显式 style-src 安全）；CSS **内联 `<style>`**（免 serveStatic + MIME，ponytail；量起来再外置）
- [x] 2.4 页面布局组件（`hono/jsx`）：chips 容器 + 原生 `<table>`+`<caption>`+`<th scope>` + 行展开（原生 `<details>/<summary>`）
- [x] 2.5 **复核 fact-row provenance `source_url` 录入闸**（防御纵深）：核 `validators.ts:42 mrSourceUrlSchema` 仅拒空白、`assertUrlAllowed` 只施于 `mr_source` 行；决定是否给 fact-row provenance 录入也加 scheme/allowlist 闸（render 层 scheme 闸 task 3.3 是主防线；本 task 评估录入侧纵深）

## 3. 答四问：筛选 / 排序 / 最划算 / 溯源（design D4；spec model-radar-compare-web）

- [x] 3.1 筛选 chips = query 参数（渐进增强、无 JS 可用）：model / tool / protocol / currency / budget facet
- [x] 3.2 **比价/排序/最划算经既有 `queryModelRadarSnapshot(snapshot, params)`** 取 `groups`/`cheapestPlanId`/`comparable`/`unknownCount`——**禁**在裸快照上手搓 cheapest（绕 vetted 守卫）；render 对 `currentPrice=null` **显式占位、不 format**（防 NPE）
- [x] 3.3 行展开溯源：每条事实呈现 `source_url` + age 徽标 + `source_confidence`；**`source_url` 渲 `<a href>` 前 gate scheme ∈ {http,https}，否则降级纯文本**（防存储型 XSS；fact-row URL 录入不校 scheme）
- [x] 3.4 Q4「谁最近被核对/谁最陈旧」：据 per-fact `lastCheckedDate` + plan 级 `stale` 呈现/排序（**不**声称「谁最近变价」）

## 4. 诚实呈现：徽标分层 + 未核价 + 桶2 gate（design D6；决策 3）

- [x] 4.1 徽标**分两层粒度**：**plan 级** 🔴 待复核/陈旧（`freshness.stale`/`reviewStatus.pending` 聚合）；**per-fact** 🟢 今日/🟡 N 天前（`lastCheckedDate`，render 算 `render_now − date`）；关联源行 date 为 null（从未抓）→ 显「待核/从未核对」不显 🟢🟡；**禁**用 plan 级 stale 冒充 per-cell；徽标含**文字标签**（非仅色/emoji）
- [x] 4.2 未核价显式「待核」、不入最划算；最划算 = 已核中最低 + 「另有 N 个未核价未参与」（`unknownCount` 取该 category 的 `currency=null` 组、勿读已核组上的 0）；**已核 <2（数 `plans.length≥2`，非仅 `comparable`）不输出**最划算
- [x] 4.3 桶2 UI gate：facet `category==='coding_plan'`（枚举字面）；chips 不含 category facet；不动数据层

## 5. 估算中等任务轮次旋钮（design D5）

- [x] 5.1 估算区间：从快照限额事实 + 可调假设旋钮算区间；**不引快照外新事实、不进哈希**；`limit.value` 为 NULL 时优雅降级（不输出区间、不 NPE）
- [x] 5.2 渲染：区间**视觉次于**官方额度 + **⚠ 估算**（文字，非仅 emoji）；旋钮原生 `<input type=range>`/`<select>`（query-param 无 JS 回退）

## 6. 可访问性 WCAG 2.2 AA（design D8；spec「WCAG 2.2 AA」需求）

- [x] 6.1 表语义：原生 `<table>`+`<caption>`+`<th scope=col>`+行头 `<th scope=row>`；排序列 `aria-sort` + 排序控件方向性可访问名
- [x] 6.2 行展开/旋钮/chips：键盘可达 + 可见焦点环（对比 ≥3:1）；chip 已选态 `aria-current`/`aria-pressed`；emoji `aria-hidden`、文字承载语义
- [x] 6.3 外壳：`<html lang="zh-Hans">`、描述性 `<title>`（反映筛选）、地标（nav/main/header）、skip-link；文字对比 ≥4.5:1
- [x] 6.4 **Reflow/Resize**（1.4.10/1.4.4）：表在 320px 宽不双向滚动、400% 缩放无内容丢失（横向滚动容器或堆叠卡片，保留行/列头关联）；**目标尺寸**（2.5.8）chips/排序/`<summary>`/range ≥24×24px；`source_url` 链接描述性可访问名（2.4.4，非裸 URL）；island 路径若有则结果数 `aria-live`（4.1.3）

## 7. 测试

- [x] 7.1 SSR 渲染测（对 HTML/DOM 断言，不需浏览器 e2e）：按模型筛选答「谁含 X」、每格可溯源、同档排序经 queryModelRadarSnapshot 不跨桶/币
- [x] 7.2 诚实呈现测：plan 级 🔴 vs per-fact 🟢🟡 分层；未核价不入最划算 + 「N 未核未参与」披露 + 已核<2 不输出；桶2 gate 只显 coding_plan
- [x] 7.3 **XSS 测**：provenance `source_url=javascript:...`/`data:...` → 渲为纯文本、无 `<a href>`；CSP 头存在
- [x] 7.4 **age live 测**：同 version 快照、render_now 跨日 → age 文案更新（页面不返回 304-with-stale）
- [x] 7.5 只读不变量：页面渲染路径不写 `mr_*`、不 bump version；冷启动失败 503
- [x] 7.6 估算旋钮测：区间随假设重算、标 ⚠、不进哈希；`limit.value=null` 降级不 NPE
- [x] 7.7 a11y 测：渲染 HTML 含 `<table>/<caption>/<th scope>`、`<details>`、`lang`、徽标文字标签、`aria-sort`（HTML 断言 / axe 之类）

## 8. 验证

- [x] 8.1 `openspec-cn validate add-model-radar-compare-web-page --strict`（通过）
- [x] 8.2 `npx vitest run src/mr/snapshot src/mr/web`（snapshot+web 9 文件 101 测全绿；全仓 src/mr 202 文件 1897 测无回归）
- [x] 8.3 `npx tsc --noEmit`（0 错）+ `npm run lint`（eslint 干净）
- [x] 8.4 浏览器手测/键盘·SR 走查无法在此环境复现 → 以 35 个 SSR HTML 断言测覆盖（四问筛选/每格溯源/未核价「待核」/桶2gate/a11y 标签/无304）+ B1 22-check 运行时 smoke render；真浏览器/截图走查留待手测
