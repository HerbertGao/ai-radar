## 上下文

ai-radar 产品发现链路（P2）：Product Hunt 采集器（`source='product_hunt'`、`rawType='product'`）→ 确定性产品塌缩（`product-collapse.ts`）→ `ai_products` → 产品日报（`product-digest`）。QA §7.3 把 Show HN 列为关键产品发现源，本期补上。

实测/复核（2026-06-14）：
- **HN Algolia 可行**：`search_by_date?tags=show_hn`，无鉴权、200、限流约 1 万 req/h。`numericFilters=created_at_i>{ts},points>={n}`（逗号=AND）：近 3 天 333 条；`points>=10`→14 条。字段：`objectID`/`title`/`url`/`created_at_i`(**秒**)/`points`。
- **现有 Firebase HN collector**：`hacker-news.ts:67-74` `source='hacker_news'`/`String(item.id)`/`rawType='post'`；`toDate`(:60-62) 即 `new Date(seconds*1000)`。
- **store.ts**：`onConflictDoNothing({target:[source, sourceItemId]})`（:131-133）。
- **product-collapse**：`collapseUncollapsedProductRawItems` 按 `rawType='product' AND collapsed=false` 选取（:346，source-agnostic）；`extractProductMergeKeys`（:103-120）`website=meta.website??item.url`、`canonicalDomain=meta.canonical_domain??extractCanonicalDomain(url)`、`githubRepo=normalizeGithubRepo(website)??meta.github_repo`。`extractCanonicalDomain`（product-hunt.ts:229-238）= `new URL(url).host`（去 www）——**github URL → `github.com`**。
- **编排**：`runDailyWorkflow` = `collectAndStore`(registry 全集) + `collapseUncollapsedRawItems`(**仅新闻**塌缩，排除 product)；`runProductDigest` = 硬编码 `collectProductHunt`(product-digest.ts:342) + `collapseUncollapsedProductRawItems`(:347)。**产品塌缩只在 product-digest 链发生**。
- **选品**：`product-digest.ts:132` `orderBy lastSeenAt DESC`，:140 `representativeTitle:r.name`（用 `ai_products.name`，不用 `representative_raw_item_id`）；**产品链不消费 `published_at`**。
- **事件塌缩排除 product**：`dedup/collapse.ts:221` `rawType IS DISTINCT FROM 'product'`。

约束：确定性塌缩 + DB 唯一约束保产品合并/幂等，不交 LLM；采集期不做语义判断。

## 目标 / 非目标

**目标：** 把 Show HN 经 product-digest 链以 `rawType='product'` 接入既有产品塌缩；采集期用确定性闸（时间窗 + points）控质控量；修掉 github.com 撞域使 github 产品按精确键合并。
**非目标：** 不改 `ai_products` schema/富化列；不重构塌缩算法（仅 F1 一处必要修复）；不动 Firebase topstories collector；不做 LLM 语义预筛；不接 Reddit。

## 决策

### D1：Algolia `search_by_date` + numericFilters（时间窗 + points）
按时间倒序 + `numericFilters=created_at_i>{近 N 天下界},points>={SHOW_HN_MIN_POINTS}`，确定性。**替代**：`/search`（相关度）— 否决（排序不确定）；Firebase `topstories` — 否决（只覆盖前台前 30、无 `tags=show_hn`）。

### D2：独立 `source='show_hn'`（正面选择，非仅避碰撞）
- **为何不复用同一命名空间**：`store.ts:131` `ON CONFLICT (source, source_item_id) DO NOTHING`；Show HN（rawType=product）与 Firebase（rawType=post）若共用 `('hacker_news', HN-id)` 会先插入者胜——前台高赞 Show HN 被当 post 埋没进新闻流、永不进产品塌缩，且路由随采集顺序非确定。
- **为何答案是新 source 枚举值、而非 `hacker_news` + `source_item_id` 加前缀**：（a）`source` 是 registry **编排键**——独立 `show_hn` 才能精确进 `PRODUCT_SOURCES` 产品子集（见 D6）、不进新闻/告警子集；前缀命名空间虽也避碰撞，但 source 仍是 `hacker_news` 则无法在编排层把它归为产品源。（b）`item.source` 写入 `ai_products`/可观测时，`show_hn` 比 `hacker_news` **更诚实标明这是产品流来源**。故独立 source 是编排维度区分 + 溯源诚实的正面选择，避碰撞是附带好处。
- **同一热帖双重存在**：前台高赞 Show HN 可同时是新闻 `post`（hacker_news，进事件流）与产品（show_hn，进产品塌缩）；两源 `(source,source_item_id)` 不碰撞、各被一条管线消费（事件塌缩排除 product、产品塌缩只收 product），无双计；语义上「热门发布既是新闻又是产品」成立。

### D3：`rawType='product'` 路由 + `publishedAt` 正确单位 + 三键全空跳过
- 发射 `rawType='product'` → 经 dedup-and-normalization 排除出事件塌缩、由 product-collapse 独占消费。
- **`publishedAt = created_at_i 为正数则 new Date(created_at_i*1000) 否则 null`**（`created_at_i` 是秒；秒→毫秒转换同 `hacker-news.ts` toDate，但**比其更严**——toDate 只挡 NaN、不挡 0/负，本采集器额外加 `>0` 守卫）。**须显式判 `>0`**：`created_at_i` 缺失/非数/0/负数 → `publishedAt=null`——`new Date(0)`=1970-01-01 是合法 `Date`、不被 NaN 守卫挡，会落 1970。**禁止**写成裸 `created_at_i`（秒数字）或 `created_at_i*1000`（毫秒数字）——`CollectedItem.publishedAt` 是 `Date|null`（types.ts:48），裸 number 类型不符且落库即错。
- **title 剥前缀**：剥除 `Show HN` 后接 `:`/`-`/`–`/`—` 及空白的前缀（**大小写不敏感**，覆盖 `Show HN:` / `Show HN -` / `Show HN –` / `Show HN —`）；剥后为空串则回退原始 title（`CollectedItem.title` NOT NULL，绝不留空）。
- **跳过判据 = 复用纯模块 `product-keys.ts` 的 `extractProductMergeKeys`（见 D7）得三键全空即跳**（单一口径，避免采集器判定与塌缩提键口径漂移）：采集器以最小入参 `{url, metadata}`（`ProductKeyInput`，无需伪造 `id`）调 `extractProductMergeKeys`，若 `canonical_domain`/`github_repo`/`product_hunt_slug` **全为 null** 则记日志跳过、不发射。这天然覆盖：`url` null/空串/缺字段、非 http(s)（`mailto:`/相对/`ftp:`）、**以及 `github.com/owner` 这类无具体 repo 的 org/profile 页**（`normalizeGithubRepo` 要求 ≥2 段路径，org 页 github_repo=null；配合 D5 无条件抑制 github.com 域后 canonical_domain 亦 null → 三键全空 → 跳过）。不降级进新闻流。

### D4：`points` 作采集期确定性质量闸
- `points>=SHOW_HN_MIN_POINTS`（默认 10）是 HN 众投热度信号、**非内容语义判断**——与 github collector 同属确定性群体信号过滤，合规（语义价值判断仍交下游）。
- **与 github 的精确区别**：github 是「按 star 倒序取前 N」（**相对排序**，恒取得到 N 条）；points 是**绝对阈值过滤**（某日可能 0 条达标 → 返回空）。Show HN 返回空是**预期**、不触发任何告警——产品源不计入日报「新闻真空」判定（`run-daily-workflow.ts` 的 newsProcessableCount 只数新闻类）。

### D5：一处必要塌缩修复（github.com 域**无条件**抑制），其余零改动
- **F1 修复**：`extractProductMergeKeys` 令 `canonicalDomain === 'github.com'` 时**无条件**置 null（不 gate 在 `githubRepo` 非空上）。`github.com` 永远不是有意义的产品域——指向具体 repo 的产品用 `github_repo` 作精确键；指向 `github.com/owner` org/profile 页的「产品」无具体 repo（`github_repo` 也为 null）→ 三键全空、由采集器跳过（见 D3），不应靠 `github.com` 域合并。**为何不能只在 `githubRepo` 非空时抑制**：org 页（`github.com/owner`，单段路径）`github_repo=null`，若仅条件抑制则它们仍共享 `canonical_domain='github.com'` 彼此静默合并（CR/RC 查出的残留撞域）。无条件抑制 + 采集器三键全空跳过，彻底闭合。
- **为何这是真问题**：否则所有 github 托管产品（Show HN 大量直链）共享 `canonical_domain='github.com'` → `lockMatchingProductIds` OR 命中 size=1 → **静默 UPDATE 把它们塌进同一行**（非 merge_conflict，更隐蔽，灾难性）。修复对 Product Hunt 同样正确（PH 的 github 托管产品 `metadata.canonical_domain` 亦为 `github.com`，一并被抑制 → 改用 `github_repo` 合并；消除既有同类隐患）。
- 除此之外塌缩**零改动**：选取仍 source-agnostic（:346）、键提取仍回退 `item.url`、merge_conflict 分流不变。
- **替代**：让 Show HN collector 自己不产 `github.com` 域 — 否决（`extractProductMergeKeys` 的 `meta.canonical_domain ?? extractCanonicalDomain(url)` 无法从 collector 侧抑制，且 PH 同隐患需在塌缩层统一修）。仅条件抑制（gate on githubRepo）— 否决（残留 org 页撞域，见上）。

### D6：经 `PRODUCT_SOURCES` 子集由 product-digest 链采集（修链路闭合）
- 新增 `PRODUCT_SOURCES = {product_hunt, show_hn}`（与 `REALTIME_NEWS_SOURCES` 对称）；`runProductDigest` 采集阶段由硬编码 `collectProductHunt(options.collect)` 改为 `collectSources(PRODUCT_SOURCES, options.collectOptions)`。这样 Show HN 与 PH **在同一条产品链被采集 → 紧接同链 `collapseUncollapsedProductRawItems` 塌缩**，链路显式闭合。
- **注入签名改造（钉死，防类型断层）**：`collectSources` 第二参是 `CollectAllOptions`（PH 选项须在 `options.productHunt`、Show HN 选项在 `options.showHn`），与现 `RunProductDigestOptions.collect?: ProductHuntCollectorOptions`（单源）**类型不兼容**。故 MUST：① 把 `RunProductDigestOptions.collect?: ProductHuntCollectorOptions` 改为 `collectOptions?: CollectAllOptions`；② 采集改 `collectSources(PRODUCT_SOURCES, options.collectOptions)` 并解包 `collected.items`；③ 测试桩经 `collectOptions: { productHunt: { fetchGraphql }, showHn: { fetchJson } }` 注入（**product-digest 现有测试用 `skipCollectAndCollapse` 不注入采集，无既有注入位可迁移；5.4 e2e 是首个 `collectOptions` 注入者**）。禁止把旧 `ProductHuntCollectorOptions` 直接当 `CollectAllOptions` 传（PH 选项会落顶层、被 `buildRegistry` 读 `options.productHunt`=undefined 而静默丢失注入 + 类型不符）；**勿改 run-daily-workflow / alert-scan 测试的 `collect:`（异类型、不在范围）**。
- **维护对称性护栏（前向脆弱）**：`PRODUCT_SOURCES` 与 `REALTIME_NEWS_SOURCES` 均为手工维护的 `CollectorSource[]` 字面量，与 `buildRegistry` 源全集独立。未来新增源（如非目标里预告的 Reddit）易忘记归属哪个子集而被静默排除出产品/告警链。本期在两子集常量旁交叉引用 + 注释「有意不归属任一子集的源（如 arXiv 仅日报全集沉淀）」；是否加「每个 registry source 必属某子集或显式白名单」的覆盖性断言列为 Open Question。
- **为何不靠 collectAllSources（日报链）**：日报链 `collectAndStore` 后只跑**新闻**塌缩（无产品塌缩），若把 Show HN 塞进日报全集，则只能靠「日报链入库 → product-digest 事后全库扫捡漏」的**跨 workflow 隐式时序**勉强闭合（描述与代码不符、脆弱：单跑某一 workflow 即断）。经 PRODUCT_SOURCES 由 product-digest 采集是干净的产品链内闭环。
- `show_hn` **不入 `REALTIME_NEWS_SOURCES`**：实时告警消费 `ai_news_events`，product 不进事件塌缩 → 天然不进告警评分链。**真正的告警隔离闸是 `raw_type='product'` 路由**（`collapse.ts:221`），`show_hn` 不在告警子集只是省去无谓采集、非隔离必要条件。

### D7：抽纯模块 `product-keys.ts` 承载产品归一键提取（修层次倒置）
- 采集器要复用 `extractProductMergeKeys` 作跳过判据（D3 单一口径）。但它现在 `product-collapse.ts` 内，而该文件顶层 `import { db } from '../db/index.js'`（`db/index.ts:17` 顶层 `new Pool(...)`——**import 即开 PG 连接池**）。现有全部采集器（rss/hacker-news/github/arxiv/product-hunt）**刻意零 `../db` 依赖**；若 `show-hn.ts` import `product-collapse.ts` 会让纯 HTTP 采集器**传递性实例化 DB 连接池**（层次倒置 + import side-effect 污染单测/无库环境）。
- **决策**：新建**叶子纯函数模块** `src/collectors/product-keys.ts`，承载 `extractProductMergeKeys` + `normalizeGithubRepo` + `asString` + **`extractCanonicalDomain`（一并迁入）** + 类型 `ProductMergeKeys` + **最小入参接口 `ProductKeyInput { url?: string|null; metadata?: Record<string,unknown>|null }`**（`extractProductMergeKeys(input: ProductKeyInput)` 只读它真用到的 `url`/`metadata`，**不再要求 `id`/`title`**——消除采集器伪造 `id:0n` 的异味）。**该模块仅 import `normalizeUrl`（dedup/normalize，本身仅依赖 crypto/emoji-regex/opencc）——传递闭包零 `../db`、零 `../config/env`**：故采集器 import 它既不开 PG 连接池、也不触发 `env.ts:297` parseEnv 启动校验 side-effect（避免「采集器 import → 实例化连接池 / 强制 env 校验」双重污染）。`extractCanonicalDomain` **从 product-hunt.ts 迁入** product-keys.ts、**product-hunt.ts 反向从 product-keys import 它**（product-hunt 本就用它、不形成环，因 product-keys 不 import product-hunt）。`product-collapse.ts` 改为从 `product-keys.ts` import `extractProductMergeKeys`/`ProductMergeKeys`（其 `ProductRawItem` 结构兼容 `ProductKeyInput`，不再本地声明这些符号）；`show-hn.ts` 同样 import，传 `{url, metadata}`。F1 修复落在 `product-keys.ts` 的 `extractProductMergeKeys` 内。
- **替代**：① 采集器传 dummy `id:0n` 直用 product-collapse 的函数 — 否决（仍传递拉入 DB 池 + 伪造字段异味）；② 把 `extractCanonicalDomain` 留在 product-hunt.ts、product-keys 从那 import — 否决（product-hunt 顶层 import `env` + `push-date`→`env`，会让 product-keys 传递耦合 `env.ts:297` 启动校验，破坏「叶子纯」目标，徒增单测 env-stub 依赖）。

## 风险 / 权衡

- **[github.com 撞域，含 org/profile 页残留]** → D5 修复（**无条件**抑制 canonical_domain=github.com）+ D3 采集器三键全空跳过（org 页 `github.com/owner` 无 repo → 跳过）。修复后指向具体 repo 的 github 产品按各自 `github_repo` 键独立、不误并；与 PH 同 repo 产品按 `github_repo` 正确跨源合并；org/profile 页不入库。tasks 5.3 加回归断言（含一例 `source='product_hunt'` 的 github 产品，背书「F1 对 PH 同样正确」）。
- **[跨源合并后 `representative_raw_item_id` last-writer + `name` 取先到源]** → 已核实 product-digest 展示用 `ai_products.name`（:140），**不依赖** `representative_raw_item_id`，故回指 last-writer 不影响展示。但 `name` 仅 INSERT 时设（`resolveName`，UPDATE 不更新）→ 跨源 name = 先到源标题。Show HN collector **剥除 `Show HN:` 前缀**后再作 title，避免先到为 Show HN 时 name 带帖式前缀。富化（统一 name 口径）留 P5。
- **[产品塌缩入口未来被改成按 source 过滤会静默断掉 Show HN]** → spec 写 MUST source-agnostic；tasks 5.3① 加**回归断言**：`source='show_hn'` 的 product 经真实入口 `collapseUncollapsedProductRawItems` 必须入 ai_products（任何把入口收窄到单 source 的改动即让该断言失败）。
- **[链路闭合无端到端测试]** → 除塌缩层回归断言（5.3，直插 raw_item）外，tasks 加 **e2e 测试**：以注入的 PH+Show HN fetch 桩驱动 `runProductDigest`，断言 Show HN 产品经 `collectSources(PRODUCT_SOURCES)→store→collapse` 全链入 `ai_products`——覆盖 F2 注入改造正确性与「Show HN 真被产品子集采集入库」（否则 5.3 绕过采集层、链路闭合声称无测试兜底）。
- **[numericFilters 编码]** → 运算符 `>`/`>=` MUST 编码（裸 `>` 致 400）；逗号 AND 分隔符**字面或 `%2C` 均可**（实测 Algolia 服务端解码 `%2C` 回逗号、AND 仍生效），故 `URLSearchParams` 可直接用。tasks 单测断言「numericFilters 含 created_at_i 下界 + points 阈值两条件且 AND 生效」（不强求逗号字面，避免逼实现手工拼串）。
- **[points 绝对阈值某日返回空]** → 预期，产品源空集不进新闻真空告警；单源失败/空由 allSettled 隔离。
- **[Algolia 外部依赖 / 字段变更前向脆弱]** → 单源失败 allSettled 隔离；tasks 固化一份真实 Algolia 响应为 fixture，使字段名（objectID/created_at_i/points）声称可复现验证、未来字段漂移被测试捕获。
- **[Lobsters/噪音类比]** → points + 时间窗滤掉绝大多数；下游 product-digest 选题再筛。

## 迁移计划

含代码，无 schema 迁移。步骤：
1. 前提复验（tasks 1.x）：product-collapse source-agnostic + url 回退、hacker-news source/rawType、product-digest 采集硬编码点、extractCanonicalDomain 对 github 返回 github.com——确认 F1/F2 前提仍成立。
2. `CollectorSource += 'show_hn'`；新增 `show-hn.ts`（Algolia 采集器，注入 fetchJson 桩；剥前缀；publishedAt=new Date(*1000)；三键全空跳过）。
3. 抽纯模块 `src/collectors/product-keys.ts`（零 `../db`）承载 `extractProductMergeKeys`（最小入参 `ProductKeyInput`）+ helpers；`product-collapse.ts` 改从它 import；**F1 无条件抑制 canonical_domain=github.com → null 落在此模块内**。`show-hn.ts`（步骤 2）从此模块 import 作跳过判据。
4. `buildRegistry` 加 show_hn 项 + 导出；`PerSourceOptions`/`CollectAllOptions.collectors` **具名键** 加 `showHn?: (opts?: ShowHnCollectorOptions)=>Promise<CollectedItem[]>`（否则 `(opts?: never)` 基底致注入桩不可调）；新增 `PRODUCT_SOURCES`；**改 `RunProductDigestOptions.collect: ProductHuntCollectorOptions` → `collectOptions?: CollectAllOptions`**；`runProductDigest` 采集改 `collectSources(PRODUCT_SOURCES, options.collectOptions)`，并把 `collected` 解包 `.items`（`collectedCount`/guard/`storeCollectedItems` 入参取 `collected.items`），更新 `collectedCount` doc-comment（PH → PH+Show HN）。**注意：product-digest 现有测试用 `skipCollectAndCollapse` 不注入 `collect`，无既有注入位可迁移；5.4 e2e 是首个经 `collectOptions` 注入者。勿改 run-daily-workflow / alert-scan 测试的 `collect:`（那是 `CollectAllOptions` 类型、与本次无关）。**
5. `.env.example`+`.env` 加 `SHOW_HN_MIN_POINTS`/`SHOW_HN_MAX_PER_RUN`；env schema 校验。
6. 测试：采集器单测（映射/剥前缀/publishedAt Date/三键全空跳过含 null·空串·缺字段·非 http url/numericFilters 含 points/单源失败）；塌缩集成测试（源-agnostic 回归断言 show_hn 入库、PH↔ShowHN 同 github_repo 跨源合并单行、两个不同 github_repo 产品不因 github.com 误并、缺 slug 不破坏）；用固化 Algolia fixture 验字段名。
7. 远端 ts.mac-mini：本地 build→save→ssh load（GHCR 受阻，部署 memory）→ up -d；同步 `.env` 两项；printenv 确认。
8. `/opsx:sync`（含 product-discovery 的 F1 修复需求）+ `/opsx:archive`（归档纯文档直推 main；实现代码走 PR）。

**回滚**：registry 移除 show_hn 项 + product-digest 采集还原 + 还原 env + revert F1；已入库 show_hn raw_items/products 独立 source、不影响既有源。

## 待解决问题

- **SHOW_HN_MIN_POINTS / MAX_PER_RUN 默认值**：10 / 30 是实测拍的保守值（近 3 天 points≥10=14，30 有裕量）；上线据 ai_products 质量/数量调。
- **单轮按时间倒序取前 MAX_PER_RUN 会否漏窗内早发高赞帖**：会，但下轮窗口仍含它（created_at_i 仍 > 下界）可补采，低风险自愈；量不足再议是否翻页。
- **Show HN 与 PH 是否单列产品板块**：本期混入既有 product-digest（同 ai_products、同选题），不单列；观察后再定。
- **F1 修复是否应拆为独立 PR**：它是 Show HN 接入的前置必要修复，本提案内一并做；若上线前发现 PH 已有 github.com 误并历史数据，需另跑一次数据修复（本期不含）。
