## MODIFIED Requirements

### 需求:三档抓取仅做变更检测、检测器原子防 stale-retry、绝不改事实

抓取必须按 `mr_source.fetch_strategy ∈ {http,browser,manual}` 分档：抽价格/额度区域归一文本 → `content_fingerprint` sha256。必须**原子比对 `mr_source.content_fingerprint`，仅真变时**才同事务更新 fingerprint+last_checked + 经 `mr_plan_sources` 定位覆盖 plan 逐个打标；**定位空集合则给 source 自身打 `target_type='source'` flag**（页面变动永不被吞）。无变化只刷 last_checked，不打标。`manual` 不抓。**抓到 blocked-page（200 状态但为登录墙/验证码/人机校验/403 等非真内容页，由 blockedMarkers 识别）必须 fail-closed：不更新 `content_fingerprint`**（仿既有 truncated→skip 幂等重试语义），使基线不被验证码页污染、下轮不因「假内容 vs 真内容」误报「变了」无限刷；**并必须给 source 打 `target_type='source'` flag**（"源被墙、去看"）——否则误判为 blocked 的真价页 / 长期被墙的源会静默退出变更检测（指纹永不更新、无候选、无标）而无人知。**禁止自动改 `mr_*` 价格/限额/兼容/availability/source_url/周期价事实**——结构上 `src/mr/scrape/` 禁止 import 事实 writer（`upsertPlan`/`recordPriceChange`/`setPlanAvailability`/`upsertPlanPeriodPrice`），eslint `no-restricted-imports` 兜底。自动判停售、链接自愈、语义校验抽取均属后续 followup，本期抓取链不得调用任何事实 writer。

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
- **当** 某 http 源返回 200 但内容为登录墙/验证码页（blockedMarkers 命中）
- **那么** 不更新 `content_fingerprint`（保留旧基线）、不因该假内容误报「变了」，且给 `target_type='source'` 打标；下轮抓到真内容才做正常比对

#### 场景:保鲜回路不自动判停售/不自愈链接
- **当** 保鲜回路检测到某 plan 关联源变更
- **那么** 仅按既有红线打 `reviewStatus.pending` 待复核；不自动改 `availability`、不自动改 `source_url`、不 LLM 判停售/判价
