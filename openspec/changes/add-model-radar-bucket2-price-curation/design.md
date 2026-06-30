## 上下文

5d-B 交付了只读比价页（诚实空壳）。桶2 coding_plan 价格全 `needs_login_recheck` 占位。seed（`seed-data.ts`）已结构录入 **7 个 coding_plan plan**：GLM Coding Plan Lite/Pro（`bigmodel.cn`，JS 渲染/登录墙、活动浮动）+ 百炼/千帆/腾讯混元/火山方舟/讯飞星火 Coding Plan（结构化文档页，`fetch_strategy='http'`），`current_price`/`currency` 皆 NULL。

既有可复用地基：
- `src/mr/ingest/record-price-change.ts:217` `recordPriceChange`：**单一授权改价入口**，confidence 必官方（`official_pricing`/`official_doc`）+ 金额量级校验（负/NaN/Infinity/超 scale/进制字面量全拒），最外层事务提交后调 `runSnapshotRebuild`（:226，never-throws）。
- 5d-A：rebuild 后 Redis pub/sub 跨进程失效 + 服务进程订阅/周期 rebuild（已归档）。故录真价 → 只读快照/比价页**自动更新，零新接线**。
- eslint `no-restricted-imports` + `structural-guard.test.ts`：禁 `src/mr/scrape/**` 与事件消费者 import ingest writers——保证真价只能经授权入口、非抓取直写。

约束（tech-plan / 既有红线）：权威值人工策展、真价人在环经 `recordPriceChange`、未核价不冒充已核、不臆造、同桶同币种才比、内容哈希 ETag 不变。

## 目标 / 非目标

**目标：**
- 经既有 `recordPriceChange` 把桶2 coding_plan **可核实**真价从占位转为已核官方价，使某 (coding_plan, currency) 同档 ≥2 已核价 → 比价页转出真实最划算（经既有 5d-A 链）。
- 立**促销 vs 标准价**纪律：录标准续费价作常态最划算依据，促销/浮动价单列不冒充。

**非目标：**
- 不做 browser-worker egress 生产封锁 gate、不开自动 Playwright 抓取（与本变更正交，留到真开自动抓取那步——见决策 D5）。
- 不改 DB schema、不新引依赖、不改 5d-B 页面、不做跨桶、不臆造价、不写万能抽取器。

## 决策

**D1. 真价人工策展，经既有 `recordPriceChange` 单一授权入口（不抓取直写）。**
权威值人工策展（爬不可靠：GLM 登录墙/JS 渲染、火山续费价登录后）。curator 在自己浏览器核对真实定价页 → 经 `recordPriceChange` 录入；confidence 转官方、`current_price`/`currency` 同生同灭落值。
- 备选：自动抓取后人确认（拒——本变更不开抓取；且多数爬不到）。

**D2. 可比标准月价纪律（新红线，本变更核心 spec 增量）。**
比价页「最划算」按 (coding_plan, currency) 内**最低 `current_price`** 选赢家，故录入的价必须**可比**：
- **① 基准 = 真月付(month-to-month)标准月价**：cheapest 只比**同一计费基准**。`current_price` 仅录**真月付**标准价（与既有 `maxMonthlyPrice` 月语义一致——DB 无计费周期列、按月比）。**仅有年/季付的 plan：其 ÷12 月等价含年承诺折扣、与真月付不可直接比，且页面无周期列披露承诺差异 → 保留占位、不 admit 进 cheapest**（不把年÷12 写成 `current_price` 冒充更便宜的月价）；周期不明者同样留占位。
- **② 标准续费价、非促销**：录标准续费价作常态依据；促销/限时/活动浮动价**不写成 `current_price`**（不录，避免冒充常态最划算误导选型）。**连续包月 steady-state 续费价可录；首月优惠/限时活动价（如各家 web-search 见的首月 ¥7.9/¥9.9/¥39.9）= 促销 → 不录、留占位**。`recordPriceChange` 量级校验只挡畸形、挡不住「促销/错周期冒充」——靠此纪律 + per-fact `source_url`/`last_checked` 可溯源兜，**本纪律为人工核查项（task 2.3）、非机器闸**。
- **③ 计费模型异构如实呈现**：seed 显示 GLM 走 `rolling_5h_requests`（限流档）、国内五家走 `credit/month`（额度档）——cheapest 仅表「同档月价最低」、**不表「最划算价值」**；各 plan 额度/限额行随页呈现（5d-B 既有）供用户判断价值。策展**优先取可比的跨厂商月订阅**作锚（见 D4）。
- 备选：录任何官方页价（拒——seed 自注 GLM「活动浮动」+ 国内额度档异构，促销/错周期/不可比失真都是真实风险）。

**D3. 真价经既有 5d-A 链自动流到页面，零新接线（已核实）。**
`recordPriceChange` 已在最外层事务提交后触发 `runSnapshotRebuild`（→ 5d-A pub/sub + 周期 rebuild）。比价页只读快照自动更新——本变更不写任何 rebuild/失效/页面代码。

**D4. 锚 = ≥2 个可比的跨厂商同币种月价 coding_plan plan（不硬钉 GLM、非同厂退化对）。**
退出标准要某 (coding_plan, currency) 同档 **render 层 ≥2 已核价**（见 D6）。候选是 **7 个** seeded coding_plan plan。**优先取跨厂商可比月订阅**——同厂 GLM Lite vs Pro 是退化下界（同产品内比、非跨厂选型价值）。国内五家（百炼/千帆/腾讯/火山/讯飞）是 `http` 档文档页、多 CNY，但其 `credit/month` 是**额度档**——只在它们公布**可比的标准月订阅价**时才录入参与 cheapest（按 D2①②③），无可比月价者保留占位。退出是否达成取决于实际可核到的可比 ≥2，**真不达即诚实留「数据不足」、不凑数**。

**D6. ≥2 闸在 render 层（compare-web），非 snapshot。**
`queryModelRadarSnapshot` 对单个已知币种 plan 即返 `cheapestPlanId` 非 null + `comparable=true`（≥1，query.ts:163-172）；「已核 <2 不输出最划算」由 **compare-web render**（`cheapestInfo` `plans.length≥2`，compare-web spec L65）守。故退出验证（task 2.1）必须断言**组内 `plans.length≥2`**（非仅 cheapestPlanId 非 null，后者 ≥1 即过、不证 ≥2）+ 1 价 setup 仍 render「数据不足」。本变更不新增 ≥2 闸（既有 compare-web 守），只让策展凑齐数据触发它。

**D5. egress gate 显式延后到 auto-scrape 启用那步（不在本变更）。**
egress 部署封锁 gate 保护的是 browser-worker；本变更不开自动抓取、不消费 job，故此刻建并「勘验」一个闲置 gate 既无保护对象、又在本变更交付物的关键路径之外（页面转真价只靠策展）。且既有 `model-radar-ingestion`「Playwright 沙箱锁定」需求**已拥有** egress/netns + fail-closed 自检契约——届时**MODIFY 该需求**（补部署机制 + 正向勘验），即用即验，而非现在 fork 一个重复且在此目标（Docker Desktop）上不可正向验证的新能力。这与 5d 决策 3「快/慢解耦」一致。

## 风险 / 权衡

- **人工录价手误 / 促销 / 错周期（合法但误导的数字）** → `recordPriceChange` 量级校验只挡畸形（负/NaN/Inf/超 scale），挡不住「合法但错/促销/年价当月价」；缓解：D2 纪律为 task 2.3 人工核查项 + per-fact `source_url`/`last_checked` 可溯源 + 单 curator 无写写竞争。**accepted-degraded**：人工录入的不可约边界，非机器可闸。
- **错价/错分类回滚受限（`recordPriceChange` 不能清回占位）** → 错价只能经 `recordPriceChange` **改为另一已核标准价**（留史），**无清回 NULL/占位 的授权入口**（newValue 非空 + 无清空路径，需另一不存在的入口，out-of-scope）；尤其 plan **误升 known**（实无可比真月付订阅，如纯 credit topup）后无授权降级路径。故缓解：**前置闸**——**首次升 known 前 task 2.3 须核确「确为真月付 flat 标准订阅」**（事后无授权回退 → 前置）；末位兜底 = **out-of-band DB break-glass 改正**（运维手工，非授权入口、非常规、留作 recovery-of-last-resort），故非「绝对不可降/不可检测」。
- **计费模型异构（GLM 限流档 vs 国内 credit 额度档）令 cheapest 可能误导** → cheapest 仅表「同档月价最低」，限额行随页呈现供用户判断价值（D2③）；策展优先取可比月订阅（D4）；这是显式 accepted-degraded、非假装可比。
- **币种填错静默拆组**（某 plan 误填异币种 → 分到别组、同档不足 ≥2）→ 页面退化为诚实「数据不足」（fail-safe 非假赢家），但 curator 无显式信号；缓解：task 2.3 录入后**读回断言目标 ≥2 plan 同一币种 + 同为可比月价**。

## 迁移计划

1. curator 核可核实桶2 coding_plan plan **真月付标准订阅价**（仅年/季付者留占位、不÷12 admit；周期不明/无可比月价者留占位）+ 币种（优先跨厂商可比月订阅凑同币种 ≥2）。
2. 经既有 `recordPriceChange` 录入（薄 helper 或 `tsx -e` 一次性调用，不留 CLI 表面）；促销/错周期价不写成 `current_price`。
3. 验某 (coding_plan, currency) 同档 **render 层 ≥2 已核价**（断言组内 `plans.length≥2`，非仅 cheapestPlanId 非 null）→ 比价页转出真实最划算（经既有 5d-A 链）。
4. ROADMAP/tech-plan 同步（5d-C 拆分：策展已交付、egress 启用延后）。
- 回滚：错价经 `recordPriceChange` **改为另一已核标准价**（留史）；无清回 NULL 入口（见风险），故依赖录入前核查。

## 待解问题（退出可达性已实勘去险）

- **退出可达性确认**（web-search + 实勘真页）：GLM(¥49/¥149/¥469)、火山(Lite ¥40/Pro ¥200)、百炼(Pro ¥200)、**讯飞(无忧 ¥19/专业 ¥39/高效 ¥199，登录后页 `maas.xfyun.cn/packageSubscription`)** 均为 **CNY 扁月付 Coding Plan 订阅** → 某 (coding_plan, CNY) 同档**至少 4 厂可比**、退出充分可达（推翻早前「桶2 多为 credit-MaaS 不可比」疑虑——那是 seed 错指 Token/计费页 + `limitType:'credit'` 误导所致）。
- **新增 curation 边界 ①「已停售 plan」**：**腾讯混元 Coding Plan 现已停售**（无在售订阅）。停售 plan **不可留作普通「待核」**（误导用户以为待定价）；honest 处理 = 经 `mr_review_flag` 标「已停售/待复核」+ provenance 记停售，结构性条目宜由 seed 校正移除（若无授权删除路径，标记 + 列 follow-up，本期不硬删）。本期退出不计入停售 plan。
- **新增 curation 边界 ②「登录墙后真页」**：讯飞真订阅页需登录（seed 的 `http` 文档 URL 不对）→ `fetch_strategy` 订为 `manual`（人工登录核），价仍可人工录入；属「可核」非「不可核」。
- **seed 数据校正属本期 curation**：`source_url` → 真 Coding Plan 订阅页、`fetch_strategy`/`limitType` 与实际不符者随核实订正（不改 schema、只订数据）；curator 录**标准月价**（排首月促销 ¥7.9/¥9.9/¥39.9、按季价不 ÷3 录、取真月价）；千帆等仍待勘者留占位、不计入退出。
