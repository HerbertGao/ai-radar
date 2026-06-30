## 1. 桶2 真价人工策展（经既有授权改价入口，不抓取直写）

- [x] 1.1 **（人工执行）** curator 核实可核的桶2 coding_plan plan **真月付(month-to-month)标准价** + 币种：**优先跨厂商可比月订阅**（同厂 GLM Lite vs Pro 仅退化下界、非跨厂选型价值）；国内五家 `credit/month` 额度档**只在公布真月付标准订阅价时**才纳入；**仅年/季付者留占位、不换算÷12 admit**（页面无周期列披露承诺差异）、周期不明同样留占位；目标凑齐某 (coding_plan, currency) 同档可比 ≥2
- [x] 1.2 **（人工执行）** 经既有 `recordPriceChange`（`src/mr/ingest/record-price-change.ts`，confidence 必官方 + 金额校验）把可核实**真月付标准价**从 `needs_login_recheck` 占位转已核官方价；**促销/限时/年付价不写成 `current_price`**（不录，spec D2 纪律）；核不到者保留占位（不臆造）
- [x] 1.3 录入工具：用 `tsx -e` 一次性调用 `recordPriceChange`，或一个**薄** helper（仅转调、不绕校验/不新逻辑、不留 CLI 表面，ponytail）；不引入新依赖
- [x] 1.4 **（人工执行）** 全 **7 个** seeded coding_plan plan 逐一三态 triage 记录（最终录入真月价 / 显式占位 + confidence + currency），确保无 plan 漏审——退出 ≥2 不代表全 7 已 triage
- [x] 1.5 **（人工执行）** 录价同时**校正 seed 错指数据**：`source_url` → 真 Coding Plan 订阅页（如 `common-buy.aliyun.com/coding-plan`、百度千帆 coding-plan 页、`volcengine.com/activity/codingplan`、`bigmodel.cn/glm-coding`、`maas.xfyun.cn/packageSubscription`），经 `upsertSource`；`limitType:'credit'`、`fetch_strategy`（如讯飞登录墙真页 → `manual`）与实际不符者随核实订正（**不改 schema、只订数据**）。验证手段：web-search「品牌名 + Coding Plan」+ 实勘真页
- [x] 1.6 **（人工执行）** 已停售 plan（如**腾讯混元 Coding Plan 现已停售**）honest 处理：经 `mr_review_flag` 标「已停售/待复核」+ provenance 记停售，**不留普通「待核」**（避免误导待定价）；结构删除走授权路径（若无则列 follow-up、本期不硬删）；不计入退出 ≥2

## 2. 退出验证（经既有 5d-A 链，无新接线）

- [x] 2.1 **（条件化——仅当 1.x 凑到可比 ≥2 时）** 验该 (coding_plan, currency) 组 **`plans.length≥2`**（**非仅 `cheapestPlanId` 非 null**——后者在 ≥1 即过、不证 ≥2，≥2 闸在 compare-web render 层）+ `comparable=true`；经既有 `runSnapshotRebuild` + 5d-A 跨进程失效反映。若实际无可比 ≥2 → 退出未达、诚实留「数据不足」（见 2.2），不凑数
- [x] 2.2 验比价页该同档从「数据不足/暂不评最划算」转出真实最划算赢家（HTTP/DOM 断言或现有 page 测复用）；**对照** 1 价 setup 仍 render「数据不足」（证 ≥2 闸生效）；未达 ≥2 则诚实留「数据不足」，不凑数
- [x] 2.3 D2 纪律核查（**前置 + 机器/人工分项**）：① **机器可读**：录入后读回断言目标 ≥2 plan **同一币种**（from snapshot，防币种填错静默拆组）；② **人工 eyeball**（无周期列可机器断言）：录入的是**真月付标准价**、非促销/年付；③ **前置闸**：plan 首次升 known 前核确「确为真月付 flat 标准订阅」（事后不可逆、误分类无法降级）

## 3. 文档同步

- [x] 3.1 ROADMAP「5d-C」行拆分：本变更 = 桶2真价人工策展执行（**条件化措辞**：可核到可比 ≥2 同币种 → 页面转真价 / 不达 → 诚实留「数据不足」，不硬编成功结局）；browser egress 生产启用 + 自动抓取**延后**（独立步骤，届时 MODIFY ingestion「Playwright 沙箱锁定」）
- [x] 3.2 `docs/model-radar-tech-plan.md`「5d 决策记录」段：记本拆分（策展与 egress 启用正交、决策 3 快/慢解耦）

## 4. 验证

- [x] 4.1 `openspec-cn validate add-model-radar-bucket2-price-curation --strict` 通过
- [x] 4.2 `npx tsc --noEmit` 0 错 + `npm run lint` 干净（若加薄 helper）
- [x] 4.3 `npx vitest run src/mr/ingest src/mr/snapshot src/mr/web`（改价→快照→页面 反映；既有红线：未核价不入 cheapest / official-only confidence / 金额校验 全绿；真实 pg）
