## MODIFIED Requirements

### 需求:三档抓取仅做变更检测、检测器原子防 stale-retry、绝不改事实

抓取必须按 `mr_source.fetch_strategy ∈ {http,browser,manual}` 分档：抽价格/额度区域归一文本 → `content_fingerprint` sha256。必须**原子比对 `mr_source.content_fingerprint`，仅真变时**才同事务更新 fingerprint+last_checked + 经 `mr_plan_sources` 定位覆盖 plan 逐个打标；**定位空集合则给 source 自身打 `target_type='source'` flag**（页面变动永不被吞）。无变化只刷 last_checked，不打标。`manual` 不抓。**抓到 blocked-page（200 状态但为登录墙/验证码/人机校验/403 等非真内容页，由 `BLOCKED_MARKERS` 识别——`src/mr/scrape/blocked-markers.ts` 导出的常量、`fingerprint.ts:90` 的 `isBlockedPage()` 用 `.some()` 匹配）必须 fail-closed：不更新 `content_fingerprint`**（仿既有 truncated→skip 幂等重试语义），使基线不被验证码页污染、下轮不因「假内容 vs 真内容」误报「变了」无限刷；**并必须给 source 打 `target_type='source'` flag**（"源被墙、去看"）——否则误判为 blocked 的真价页 / 长期被墙的源会静默退出变更检测（指纹永不更新、无候选、无标）而无人知。**禁止自动改 `mr_*` 价格/限额/兼容/availability/source_url/周期价事实**——结构上 `src/mr/scrape/` 禁止 import 事实 writer（`upsertPlan`/`recordPriceChange`/`setPlanAvailability`/`upsertPlanPeriodPrice`/`setSourceUrl`），eslint `no-restricted-imports` 兜底。自动判停售、语义校验抽取均属后续 followup，本期抓取链不得调用任何事实 writer。**例外：browser 档源 URL drift 由独立 agent lane `mr-url-drift` 处理**（见 `model-radar-url-drift-agent` 能力）——agent 不写事实、不改 allowlist、不抓取候选 URL，候选经既有 Telegram HITL gate 批准后由 authorized setter `setSourceUrl`（唯一改 `mr_source.source_url` 的事实入口）改 URL；http/manual 档源 URL drift 仍由人接管，本需求不涉及 agent。

#### 场景:指纹真变只打标不改值
- **当** 某源 fingerprint 较存储值变化
- **那么** 更新 fingerprint/last_checked + 给覆盖 plan 打待复核，`mr_*` 事实值不变

#### 场景:stale 重试 no-op
- **当** 一个旧抓取 job 重试，抓到与已更新 fingerprint 相同的内容
- **那么** 无变化 → 不打标（已 resolve 的 flag 不被旧 job 无条件重开）

#### 场景:定位空集合给 source 打标
- **当** 一个未关联任何 plan 的源指纹变化
- **那么** 给 `target_type='source'` 打标（不静默吞掉页面变动）

#### 场景:manual 源不抓
- **当** `fetch_strategy='manual'` 的源
- **那么** 抓取链不发请求

#### 场景:blocked-page 不污染指纹且打标
- **当** 某 http 源返回 200 但内容为登录墙/验证码页（`BLOCKED_MARKERS` 命中）
- **那么** 不更新 `content_fingerprint`（保留旧基线）、不因该假内容误报「变了」，且给 `target_type='source'` 打标；下轮抓到真内容才做正常比对

#### 场景:保鲜回路不自动判停售/不自愈链接
- **当** 保鲜回路检测到某 plan 关联源变更
- **那么** 仅按既有红线打 `reviewStatus.pending` 待复核；不自动改 `availability`、不自动改 `source_url`、不 LLM 判停售/判价

#### 场景:browser 档 URL drift 由独立 agent lane 处理不抓取链自愈
- **当** browser 档源被 flag `pending`（blocked-page / stale 等 fetch/URL 失效类原因；`changed` 内容变类经 reason-gate 跳过、不触发 agent，见 `model-radar-url-drift-agent` 能力）
- **那么** 下一轮 `mr-url-drift` lane 触发 agent 评估是否 URL drift；抓取链自身不调 agent、不改 `source_url`；agent 候选经 HITL gate 批准后由 `setSourceUrl` 改 URL（见 `model-radar-url-drift-agent` 能力）

## ADDED Requirements

### 需求:mr_source.source_url 的授权写入口 setSourceUrl

`mr_source.source_url` 是事实字段（既有「ingest 区分 identity 与 fact 写，禁止盲覆盖事实」需求覆盖：`upsertSource` 冲突分支对 `source_url` 不同返 conflict + 打 flag、禁 `onConflictDoUpdate` 盲覆盖）。**唯一授权改 `mr_source.source_url` 的入口**是 `src/mr/ingest/set-source-url.ts` 的 `setSourceUrl(sourceId, newUrl, oldUrl, decidedBy, tx, expectedOpenedAt)`——`oldUrl` 是 approve 侧从复核卡冻结的 `old_url`（作 old-URL CAS 守卫），`expectedOpenedAt` 是冻结的 `flag_opened_at`（作 `resolveFlag` 的 generation 守卫），二者防旧 token 覆盖已被更新信号替换的 URL / resolve 掉签发后新打的 flag（TOCTOU，见 design D-M4）；`decidedBy` 是 Telegram `callback_query.from.id` 数值化字符串。

**事务范式（重要）**：`setSourceUrl` 接受**已开事务**（`tx` 参数，由 approve 侧 `dbh.transaction(async tx => { claimUrlDriftReview(token, decidedBy, tx); setSourceUrl(..., tx); })` 同事务内传入——`claimUrlDriftReview` 是 URL drift 路径的 CAS 函数、与价格路径 `claimReview` 命名对称，见 `model-radar-url-drift-agent` 能力 spec + design D2），**不**自开事务——与既有 `setPlanAvailability(dbh, ...)`（定义在 `src/mr/ingest/upsert.ts:416`）自开事务**不同**：因 URL drift approve 需「claim CAS + setSourceUrl（含 mr_source old-URL CAS + mr_plans 对齐 + resolveFlag）」**同事务原子**（任一步失败 → 整事务回滚、claim 不留半态；与 `applyReview` 的「claim CAS + `_recordPriceChangeTx(tx)`」同范式）。

`setSourceUrl` MUST 在传入的 tx 内按序：
① `assertUrlAllowed(newUrl, MR_SOURCE_DOMAIN_ALLOWLIST)`（SSRF chokepoint，失败抛 `SsrfBlockedError(reason)`；调用方按 reason 选**反馈文案 + result kind**（in-memory，**不**持久化任何 kind 列），见「跨域/SSRF URL 被拒」场景 + design D2）；
② **old-URL CAS**：`UPDATE mr_source SET source_url=newUrl, last_checked=now() WHERE id=sourceId AND source_url=oldUrl`——匹配 0 行 = 源 URL 已被更新信号替换（或 source 不存在）→ **`throw new StaleUrlError()`**（同 tx 内抛、回滚整个 claim 事务、**不续做 ③④**，stale token 绝不覆盖已更新的 URL，见 design D-M4）；此 UPDATE 若把 source_url 迁到同 vendor 另一 source 已占的 URL 撞 `mr_source` UNIQUE(vendor_id, source_url) → DB 抛唯一冲突（调用方 catch → `reason:'url-conflict'`）；
③ **mr_plans 同事务对齐（B1-a）**：`UPDATE mr_plans SET source_url=newUrl WHERE source_url=oldUrl AND id IN (SELECT plan_id FROM mr_plan_sources WHERE source_id=sourceId)`——把「以本 source 为 canonical 源」的 plan 的 `source_url` 一并迁到新 URL，维持 `schema.ts:692` 的 `plan.source_url ↔ mr_source.source_url` 对齐契约（否则 `propose.ts:163` 会把已修正的 source 判为非 canonical → 永久 escalate 该 plan）；**只动 `source_url=oldUrl` 的关联 plan**（本 source 曾为其 canonical 源），`plan.source_url≠oldUrl` 的非官方聚合关联不碰；
④ `resolveFlag(tx, {targetType:'source', targetId:sourceId}, {expectedOpenedAt})`（**3-arg：dbh、target、opts**——`expectedOpenedAt` 属 `opts`（`ResolveFlagOptions`），**不可**塞进 target 对象（`ReviewFlagTarget` 无此字段、塞入即被丢、generation 守卫静默失效））——generation 守卫：匹配即 `status='resolved'`、`resolved_at=now()`；0 行 = 卡片签发后新打的 flag generation（`flag.ts:120-122`），容忍不抛，新一代 pending flag 保持交下轮人复核；
⑤ **成功不返回值（void）**（②③④ 全部执行完、无异常）；**失败一律抛**——② old-URL CAS 0 行抛 `StaleUrlError`、② UPDATE 撞 `mr_source` UNIQUE(vendor_id, source_url) 由 DB 抛唯一冲突、① `assertUrlAllowed` 抛 `SsrfBlockedError`，均由调用方 `applyUrlDriftReview` catch 分流（见 `model-radar-url-drift-agent` 能力 + design D2 catch 分流）。**`StaleUrlError` 哨兵类**与 `CrossDomainDriftError` 同在 `src/mr/curation/approve.ts` 顶部定义（仿 sentinel 范式、`approve.ts:51-64`）；旧的「多 outcome 返回」框架**随 throw 语义作废**——setSourceUrl 只在成功时正常返回、失败全抛。

**仅** `src/mr/curation/approve.ts`（curation 区唯一允许 import fact writer 的文件，既有范式）可 import `setSourceUrl`；其它路径（含 agent、propose、telegram-callback、scrape 链）MUST NOT import（ESLint `no-restricted-imports` 兜底——curation 路径既有 `**/ingest/*` ban 已覆盖 `set-source-url.ts`、scrape 路径由本变更 task 4.3 在 scrape block `**/ingest/set-source-url*` 新 pattern 补全——见 task 4.3 + design D9「既有 rule gap 与补全」段）。

**与 `applyReview` 「成功路径不碰 `mr_review_flag`」红线的分歧（重要——已裁决）**：既有 `applyReview` 文件头注释（`approve.ts:13-15`）明确「成功路径不碰 `mr_review_flag`、不刷 child `last_checked`、不 markChecked」——理由是「价格 freshness 已由 `_recordPriceChangeTx` 刷的 `mr_plans.last_checked` 覆盖；整页指纹 flag 交人 dispose、未策展同页事实由 staleness 兜底（markChecked = resolveFlag + 刷全 child，会塌缩整页 flag + 假刷未复核 child，禁用）」。URL drift 路径**故意分歧**——`setSourceUrl` 在同事务内调 `resolveFlag(tx, {targetType:'source', targetId:source_id}, {expectedOpenedAt})`（3-arg：dbh、target、opts；`expectedOpenedAt` 属 opts、不可塞进 target；generation 守卫见 design D-M4），理由：① **flag 语义不同**——价格路径 flag 是 `target_type='plan'`（plan 级、覆盖该 source 页面的多个 plan 之一），URL drift 路径 flag 是 `target_type='source'`（source 级、单 source 单 flag）；价格路径 flag 信号是「某 plan 价变需复核」，URL drift 路径 flag 信号是「source URL 可能失效、需人看」；② **信号消费不同**——价格批准消费的是「plan 价格已落库」，**不**消费「源页面 flag 已处理」（同源其它 plan 仍可能待复核、整页 flag 须留）；URL drift 批准消费的是「source URL 已更新」**直接等价于**消费 source 级 flag 信号（人已看 + 决定 + 改 URL、信号已消费）；③ **不调 `markChecked`**——`markChecked` = `resolveFlag` + 刷全 child `last_checked`，URL drift 路径**仅** `resolveFlag`（单行 UPDATE `mr_review_flag` where `target_id=source_id`）、**不**刷 child `last_checked`（child `mr_plans.last_checked` 由下一轮 browser scrape 用新 URL 抓到真内容后自然刷新、不假刷）；④ **next-scrape 兜底**——新 URL 未经抓取验证，若新 URL 仍 blocked / 内容变 / 长期未核对，下一轮 browser scrape 会再次打 `target_type='source'` flag（`fingerprint.ts:152-160` 既有路径不变）；故 resolve 不丢信号——只是把「人已看」这个信号消费掉。**结论**：URL drift 路径的 `resolveFlag` 是**故意分歧**、非疏漏——与 `applyReview` 红线不矛盾、因 flag 语义 + 信号消费语义不同。

#### 场景:授权 setter 同事务改 source_url + 对齐 mr_plans + resolveFlag
- **当** `setSourceUrl(sourceId, newUrl, oldUrl, decidedBy, tx, expectedOpenedAt)` 被调且 `mr_source.source_url` 仍等于 `oldUrl`（old-URL CAS 命中）
- **那么** 同事务内 `assertUrlAllowed(newUrl)` 通过 → `UPDATE mr_source SET source_url=newUrl, last_checked=now() WHERE id=sourceId AND source_url=oldUrl` → `UPDATE mr_plans` 把 canonical 源为本 source 的 plan（`plan.source_url=oldUrl`）一并迁到 `newUrl` → `resolveFlag(tx, {targetType:'source', targetId:sourceId}, {expectedOpenedAt})`（3-arg） → **成功不返回值（void，失败才抛）**；commit 后 source 不被 staleness 立即重打标

#### 场景:old-URL CAS 匹配 0 行 → 抛 StaleUrlError 不覆盖已更新 URL
- **当** `setSourceUrl` 的 `mr_source` CAS `WHERE id=sourceId AND source_url=oldUrl` 匹配 0 行（源 URL 已被更新信号替换，或 source 不存在）
- **那么** 不改 `source_url`/`mr_plans`/flag，**`throw new StaleUrlError()`** 回滚整个 claim 事务；调用方 `applyUrlDriftReview` catch `StaleUrlError` → `markUrlDriftApplyFailed(id, decidedBy, dbh)`（无 kind 参数）+ 反馈「应用失败」+ result `{kind:'failed', reason:'stale-url'}`（stale token 不覆盖更新的 URL，见 design D-M4）

#### 场景:mr_plans 对齐只迁 canonical 源关联、不碰非官方聚合
- **当** 某 source 迁移 URL，其经 `mr_plan_sources` 关联的 plan 中一部分 `plan.source_url=oldUrl`（本 source 为其 canonical 源）、另一部分 `plan.source_url≠oldUrl`（非官方聚合关联）
- **那么** 同事务只把 `plan.source_url=oldUrl` 的 plan 迁到 `newUrl`（维持 `schema.ts:692` 对齐契约、令 `propose.ts:163` 不把已修正 source 误判为非 canonical → 永久 escalate）；`plan.source_url≠oldUrl` 的关联 plan 不动

#### 场景:expectedOpenedAt generation mismatch → 新一代 flag 保持 pending
- **当** 复核卡签发后 source flag 被新一轮 scrape 重打（`opened_at` generation 超出冻结的 `flag_opened_at`），old-URL CAS 仍命中（`source_url` 未变）而 `resolveFlag(..., expectedOpenedAt)` 匹配 0 行
- **那么** URL 更新照常提交，新一代 pending flag **不被旧复核 resolve 掉**（fail-closed，交下轮人复核；`flag.ts:120-122` 既有 generation 守卫）

#### 场景:跨域/SSRF URL 被 assertUrlAllowed 拒 → reason 选反馈文案、不持久化 kind
- **当** `setSourceUrl` 收到的 `newUrl` 未过 `assertUrlAllowed`（host 不在 `MR_SOURCE_DOMAIN_ALLOWLIST`，或 `scheme-not-allowed` / `url-has-userinfo` / `private-address` 三个 pre-DNS 守卫 reason，`ssrf-guard.ts:128-155`）
- **那么** 抛 `SsrfBlockedError(reason)`、事务回滚、`source_url` 不被改；调用方 `applyUrlDriftReview` 按 reason 选**反馈文案 + result kind**（in-memory，**不**持久化任何 kind 列）——`host-not-allowlisted` → 「候选越界」/`cross-domain-drift` 文案，其余 3 个 reason → 「应用失败」文案——两者均落 `markUrlDriftApplyFailed(id, decidedBy, dbh)`（无第三参 kind）+ 日志记完整 `reason`（forensics 不丢；见 `model-radar-url-drift-agent` 能力 spec + design D2 终态语义分流）

#### 场景:仅 approve.ts 可 import setSourceUrl
- **当** 代码评审发现 `src/mr/scrape/**` / `src/mr/curation/url-drift-propose.ts` / `src/mr/curation/telegram-callback.ts` import `setSourceUrl`
- **那么** ESLint `no-restricted-imports` 拒绝（仅 `src/mr/curation/approve.ts` 允许）
