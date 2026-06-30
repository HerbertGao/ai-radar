## 修改需求

### 需求:桶2数据策展只录已核价格、允许零已核价

5c 的桶2 Coding Plan 数据（百炼、千帆、腾讯、火山、讯飞）必须通过结构化录入进入 `mr_*`。每家的**结构性**录入（vendor + coding_plan plan + source + model/client/limit + 各自 provenance）是验收对象；真实价格只有在有已核官方来源时才能通过授权改价入口写入 `current_price/currency` 和 `mr_price_history`。**本期不要求录到任何已核价**——browser 真实勘验为价格核实前置且被列为后续 gate，故本期允许 0 个已核价；无法核实者必须保持 `current_price=NULL`、`currency=NULL`、`source_confidence='needs_login_recheck'`，禁止为凑数填传闻价/占位价。同桶排序测试必须用合成 in-memory 快照 fixture，不得依赖 seed 行有真价。

**5d-C 执行（对本需求的修订）**：5d-C 不再停在「0 已核价」——curator 人工勘验桶2 coding_plan（7 个 seeded plan：GLM Lite/Pro + 百炼/千帆/腾讯/火山/讯飞）的**真实定价页**，把可核实的真价经同一授权改价入口 `recordPriceChange` 录入，使某 (coding_plan, currency) 同档**快照 `plans.length≥2`**（满足 compare-web 既有 `plans.length≥2` 最划算闸前置；页面转出最划算由 compare-web spec 拥有、本变更不新增），经既有 5d-A rebuild + 跨进程失效反映（零新接线）。录入的 `current_price` **必须是同一计费基准的可比真月价**：① **真月付(month-to-month)标准价**（与既有 `maxMonthlyPrice` 月语义一致——DB 无计费周期列、按月比）；**仅年/季付者保留占位、不 admit 进 cheapest**（年÷12 含承诺折扣、与真月付不可直接比、页面无周期列披露承诺差异），周期不明同样留占位；② **标准续费价**——**促销/限时/活动浮动价禁止写成 `current_price` 冒充常态最划算**（不录）。`recordPriceChange` 金额校验只挡畸形、挡不住「促销/错周期冒充」，故①②为**人工核查纪律**（非机器闸）+ per-fact `source_url`/`last_checked` 兜溯源。**cheapest 仅表「同档月价最低」、不表「价值」**——seed 显示计费模型异构（GLM `rolling_5h_requests` 限流档 vs 国内五家 `credit/month` 额度档），各 plan 限额行随页呈现供用户判断价值；策展**优先取可比的跨厂商月订阅**作锚（同厂 GLM Lite vs Pro 为退化下界、非跨厂选型价值）。退出锚为 7 个 plan 中可核到的可比 ≥2，核不到者保留 `needs_login_recheck` 占位——**「允许零已核价」不变**（真全核不到则诚实留「数据不足」，退出未达即如实不达、不凑数）。egress/browser 生产抓取启用与本策展正交、不在本变更（留到真开自动抓取时 MODIFY `model-radar-ingestion`「Playwright 沙箱锁定」即用即验）。

#### 场景:已核价格可参与排序
- **当** 某桶2 plan 通过官方 pricing URL 核实并经授权改价入口写入价格（official_pricing/official_doc）
- **那么** 快照中该 plan 为 `priceStatus='known'`，可参与同桶同币种价格排序，且返回 official provenance

#### 场景:未核价格保持占位且零已核价仍验收通过
- **当** 桶2 某家或全部 plan 没有已核官方价格来源
- **那么** 这些 plan 在数据库和快照中保持价格/currency NULL、source_confidence 为 needs_login_recheck、不写价格历史、不参与 cheapest；结构性录入完成即算验收通过，不因缺价判失败

#### 场景:策展只录真月付标准价、促销/年付/错周期价不写成 current_price
- **当** 某桶2 coding_plan plan 的官方页展示真月付标准价、限时/活动促销价、或仅年/季付价
- **那么** curator 经 `recordPriceChange` 录入的 `current_price` **仅为真月付(month-to-month)标准价**；**促销/限时价、以及仅年/季付者**（年÷12 含承诺折扣、与真月付不可直接比、且页面无周期列披露承诺差异）**一律不写成 `current_price`**（保留占位）；此为人工核查纪律（`recordPriceChange` 挡不住合法但误导值），enforcement 靠 curator 录入前核查 + per-fact `source_url` 溯源、非机器闸

#### 场景:同档 ≥2 已核同币种真月价使快照满足 compare-web 最划算前置
- **当** curator 录入 ≥2 个同 (coding_plan, currency) 的桶2 plan 真月付标准价，使该组 `plans.length≥2`
- **那么** 经既有 5d-A rebuild + 跨进程失效，**快照**该组 `plans.length≥2` + `cheapestPlanId` 非 null + `comparable=true`，满足 **compare-web 既有 `plans.length≥2` 最划算闸**的前置数据条件（页面 render 行为由 compare-web spec 拥有、本变更不新增）；故退出验证须断言**快照组 `plans.length≥2`**（非仅 `cheapestPlanId` 非 null——后者 ≥1 即过、不证 ≥2），页面转出由 compare-web 既有测覆盖

#### 场景:已停售 plan 不留作普通待核
- **当** 某桶2 coding_plan plan 经核实其产品**已停售**（如腾讯混元 Coding Plan 无在售订阅）
- **那么** 该 plan 经 `mr_review_flag` 标「已停售/待复核」+ provenance 记停售、**不计入 cheapest**，且**不得留作普通 `needs_login_recheck` 待核**（待核暗示「待定价」会误导用户）；结构删除走授权路径、无则列 follow-up（本期不硬删）
