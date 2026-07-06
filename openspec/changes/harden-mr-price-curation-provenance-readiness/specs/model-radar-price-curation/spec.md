## 修改需求

### 需求:curation lane 门控、跨镜像配置一致、抓取复用 SSRF+重试、写入口结构收窄

curation proposer 为主镜像 BullMQ lane（日级 cron、无 Playwright），**必须**受 `MR_PRICE_CURATION_ENABLED` 门控。**跨镜像配置一致性**：proposer 与批准接收各自**必须** fail-closed（仿 `isFeishuEnabled`）——但因两镜像可能分开配置（k8s configmap 等），**proposer 除 `MR_PRICE_CURATION_ENABLED` 外还必须校验 `TELEGRAM_APPROVER_IDS` 就绪才注册 lane**（否则"发卡而无人能批"——每侧只查本侧 env 不足以防此，proposer 必须显式确认批准侧的白名单存在）；接收侧（web）缺 `TELEGRAM_APPROVER_IDS` 即不 `bot.start()`。**就绪判定还必须要求 `TELEGRAM_CHAT_ID` 数值化**（`Number.isFinite(Number(TELEGRAM_CHAT_ID))`）：worker 发卡的 `api.sendMessage` 接受 string/`@username`（可达），但接收侧频道绑定**要求数值 chat id**，`Number()→NaN` 时静默不 `bot.start()`，仍"发卡而无人能批"；proposer 与接收侧**必须复用**同一就绪判定（跨镜像一致 fail-closed）。proposer 重抓 `mr_source.source_url`（不可信）的**每次出站**必须经与 scrape **同一 SSRF chokepoint**（白名单+私网封锁+DNS-rebind+重定向重验）并**必须**有重试与错误日志（复用 scrape safeFetch 路径，满足仓库"所有外部 API 调用必须有重试与错误日志"不变量）。抽取器输入**必须**复用 scrape 的价区归一函数（**禁止**另行复制归一逻辑）。多 plan 源（一页多价）本期**必须** escalate（不预填），一键仅覆盖单价源；proposer 目标 `plan_id` 经 `mr_plan_sources` 解析，多 plan 源无法唯一定位时 escalate 到人。**且即便唯一定位到单 plan，proposer 在重抓前必须校验重抓源 `mr_source.source_url` 等于该 plan 注册的 canonical `mr_plans.source_url`**；不等则 **escalate**（不重抓/不抽取/不开卡/不写 `mr_price_history`）并落**可诊断日志**（须区别于 no-candidate/gate-escalate，使永久漂移的暗源可诊断）——因一个 plan 可经 `mr_plan_sources` 关联多源（含非官方聚合源），非 canonical 源抽取的候选**禁止**继承 plan 行的官方 `source_confidence`（否则官方置信度被写进 `mr_price_history` = provenance 造假）。此比较本期用**逐字节相等**、**不做 URL 规范化**（现有源两列已逐字节对齐；规范化会掩盖真实差异）。`src/mr/curation/` 可 import `recordPriceChange`，但 **eslint 必须收窄**：`curation/**` 中**仅** `curation/approve.ts` 允许 import 事实 writer，`propose.ts`/`extract.ts` 等**禁止**（否则"只人批准写事实"退化为散文保证）。检测层（`src/mr/scrape/**`）不变、仍 propose-only。

#### 场景:门控关、缺批准白名单、或 chat id 非数值则不发卡

- **当** `MR_PRICE_CURATION_ENABLED` 关，或（开着但）`TELEGRAM_APPROVER_IDS` 未配，或 `TELEGRAM_CHAT_ID` 非数值（`Number(TELEGRAM_CHAT_ID)` 为 `NaN`/非有限，如 `@username`）
- **那么** proposer fail-closed 不注册 lane（不发无人能批的卡）、接收侧不 `bot.start()`，系统保持既有行为

#### 场景:非 canonical 源的候选不继承 plan 官方置信度

- **当** 一个变更 http 源经 `mr_plan_sources` 唯一定位到某 plan，但该源 `mr_source.source_url` 不等于该 plan 注册的 canonical `mr_plans.source_url`（如非官方聚合源）
- **那么** proposer 在重抓前即 escalate（不重抓、不抽取、不开卡、不写 `mr_price_history`），并落一条可诊断日志——候选绝不带着 plan 的官方 `source_confidence` 落库

#### 场景:proposer 抓取过 SSRF 且有重试日志

- **当** proposer 重抓一个变更 http 源
- **那么** 该出站经 scrape 同一 SSRF chokepoint（私网/非白名单被拒）且失败有重试与错误日志

#### 场景:写入口 eslint 收窄

- **当** `curation/propose.ts` 试图 import `recordPriceChange`/`upsertPlan` 等事实 writer
- **那么** eslint `no-restricted-imports` 拒绝（仅 `curation/approve.ts` 豁免），结构上保证只有人批准路径落库
