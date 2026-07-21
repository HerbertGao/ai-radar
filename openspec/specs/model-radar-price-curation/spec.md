# model-radar-price-curation 规范

## 目的

待定 - 由变更 add-model-radar-price-curation-approval 创建。归档后请更新目的。

## 需求

### 需求:候选抽取 fail-closed，只在官方源高置信小改时预填一键值

curation 候选抽取器（住在 `src/mr/curation/`）读检测层价区文本，**只丰富待批记录、绝不写任何 `mr_*` 事实**。抽取必须 fail-closed：仅当窗内是**单一金额、带币种标记、带周期单位（月付）、在物理边界内、¥ 块数不较基线漂移、无促销词命中**时才产出候选值；任一不满足必须 escalate（无值）。是否预填一键值由 `gate()` 纯函数按**百分比门**决定，且**必须**同时满足：① 候选源 `source_confidence ∈ {official_pricing, official_doc}`（`source_confidence` **必须由 source 注册表按源信任派生、禁止取自页面内容**——防被篡改页面抬高置信度；非官方源一律 escalate，否则批准必因 `recordPriceChange` 的 confidence↔price 绑定而 `apply_failed`）；② `current_price` 非 NULL **且 > 0**（NULL = 未定基线的占位/登录墙 seed → escalate `FIRST_READ`；0 = 免费档基线，`|Δ|/0` 无意义 → escalate；绝不对 NULL/0 做除法）；③ 同币种；④ `0 < |Δ|/current ≤ 20%`。其余（`pct>20%`、币种变、多金额、促销、块数漂移、锚丢、NULL/0 现价、非官方源）**必须** escalate 无值、强制人手输。**促销检测是尽力启发式**（关键词），故规范**禁止**声称对促销 fail-closed——凡呈折扣形态（低于现价且伴任何促销词/首月/券后）**必须** escalate，人手输为唯一兜底。百分比门即可挡住解析错（如 ¥40→¥4，pct=90%>20% → escalate），无需另设 ratio 分支。

#### 场景:官方源小幅同档变动预填一键值
- **当** 某 http 官方源抽出单一、带币种+月付、在界内的候选价，现价非 NULL、同币种、`|Δ|/current = 9.5%`
- **那么** 开一条带候选值的待批记录并发可一键批准的卡片

#### 场景:疑似解析错的大跳不预填值
- **当** 现价 ¥40、抽出候选 ¥4（pct=90%>20%）
- **那么** escalate 为无值待批（卡片只提示「去看源页」），不预填、不给一键按钮

#### 场景:非官方源或现价 NULL 不预填
- **当** 候选源 `source_confidence` 非 `{official_pricing, official_doc}`，或 `current_price IS NULL`
- **那么** escalate 无值（FIRST_READ / 非官方）——不预填（否则批准必 `apply_failed`）

#### 场景:歧义/促销/登录墙不给数
- **当** 价区出现多个不同金额、或呈折扣形态命中促销词、或抓到登录墙/验证码页
- **那么** 抽取器返回无候选值（escalate），不产出可一键批准的候选

### 需求:mr_price_review 待批记录——令牌即一次性能力、带有效期

`mr_price_review` 行承载「一条冻结的候选事实 + 一次性能力令牌」跨异步间隙。必须：`(plan_id) WHERE status='pending'` **偏唯一索引**保证每 plan 至多一条待批；候选值/币种/`old_value`(开记录时现价快照)/`source_url`/`source_confidence` 在开记录时**冻结在行上**（批准落库必须用行上冻结值，**绝不从批准入站数据取金额/币种/provenance**）；`token` **必须由 CSPRNG `node:crypto` randomBytes(16)（真 128-bit）生成**、`UNIQUE`、单用；`extracted_at` **必须由 DB `now()` 写入**（TTL 比较也用 DB `now()`，单一时钟，防应用时钟偏移改变有效期窗口）；`status ∈ {pending,approved,superseded,apply_failed}`（**不含 `rejected`**——本期不实现拒绝写路径，忽略即不动、由 supersede/staleness 收敛）；写 `mr_price_review`（`openReview`/`supersede`）**必须先过 `mr-schema.zod.ts`**（`status`/`currency`/`source_confidence` 枚举）再发 SQL。

**候选==现价（Δ=0）不开卡**：proposer **必须**在候选值等于 `current_price`（同币种、Δ=0，即指纹变了但价没变——只是同页非价内容变动）时**不开 review、不发卡**（gate 的 `0<|Δ|/current` 已在抽取侧排除 Δ=0，此处再于 propose 侧明确不落 no-value 卡）；该整页复核仍由既有 dispose 面的人处置。**发一次卡 + supersede 二选一由 propose 显式判别、单事务完成**：候选异于现价时，proposer 对某 plan **必须**在一个事务内：锁既有 pending（若有）→ 判定：**未过期且同候选** → no-op（不重复发卡）；**不同候选 或 已过期（`extracted_at ≤ now()-TTL`）** → 置旧行 `superseded` 并插新 pending 行（新 CSPRNG 令牌、新 `extracted_at`）、发新卡。**禁止**用裸 `INSERT … ON CONFLICT DO NOTHING` 当唯一机制（它对「不同的更新候选」也 no-op → 吞掉新价、留下过时一键卡；且**过期同候选**若也 no-op 则该 plan 永远卡在不可批的过期行——偏索引挡住新 pending、令牌已死，价改被静默丢弃）；偏唯一索引仅作并发兜底（防两个 proposer 同插，冲突交 BullMQ 重试）。

**通用 capability token 机制**：本需求范式（CSPRNG token + 单用 + TTL + frozen 字段 + partial unique + 单事务发卡/supersede 二选一 + 非法枚举 Zod 拒）由 `mr_price_review`（价格路径）与 `mr_url_drift_review`（URL drift 路径，见 `model-radar-url-drift-agent` 能力）**两表对称实现**——两表 schema 各自独立、互不污染（`mr_price_review` 的 `plan_id/old_value/candidate_value/currency` 字段语义专属价格路径；`mr_url_drift_review` 的 `source_id/old_url/candidate_url/confidence/reason/flag_opened_at` 字段语义专属 URL drift 路径）；两表的 `url-drift-store.ts` 与 `price-review-store.ts` 纯 store 原语逐字节对称；Telegram callback 路由器按前缀 `mrpr` / `mrud` 分流（见「Telegram 一键批准」需求）。

#### 场景:未过期同候选不重复发卡
- **当** 两轮 cron 对同 plan 抽出**相同**候选、已有**未过期** pending
- **那么** propose 事务内比对判同 → no-op，不重复开记录、不重复发卡

#### 场景:过期同候选 supersede+重发（防卡死）
- **当** 一条 pending 已过期（`extracted_at ≤ now()-TTL`、令牌已不可批），proposer 又抽出**相同**候选
- **那么** 必须置旧行 `superseded`、插新 pending（新令牌/新 `extracted_at`）、发新卡——不因"同候选"而 no-op（否则该 plan 的价改永久卡死）

#### 场景:写 mr_price_review 非法枚举被拒
- **当** `openReview`/`supersede` 试图写非法 `status`/`currency`/`source_confidence`
- **那么** `mr-schema.zod.ts` 校验在发 SQL 前拒绝，不落库

#### 场景:不同的更新候选 supersede 旧待批不被吞
- **当** 已有 pending 候选 ¥45，新一轮抽出**不同**候选 ¥48
- **那么** 同事务置旧行 `superseded`、插入新 pending(¥48) 并发新卡；旧令牌此后 CAS 命中非 pending → no-op

#### 场景:候选值冻结在行上
- **当** 开记录后源页再次变动，随后人批准该记录
- **那么** 落库用记录行上冻结的候选值/币种/provenance，不受批准时源页现状影响

### 需求:Telegram 一键批准——授权、基线校验、结果检查、幂等

批准统一走 **Telegram 长轮询**（`bot.start()` getUpdates，无公开写端点；传输鉴权由 bot-token 认证的 getUpdates 通道提供，**故不设 webhook `secret_token`**；**约束：web 单副本 + 仅 web 镜像调 `bot.start()`**——Telegram 单 getUpdates 消费者，worker 镜像只 `api.sendMessage`；多副本/多消费者会 409 flap，多副本时须改 webhook 传输，见 design。轮询与出站 Bot API 调用**必须有重试/退避与错误日志**，满足仓库"所有外部 API 调用有重试与错误日志"不变量）。

**Callback 路由器按前缀分流**（通用 capability token 机制）：`bot.on('callback_query:data')` 路由器按 `:` 第一段分流——`mrpr:<token>:approve` → 既有 `applyReview`（价格路径）；`mrud:<token>:approve` → 新增 `applyUrlDriftReview`（URL drift 路径，见 `model-radar-url-drift-agent` 能力）；未知前缀 → 答反馈「无法识别的操作」return。两路 money-path red line 逐字同范式：① parse + validate callback_data（三段、token `/^[0-9a-f]{32}$/`、任何偏差答「无法识别的操作」return 不查 DB）；② authorize `callback_query.from.id ∈ TELEGRAM_APPROVER_IDS` **数值化**允许清单鉴权（**非** `chat.id`；缺 `from` 或非清单 → 拒、不写）；③ channel-bind `ctx.chat?.id !== deps.chatId` 拒；④ apply 各自的 `apply*` 函数。

`callback_query` 载荷仅 `mrpr:<token>:approve` 或 `mrud:<token>:approve`（**忽略 `reject`**；`callback_data`/token **必须从日志脱敏**，只记 review `id`/`plan_id` 或 `source_id`）；处理必须：① 认领前**校验 token 定长/字符集**、拒未知 op 与未知前缀（鉴权在任何 DB 往返之前，非白名单直接拒、不打 DB）；② 按 `callback_query.from.id ∈ TELEGRAM_APPROVER_IDS` **数值化**允许清单鉴权（**非** `chat.id`；缺 `from` 或非清单 → 拒、不写）；③ `applyReview` 主事务：CAS `UPDATE … SET status='approved' … WHERE token=? AND status='pending' AND extracted_at > now() - make_interval(hours => <TTL>) RETURNING id`（**有效期**闭合"泄漏令牌长期可用"窗口，`make_interval` 取校验过的正整数 env、**禁止**字面拼接 interval；DB 单时钟比较）→ 0 行(已决/重放/过期)幂等 no-op；非空 → 锁 plan 校验 **`current_price/currency` 必须等于行上冻结的 `old_value/currency`**（不等 = 基线已漂移、ratio-gate 前提失效 → 抛出使主事务回滚、随后独立事务置 `superseded`、不落库，卡片报"价已变，请复核")→ 相等则调 `_recordPriceChangeTx`（同事务，传冻结候选值/provenance）；④ **必须按 `recordPriceChange` 的真实 outcome 判定**——`_recordPriceChangeTx` 返回 `{appended | noop-refreshed | noop-same-tuple | history-conflict}`（**无 `applied` 这个值**）：基线校验（current==冻结 old ∧ 候选≠current）已保证进到写入时是真变更，故**成功唯一可达 outcome 是 `appended`**；`history-conflict` 或任何非 `appended`（未更新 current）结果 = **失败、主动抛出**（`noop-*` 在此路径实际不可达，一并按非成功处理即安全，无需专门放行）。⑤ 成功路径**不触碰 `mr_review_flag`、不刷 child 事实 `last_checked`**——价格事实的 freshness 由 `_recordPriceChangeTx` 既有的 `mr_plans.last_checked` 刷新覆盖（无需 markChecked）；整页指纹 flag 覆盖同页额度/兼容/周期价等本次未策展的事实，故**禁止**因批准单个月价而 `resolveFlag` 塌缩整页复核 flag、也**禁止**用 `markChecked` 顺带刷未复核的 child `last_checked`（那会谎称整页已核、压掉 child 的真陈旧）——该 flag 交人经既有 dispose 面处置，未策展的同页事实由 staleness 兜底重浮现。⑥ 主事务成功**提交后**必须**尽力触发快照失效**（`_recordPriceChangeTx` 只在事务内写、不含 public wrapper 的 after-commit `runSnapshotRebuild`，故 `applyReview` 须自行在提交后发 `publishSnapshotInvalidation`）：此调用**best-effort、不得使已成功的批准转为失败**（仿 public wrapper 视 rebuild 失败为非致命），抛错须记日志；失败则公开页短暂陈旧、由下一次任意失效自愈。⑦ **失败可达且不静默丢失**：主事务对任何失败结果**抛异常回滚**（连 CAS 认领一并回滚 → 行留 `pending`），随后在**独立事务**按 **`WHERE id=<认领返回的 id> AND status='pending'`**（键 `id` 非 plan/status，防并发 proposer 已 supersede 该行后误标新候选；0 行则不动并记日志——失败原因至少落日志）置 `status='apply_failed'`。flag **不 resolve** → 经既有 staleness 重浮现（apply_failed 非 pending，偏索引放行新候选）。基线漂移路径的独立事务同样按 **`WHERE id=? AND status='pending'`** 置 `superseded`（与 apply_failed 对称）。⑧ 对**过期/已决/superseded** 的点按 **必须 `answerCallbackQuery` 给出反馈**（"已过期/已处理，请等新卡"），不静默。money 值/币种/provenance **只从服务端行读**。

#### 场景:伪造/非白名单/未知 op 被拒
- **当** `from.id` 不在 `TELEGRAM_APPROVER_IDS`（或缺 `from`、或 op 非 `approve`、或 token 非法字符集、或前缀非 `mrpr`/`mrud`）
- **那么** 拒绝、不写价、不写 URL

#### 场景:重复点按幂等一次落库
- **当** 同一批准被 Telegram 重投或用户双击
- **那么** CAS 仅第一次认领成功落库一次，其余 0 行→no-op，`mr_price_history` 只追加一条

#### 场景:基线漂移不误批
- **当** 记录冻结 `old_value=¥40`，批准时 plan 现价已变为 ¥50（≠冻结 old）
- **那么** 主事务抛出回滚、独立事务按 `id` 置 `superseded`、不落库，卡片提示价已变请复核（不按过时 ratio-gate 前提写入）

#### 场景:写入未生效不谎报成功
- **当** `recordPriceChange` 返回 `history-conflict`（未更新 current，未抛异常）
- **那么** `applyReview` 视为失败并主动抛出：主事务回滚（不 resolve flag）、独立事务按 `WHERE id=? AND status='pending'` 置 `apply_failed`、行经 staleness 重浮现

#### 场景:成功落库后尽力刷新公开快照、失败不回退批准
- **当** 一次批准成功（outcome `appended`）主事务提交
- **那么** `applyReview` 在提交后触发 `publishSnapshotInvalidation` 使公开页反映新价；若该失效调用抛错（如 Redis 不可达），批准**仍算成功**、仅记日志，公开页短暂陈旧待下次失效自愈

#### 场景:批准价格不塌缩整页复核 flag、不假刷 child 陈旧
- **当** 一次价格批准成功
- **那么** `mr_review_flag` 保持 pending（交人 dispose 整页复核）、未复核的 child 事实 `last_checked` **不被刷新**；proposer 因"候选==现价即不开卡"不再发卡（仅廉价幂等重扫），未策展的同页额度/兼容等由 staleness 兜底重浮现

#### 场景:过期令牌不可批且给反馈
- **当** 一个 pending 记录 `extracted_at` 早于 `now()-<TTL>`，此时点批准
- **那么** CAS 因有效期谓词 0 行 → 幂等 no-op、不落库，且 `answerCallbackQuery` 反馈"已过期，请等新卡"（不静默）

#### 场景:URL drift 前缀 mrud 路由到 applyUrlDriftReview
- **当** callback_data 是 `mrud:<token>:approve`（非 `mrpr` 前缀）
- **那么** 路由器分流到 `applyUrlDriftReview(token, decidedBy)`（见 `model-radar-url-drift-agent` 能力），不调 `applyReview`；两路互不污染、各自 CAS 各自的表；`applyUrlDriftReview` 失败路径（`CrossDomainDriftError` / `SsrfBlockedError` / `StaleUrlError`（`setSourceUrl` old-URL CAS 0 行）/ `mr_source` URL 唯一冲突（`url-conflict`）/ 任何 post-claim 抛错）走 `markUrlDriftApplyFailed(id, decidedBy, dbh)`（**非** `markSuperseded`——URL drift 路径无基线漂移概念，跨域候选是 approve 侧落库失败、与 `applyReview` 的 `ApplyFailedError` 对称）；approve 侧 catch 按错误类型分流仅选反馈文案 + result kind（in-memory、不持久化任何 kind 列，完整 reason 经日志留存不丢 forensics）——`CrossDomainDriftError` 或 `SsrfBlockedError.reason==='host-not-allowlisted'` 归 cross-domain 反馈、`SsrfBlockedError` 其余 reason 走 ssrf 反馈、`StaleUrlError` → `reason:'stale-url'`、URL 唯一冲突 → `reason:'url-conflict'`（详见 `model-radar-url-drift-agent` 能力 spec）

### 需求:飞书仅通知、不承载批准写路径

飞书自定义机器人只出站、无原生回调、卡片按钮为浏览器 GET 文字链——**禁止**让飞书卡片触发任何 money-path 写（GET 会被链接预览/扫描器/预取零人工自动触发，且群内广播无 approver 身份）。飞书卡片**必须**仅作通知：显示 `plan 待复核价改 old→new` + 指向 Telegram 批准（或只读源链接），**不含**任何调用 `applyReview` 的按钮/URL，**且禁止携带 `mr_price_review.token`**（令牌是群频道里的能力、无 HMAC，只允许走 Telegram `callback_data`，绝不进飞书卡片/链接）。批准的唯一入口是 Telegram（本期不建飞书 app-bot 原生回调）。

#### 场景:飞书卡片不写价
- **当** 一条待批候选同时通知到飞书
- **那么** 飞书卡片只展示待复核信息 + 引导去 Telegram 批准，任何飞书侧点击都不触发 `applyReview`/`recordPriceChange`

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
