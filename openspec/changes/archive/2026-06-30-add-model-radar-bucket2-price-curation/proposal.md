## 为什么

5d-B 上了「结构齐全、永远待核」的诚实空壳比价页，但桶2 coding_plan 至今 **0 已核价**（seed 7 个 coding_plan plan——GLM Lite/Pro + 百炼/千帆/腾讯/火山/讯飞——全填 `needs_login_recheck` 占位、`current_price`/`currency` 皆 NULL）。「同档谁最划算」永远显示「数据不足」。要让比价页真正答出赢家，必须把**真实价格**灌进去。

tech-plan 核心洞察：很多事实爬不到、权威值永远来自**人工策展**；5d 决策 3 已把「快前端」与「慢的 ops gate + egress + 人工策展」**显式解耦**（不把快前端钉死在慢长杆上）。真价进库只需既有的**单一授权改价入口** `recordPriceChange`（confidence 必官方 + 金额量级校验），录入后经既有 5d-A rebuild + 跨进程失效**自动**流到只读快照/页面——**零新接线**。这条路径**不依赖** browser-worker 自动抓取，故本变更与 browser/egress 生产启用**正交**：egress 部署封锁 gate 留到真要开自动抓取那一步即用即验（届时改 `model-radar-ingestion`「Playwright 沙箱锁定」既有需求，而非现在为一个不消费 job 的闲置 gate 建并空验）。

## 变更内容

- **桶2 真价人工策展**（本变更唯一交付）：人工核对桶2 coding_plan 厂商**真实定价页**（百炼/千帆/腾讯/火山/讯飞为结构化文档页，GLM 为 JS 渲染/登录墙），经既有 `recordPriceChange` 把可核实的真价从 `needs_login_recheck` 占位转为已核官方价。
- **可比真月价纪律**（新红线）：cheapest 按同档最低 `current_price` 选赢家，故录入须**同一计费基准可比**——① **真月付(month-to-month)标准价**（仅年/季付者留占位、不÷12 admit——年承诺折扣 + 页面无周期列披露，防年承诺冒充更便宜月价）；② **标准续费价**、促销/限时价**不写成 `current_price`**（不录、不冒充）；③ 计费模型异构（GLM `rolling_5h_requests` 限流档 vs 国内 `credit/month` 额度档）下 cheapest 仅表「月价最低」、限额行随页呈现供用户判断价值。此为人工核查纪律（含升 known 前置闸，因事后不可降级）、非机器闸。
- **比价页自动转出真价（条件达成、非保证）**：某 (coding_plan, currency) 同档 **render 层 ≥2 已核价**（既有 compare-web `plans.length≥2` 闸；snapshot `cheapestPlanId` 在 ≥1 即非 null）时，「同档最划算」从「数据不足」转出真实赢家（经既有 5d-A 链，无新接线）。本变更交付**策展执行**：达成可比 ≥2 则转真价、否则诚实留「数据不足」（不凑数）。锚 = 7 个 seeded coding_plan plan 中**可比的跨厂商同币种 ≥2**（同厂 GLM Lite/Pro 为退化下界、非跨厂选型价值；核不到留占位）。
- **文档同步**：ROADMAP「5d-C」拆出已交付的「桶2真价策展」与延后的「browser egress 生产启用」。

### 非目标

- **不做 browser-worker egress 生产封锁 gate / 不开自动 Playwright 抓取**：egress 部署封锁 + fail-closed 实跑勘验属 browser/prod 启用前置，与本变更正交，留到真开自动抓取那步（届时 MODIFY `model-radar-ingestion`「Playwright 沙箱锁定」，即用即验，不在此为闲置 gate 空验）。
- **不写万能抽取器**（tech-plan 红线）；**不让抓取直写 `current_price`**（真价一律人在环经 `recordPriceChange`）。
- **不改 DB schema、不新引依赖、不改 5d-B 页面交互、不做跨桶**；**不从未核价编「最划算」**、不臆造价（既有红线保留）。

## 功能 (Capabilities)

### 新增功能
（无——真价进库经既有 `recordPriceChange` + 既有 5d-A 链，无新能力）。

### 修改功能
- `model-radar-compare-api`: 「桶2数据策展只录已核价格、允许零已核价」需求——从「5c 本期允许 0 已核价、browser 勘验为后续 gate」修订为「5d-C **执行**人工策展：经授权改价入口录入可核实**真月付(month-to-month)标准价**（仅年/季付者留占位、促销价不录），使桶2同档可比 ≥2 已核价转出真实最划算；核不到者保留 `needs_login_recheck` 占位、**允许零已核价不变**」。

## 影响

- 数据：桶2 coding_plan 可核实真价经 `recordPriceChange`（`src/mr/ingest/record-price-change.ts`）录入（seed 占位转真值）；**并修正 seed 错指的 `source_url`**（部分指向 Token/计费总览页而非 Coding Plan 订阅页，经 `upsertSource` 校正）；DB schema 不变。已 web-search 核实 GLM/百炼/火山均有 CNY 扁月付 Coding Plan 订阅（≥2 跨厂可比、退出可达）。
- 代码：至多一个**薄**策展 helper（仅转调 `recordPriceChange`、不绕校验/不新逻辑）——或直接 `tsx -e` 一次性调用，不留 CLI 表面（ponytail）。
- 契约：读路径仍只读、fail-closed、内容哈希 version 不变；改价经既有授权入口触发 5d-A rebuild/失效（**无新接线**）。
- 文档：ROADMAP「5d-C」拆分（本变更 = 桶2真价策展已交付；browser egress 生产启用延后）。
