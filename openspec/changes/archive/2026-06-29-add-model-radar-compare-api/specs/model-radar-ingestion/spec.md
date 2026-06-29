## 新增需求

### 需求:已核价格写入必须带官方 provenance（约束所有生产改价路径）

任何写 `mr_plans.current_price`/`currency` 或追加 `mr_price_history` 的**生产路径**必须满足：写入非 NULL 价格时 `source_confidence` 属已核官方集合 `{official_pricing, official_doc}`；`source_confidence ∈ {needs_login_recheck, official_community, media_report}` 时**禁止携带非 NULL 价格**，必须保持 `current_price=NULL` 且 `currency=NULL`、不写 `mr_price_history`。**覆盖路径必须含 `upsertPlan` 的全部价格写入分支（新建 INSERT + 冲突/改价委托），不只 `recordPriceChange`**——`upsertPlan` 新建分支直写 `current_price/currency/source_confidence` 且当前只过 `mrPlanWriteSchema`（仅校验 price↔currency 同生同灭、不校验 confidence↔price），故 confidence↔price 绑定必须落进**共享 `mrPlanWriteSchema`/`mrPlanWriteValidator`**（在 `upsertPlan` 顶部对 insert 与委托两路都解析），并在 `recordPriceChange`（newValue 恒非 NULL）加 confidence-must-be-official 断言。该约束在发 SQL 前拒绝，不得仅靠 seed 测试守门。与既有 model-radar-catalog「needs_login_recheck 缺值可表达」「current_price/currency 同生同灭」相互印证，本需求在其上叠加 confidence↔price 绑定。

此需求**强化**既有 model-radar-ingestion 的「录入经 Zod 闸」与「单一改价入口」契约：原契约只校验 `source_confidence`/`currency` 枚举取值，本需求进一步绑定「非官方/待复核 confidence ⟹ 价格必 NULL」，使比价读路径的 `priceStatus='known'` 判定有真不变量支撑、未核价无法冒充已核价参与 cheapest。

#### 场景:非官方 confidence 带非 NULL 价被拒（含新建插入）
- **当** 任一生产路径（含 `upsertPlan` 新建 INSERT 分支）尝试写 `current_price=40, currency='CNY', source_confidence='needs_login_recheck'`（或 media_report/official_community）
- **那么** 共享 `mrPlanWriteSchema` 校验在发 SQL 前拒绝，不落库

#### 场景:官方 confidence 才可写真价
- **当** 写 `current_price=40, currency='CNY', source_confidence='official_pricing'`（或 official_doc）
- **那么** 通过校验，经授权改价入口写入并追加 `mr_price_history`

### 需求:seed/录入 fixture 数据卫生

seed 与录入 fixture 必须区分“已核事实”和“占位待复核”。未核实的价格/额度/source_url provenance 必须用 `source_confidence='needs_login_recheck'`、价格事实保持 NULL；禁止把未核实 URL 标成 `official_pricing`/`official_doc`，禁止填臆造价格以便排序。非 5c 主桶（如 MiMo）若 provenance 未核实，必须保持 `fetch_strategy='manual'` + `needs_login_recheck` 占位，或暂缓该条目。

#### 场景:MiMo 未核实 provenance 保持 manual 占位
- **当** MiMo 的官方定价 source_url 尚未核实
- **那么** seed 中该源不得使用 official_pricing/official_doc，不得写入非 NULL 价格；其源保持 manual 或该条目暂缓

#### 场景:needs_login_recheck 与价格 NULL 同生同灭
- **当** seed plan.source_confidence 为 needs_login_recheck 且无已核价格
- **那么** current_price 与 currency 必须同为 NULL，且不写入 mr_price_history

## 修改需求

## 移除需求
