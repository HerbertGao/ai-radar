## 为什么

5c 交付了只读快照 + 比价/检索 API + 桶2 数据红线，5d-A 补了快照跨进程一致性——但**还没有 UI**。Model Radar 的核心价值（「浏览器 10s 内答四问、每格可溯源」）始终落不了地。5d-B 上项目**首个真前端**：Hono JSX SSR 只读比价页。按决策 3，前端先以「结构齐全、永远待核」的**诚实空壳**上线（真价经后续 5d-C 流入），把快前端从「ops gate + egress + 人工策展」这根慢长杆上解耦。

## 变更内容

- **快照 DTO 扩 per-fact age（决策 4，修订 5c 既有禁令）**：给每条事实行 provenance（含 **plan 价格事实** + models/clients/limits + 关联源）加 **per-provenance `lastCheckedDate`**（**按固定 UTC 截断到日**）。**数据派生**——fact 重核到新一天才变、`now` 推进不动它 → 进内容哈希仍稳定（绕开 5c「连续 age/now 进哈希致漂移」与「plan 级多源聚合取哪条」两个怕）。「N 天前」在 render 时算、不进哈希。**这是对 5c 主规范既有正式条款「服务表征…也不暴露 `lastCheckedDate`」的修订**（故 compare-api delta 走 `## 修改需求`、重写该需求开 per-fact 例外，仍禁 raw 秒级 last_checked + 仍禁 plan 级聚合 date）。
- **Hono JSX SSR 只读比价页**（`hono/jsx`，**不引 SPA/打包器**）：筛选 chips（model / tool / protocol / currency / budget）+ 可排序表（**经 vetted `queryModelRadarSnapshot` 取 groups/cheapest**，同 (category,currency) 内）+ 行展开看全字段与来源 + **plan 级 🔴 待复核**（freshness/reviewStatus 聚合）**+ per-fact 🟢/🟡 age**（lastCheckedDate，render 算）+ 每格溯源（`source_url` / age / `source_confidence`）。页面**不挂 version-304**（HTML 含 live render_now age）；`source_url` 渲链接前 gate scheme ∈ {http,https}（防存储型 XSS）；满足 WCAG 2.2 AA（原生 `<table>`/`<details>`/`<input range>` 优先）。
- **「估算中等任务轮次」做成带旋钮区间**：视觉**次于**官方原始额度、挂 ⚠ 估算；旋钮只在快照既供数据上算，不引入新事实。
- **诚实呈现未核价**：未核价保持占位、**不参与「最划算」**、不冒充已核 provenance。
- **桶2 gate 在 UI 层**：数据本就跨桶入库，本期页面只显桶2（多模型 Coding Plan）；其余桶 v2 翻 tab 近零代码。

### 非目标

- **不引 SPA / React / Next / 打包器**——仅 Hono JSX SSR（读多写少 + 一个小 JSON，SSR 直读快照最省）。
- **页面不做写、不做登录鉴权**（公开只读目录）。
- **不从未核价编「最划算」**；**哈希里不放连续 age / raw 秒级时间戳**（per-fact age 是日粒度数据派生）。
- **不做跨桶价比较**；不做超出 snapshot API 既供数据的交互。
- **不答「谁最近变价」**——快照不读 `mr_price_history`（5c 故意排除）、无价格变更时间线；本期四问之 ④ 是「谁最近**被核对** / 谁最陈旧」（`lastCheckedDate`/`stale` 支持），不冒充「谁最近变价」。引入 price_history 派生 changedDate 属未来项。
- **不做 5d-C**：browser/egress 生产 gate、真实定价页勘验、桶2 真价人工策展——前端先上诚实空壳，真价后续流入。
- 不做 CDN/R2 托管写出（量起来再议，tech-plan v2）；不做推荐器（5e）。

## 功能 (Capabilities)

### 新增功能
- `model-radar-compare-web`: Hono JSX SSR 只读比价页——筛选/排序/行展开/陈旧+age 徽标/估算轮次旋钮/每格溯源/未核价诚实呈现/桶2 UI gate。

### 修改功能
- `model-radar-compare-api`: **`## 修改需求`** 重写「快照版本与 ETag 必须随数据变更失效」需求——既有正式条款是「服务表征…不暴露 raw 秒级 `last_checked`、**也不暴露 `lastCheckedDate`**」；本变更将其修订为「不暴露 raw 秒级 last_checked、不暴露 **plan 级聚合** date，**但暴露 per-provenance 日粒度 `lastCheckedDate`**（数据派生、按 UTC 截断、进哈希仍稳定）」。这是对既有禁令的**修订**（非单纯叠加），否则归档后主规范自相矛盾。公开 version/ETag 仍唯一来自内容哈希。

## 影响

- 代码：新增 `src/mr/web/`（Hono JSX SSR 路由 + 组件，接进 `src/app.ts`）；扩 `src/mr/snapshot/{build.ts,dto.ts}`（per-provenance `lastCheckedDate`）；可能加极少量**原生** JS island（**非框架、非 Preact**，仅交互真要求时）。
- 依赖：`hono/jsx` 在既有 `hono` 内（**无新运行时依赖**）；前端 CSS v1 **内联 `<style>`**（免 serveStatic + MIME，量起来再外置同容器）。
- 契约：复用 5c 只读快照（含 5d-A 跨进程失效）；读路径仍只读、fail-closed、内容哈希 version 不变。
- 不改 DB schema、不新增 BullMQ 链、不让抓取直写 `current_price`（人在环经 `recordPriceChange`）。
- 测试：per-fact age 进哈希后稳定性（now 推进不变、fact 重核才变）；SSR 渲染四问可答 + 每格溯源 + 未核价不入「最划算」+ 桶2 gate。
