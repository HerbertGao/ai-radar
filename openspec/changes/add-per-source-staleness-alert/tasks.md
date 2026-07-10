## 1. 配置（env）

- [x] 1.1 在 `src/config/env.ts` 增 `SOURCE_STALENESS_ALERT_DAYS`（zod 正整数，默认 3）。
- [x] 1.2 在 `src/config/env.ts` 增 `SOURCE_STALENESS_ALERT_DAYS_OVERRIDES`（逗号分隔 `source:days` 串），解析为 `Map<string, number>`。容错解析（advisory 配置，**有意不 fail-fast**）：天数非正整数/非整数、缺段、空串项一律**跳过并记日志**；`source` 不在已注册源集合内的键跳过并记日志（提示拼写）；同源多次 last-wins；空值 → 空 Map。
- [x] 1.3 在 `.env.example` 补两个变量与注释（含按源覆盖示例，如 `product_hunt:2,blogger:7`）。

## 2. 检测模块

- [x] 2.1 新建 `src/pipeline/source-staleness.ts`，导出 `detectStaleSources({ now, sources?, thresholds?, defaultDays? }, dbh)`；`sources` 默认取 `buildRegistry().map(e => e.source)` 去重，**再剔除结构性停用源**（list 型配置为空：`RSS_FEEDS` 空的 `rss`、`BLOGGER_FEEDS` 空的 `blogger`、`SITEMAP_SOURCES` 空的 `sitemap`），`thresholds`/`defaultDays` 默认取 env。
- [x] 2.2 实现按源聚合查询：`SELECT source, max(fetched_at) FROM raw_items WHERE source = ANY($sources) GROUP BY source`（Drizzle）。
- [x] 2.3 实现判定：对每个已注册源，结果集缺席或 `max(fetched_at) < now − 该源阈值天数` → 陈旧；返回 `{ source, lastFetched: Date|null, staleDays: number|null }[]`（仅含陈旧源）。阈值解析：源在 overrides 里用其值，否则用 `defaultDays`。
- [x] 2.4 判定逻辑禁止任何 LLM 调用（纯 DB + 程序比较）。

## 3. 接入日报工作流

- [x] 3.1 在 `src/pipeline/run-daily-workflow.ts` **紧接 `classifySystemFailure`/系统级告警块之后（约 line 478）、judge 熔断 throw（约 578）之前**，加一个 `try/catch` 包裹的 best-effort 阶段调用 `detectStaleSources`（注入工作流的 `now` 与 `dbh`）。**只借 `countAiGatedOut` 的 try/catch 隔离范式，不得并排放到 `countAiGatedOut`（约 759，在两个 throw 之后）旁边**——否则熔断日不检测。
- [x] 3.2 发现 ≥1 陈旧源 → 调一次注入的 `AlertSink`，消息体列出每个源的 `source` + `lastFetched`（或"从未产出"）+ 已零新增天数；无陈旧源不调。
- [x] 3.3 确认该阶段异常仅记日志、不向上抛、不进 judge/digest 熔断分母、不影响 `outcome`/推送（与既有 best-effort 阶段一致）。

## 4. 测试

- [x] 4.1 单元测：env 覆盖串解析（正常/`blogger:0`/`blogger:-1`/`blogger:abc`/未知源 `blooger:7`/重复 `blogger:7,blogger:2` last-wins/空）→ 正确 `Map` + 非法项被跳过；阈值选取（有覆盖用覆盖、无覆盖用默认）。
- [x] 4.2 单元测：判定逻辑（注入 mock 查询结果）——超阈值/阈值内/结果缺席(NULL→陈旧) 三种。
- [x] 4.3 集成测（真实 pg）：种入不同 `fetched_at` 的 `raw_items`，断言陈旧源被识别、新鲜源不被识别、从未产出的已注册源判陈旧；用唯一 source 前缀隔离并清理。
- [x] 4.4 集成/单元测：注入抛错的查询桩，断言 best-effort 阶段被隔离、`runDailyWorkflow` 的 `outcome` 与推送不受影响、不进熔断分母。
- [x] 4.5 测 AlertSink 契约：注入 mock `AlertSink`——有 ≥1 陈旧源时**恰好调用一次**且消息含每个陈旧源的 `source` + `lastFetched`/`staleDays`；全部新鲜时**零调用**。
- [x] 4.6 测 registry 默认源集合：不传 `sources`，断言检测器读 `buildRegistry().map(e => e.source)` 且**排除结构性停用源**（`RSS_FEEDS`/`BLOGGER_FEEDS`/`SITEMAP_SOURCES` 为空时不含 rss/blogger/sitemap）、配置非空的已注册无产出源被纳入并判陈旧——不改检测代码即验证自动纳入。

## 5. 规范同步与收尾

- [x] 5.1 `npm run typecheck`、`npm run lint`、`npm test` 全绿。
- [ ] 5.2 运行 `/opsx:apply` 完成实现后，按流程 `/opsx:archive` 将 `source-staleness-alert` 增量规范同步进主规范。
