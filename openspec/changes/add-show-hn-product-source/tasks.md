## 1. 前提复验（实现前钉死，防代码漂移）

- [x] 1.1 复验 `src/collectors/product-collapse.ts`：`collapseUncollapsedProductRawItems` 仍按 `raw_type='product' AND collapsed=false` 选取（source-agnostic，:346）；`extractProductMergeKeys` 的 `website=metadata.website??item.url`、`githubRepo=normalizeGithubRepo(website)`（回退 item.url）。漂移则停下报告
- [x] 1.2 复验 `extractCanonicalDomain`（`src/collectors/product-hunt.ts`）对 github URL 返回 `github.com`（确认 F1 撞域前提）；复验 `lockMatchingProductIds` 为 `canonical_domain OR github_repo OR product_hunt_slug` 命中（确认误并机理）
- [x] 1.3 复验 `src/pipeline/product-digest.ts` 采集阶段当前硬编码 `collectProductHunt`（:342）、塌缩 `collapseUncollapsedProductRawItems`（:347）、选品 `orderBy lastSeenAt DESC`（:132）、展示 `representativeTitle:r.name`（:140，用 ai_products.name 不用 representative_raw_item_id）
- [x] 1.4 复验 `src/collectors/hacker-news.ts` 仍 `source='hacker_news'`+`String(item.id)`+`rawType='post'`，`toDate=new Date(seconds*1000)`；`src/dedup/collapse.ts` 事件塌缩 `IS DISTINCT FROM 'product'`

## 2. 抽纯键模块 + F1 修复（blocker，先于采集器以免误并 / 防 DB 池倒置）

- [x] 2.1 新建**叶子纯模块** `src/collectors/product-keys.ts`（**传递闭包零 `../db` 零 `../config/env`**）：把 `extractProductMergeKeys` + `normalizeGithubRepo` + `asString` + 类型 `ProductMergeKeys` 从 `product-collapse.ts` 迁入，并把 `extractCanonicalDomain` 从 `product-hunt.ts` **迁入**；**入参收窄为 `ProductKeyInput { url?: string|null; metadata?: Record<string,unknown>|null }`**（只读 url/metadata，不要 `id`/`title`）；仅 import `normalizeUrl`（dedup/normalize）。改动连锁：① `product-collapse.ts` 从 `product-keys.ts` **import** `extractProductMergeKeys` + `ProductMergeKeys`（不再本地声明这些符号、不重声明类型）；② `product-hunt.ts` 改从 `product-keys.ts` import `extractCanonicalDomain`（反向，无环——product-keys 不 import product-hunt）；③ **迁移既有测试** `src/collectors/__tests__/product-hunt.test.ts` 的**全部三个**移动符号引用：现从 `product-collapse.js`（`collapseMod`）读 `normalizeGithubRepo`/`extractProductMergeKeys`、从 `product-hunt.js`（`phMod`）读 `extractCanonicalDomain`，**三者一律改为从 `product-keys.js` import**（迁出后 `phMod.extractCanonicalDomain` 会变 undefined，`product-hunt.ts` 只是内部 import 它、**不 re-export**，故测试必须改引用来源）；④ **删除测试调用 `extractProductMergeKeys({...})` 处字面量的 `id`/`title` 多余字段**（入参收窄为 `ProductKeyInput{url?,metadata?}`，strict + `exactOptionalPropertyTypes` 下传 `id`/`title` 触发 excess-property 编译错）。验收：`grep` 确认 `product-collapse.ts` 不再声明 `ProductMergeKeys`/`asString`/`normalizeGithubRepo`/`extractCanonicalDomain`、`product-hunt.test.ts` 不再经 `collapseMod`/`phMod` 读这三符号；`tsc` 通过 + `product-hunt.test.ts` 与全套测试绿。
- [x] 2.2 在 `product-keys.ts` 的 `extractProductMergeKeys` 内做 **F1 无条件抑制**：算出 `canonicalDomain` 后 `if (canonicalDomain === 'github.com') canonicalDomain = null;`（**不** gate 在 githubRepo；抑制任何来源含 url 推导与 `meta.canonical_domain` 显式值）。验证 `product-collapse` 既有产品塌缩行为除 github.com 抑制外不变

## 3. 采集器与枚举 / 注册 / 产品源子集

- [x] 3.1 `src/collectors/types.ts`：`CollectorSource` 新增 `'show_hn'`
- [x] 3.2 新增 `src/collectors/show-hn.ts`：`collectShowHn(options)` —— 调 Algolia `search_by_date`，拼 `tags=show_hn` + `numericFilters=created_at_i>{近 N 天下界},points>={minPoints}`（**points 须在 numericFilters 串内、非客户端过滤**；运算符 `>` 须编码；逗号 AND 分隔符字面或 `%2C` 均可——可用 `URLSearchParams`）+ `hitsPerPage`(=SHOW_HN_MAX_PER_RUN，本期不翻页)；映射每条：`source='show_hn'`、`sourceItemId=String(objectID)`、`url`、`title`=剥除 `Show HN` 前缀（后接 `:`/`-`/`–`/`—`+空白，大小写不敏感；剥后空则回退原 title）后的名、`publishedAt`=（`created_at_i` 为**正数**则 `new Date(created_at_i*1000)` 否则 `null`——0/负/缺失/非数均 null）、`rawType='product'`、`metadata={points,num_comments,author,hn_object_id}`；**跳过判据 = 从纯模块 `product-keys.ts` import `extractProductMergeKeys`、以 `{url, metadata}`（`ProductKeyInput`，无需伪造 id）调用、三归一键全空即记日志跳过不发射**（覆盖 url 空/非 http、及 `github.com/owner` 无 repo 的 org 页；勿 import `product-collapse.ts` 以免传递拉入 DB 连接池）；注入 `fetchJson`（默认 global fetch + 超时）；`withRetry` + 错误日志，整源失败抛出由编排层隔离
- [x] 3.3 `src/collectors/index.ts`：`buildRegistry` 加 `{source:'show_hn', collect:()=>(c.showHn??collectShowHn)(options.showHn)}`；导出 `collectShowHn`；`PerSourceOptions.showHn?: ShowHnCollectorOptions`；**`CollectAllOptions.collectors` 的具名键加 `showHn?: (opts?: ShowHnCollectorOptions)=>Promise<CollectedItem[]>`**（必须具名，否则落到 `(opts?: never)` 基底致注入桩不可调用）；新增 `export const PRODUCT_SOURCES: readonly CollectorSource[] = ['product_hunt','show_hn']`；**确认 `show_hn` 未加入 `REALTIME_NEWS_SOURCES`**；在两子集常量旁补注释交叉引用彼此 + 注明「有意不归属任一子集的源（如 arXiv 仅日报全集沉淀）」（维护对称性、防未来新增源静默漏归属）；更新 index.ts 头部 doc-comment 的「全集 vs 实时子集」二分叙事为含产品子集的三视图
- [x] 3.4 `src/pipeline/product-digest.ts`：**注入位类型改造（钉死，防类型断层）**——把 `RunProductDigestOptions.collect?: ProductHuntCollectorOptions` 改为 `collectOptions?: CollectAllOptions`；采集阶段 `collectProductHunt(options.collect ?? {})` 改为 `collectSources(PRODUCT_SOURCES, options.collectOptions)`，使 PH + Show HN 同链采集→紧接 `collapseUncollapsedProductRawItems` 塌缩。**`collected` 返回形状从 `CollectedItem[]` 变 `CollectAllResult`：把 `collectedCount`/空 guard/`storeCollectedItems` 入参全部改取 `collected.items`**（`tsc` 会挡漏改、但须显式做全）；更新 `RunProductDigestResult.collectedCount` doc-comment（「PH 产品条数」→「PH + Show HN 产品条数」）。**注意：product-digest 现有测试用 `skipCollectAndCollapse:true` 不注入采集，无既有 `collect:{...}` 注入位可迁移；5.4 e2e 是首个经 `collectOptions` 注入者。禁止改动 `run-daily-workflow` / `alert-scan` 测试里的 `collect:`（那是 `RunDailyWorkflowOptions`/`RunAlertScanOptions` 的 `CollectAllOptions` 字段、与本次无关，误改会坏既有链）。**

## 4. 配置

- [x] 4.1 `src/config/env.ts`：新增 `SHOW_HN_MIN_POINTS`（coerce 正整数，默认 10）、`SHOW_HN_MAX_PER_RUN`（coerce 正整数，默认 30）；非法值启动报错
- [x] 4.2 `.env.example` + 本地 `.env` 新增两项（注释：points 为众投确定性闸非语义判断；时间窗仅采集期控量、产品选品按 last_seen_at）

## 5. 测试（不触网，注入桩 + fixture）

- [x] 5.1 `src/collectors/__tests__/show-hn.test.ts`：注入 `fetchJson` 桩断言——objectID→sourceItemId、url→url、`created_at_i(秒)→publishedAt=Date(对应毫秒)`（断言是 `Date` 且时间正确）、**`created_at_i` 为 0/负/缺失/非数 → publishedAt=null（非 1970）**、`rawType='product'`、`source='show_hn'`、**title 剥前缀变体**（`Show HN:`/`Show HN -`/`Show HN –`/`Show HN —`/大小写；剥后空回退原 title）、metadata 透传；**跳过判据**（经 extractProductMergeKeys 三键全空）：url=null/空串/缺字段、非 http（`mailto:`/相对）、`github.com/owner` org 页 均跳过不发射；`numericFilters` 串含 `created_at_i>` 下界与 `points>=` 阈值两条件且 AND 生效（运算符已编码；逗号字面或 `%2C` 均可，不强求字面）；单源失败（桩抛错）withRetry 后抛出
- [x] 5.2 固化一份**真实 Algolia 响应**为 `src/collectors/__tests__/fixtures/show-hn-algolia.json`（含 objectID/created_at_i/points/url/title 字段），作 5.1 映射输入，使字段名声称可复现、未来 API 字段漂移被测试捕获
- [x] 5.3 塌缩集成测试（`*.integration.test.ts`，**跑真实 Postgres**——与既有 product-collapse/product-digest 集成测试同 DB 装置 + VITEST 守卫，**不得用内存桩替代塌缩事务**：`collapseUncollapsedProductRawItems` 依赖 `FOR UPDATE` + jsonb 运算，内存桩会假绿绕开关键断言；不触网）跑**真实** `collapseUncollapsedProductRawItems`：① **回归守护**——构造 `source='show_hn'` 与 `source='product_hunt'` 各一 product raw_item，断言两条都入 `ai_products`（任何把入口收窄到单 source 的改动即令 show_hn 断言失败）；② **跨源合并**——seed 一个 PH 行（`github_repo='o/r'`）再塌缩同 `github_repo` 的 Show HN，断言合并为单行（同 product_id、不新建）；③ **github 不误并（验 F1，防假绿）**——两条产品 **`url` 均为 `github.com/a/a`、`github.com/b/b`（经 url 推导 github_repo + 撞出 github.com 域，不预填 `meta.github_repo`/`meta.canonical_domain`，确保撞域真实发生）**，其中**至少一条 `source='product_hunt'`**（背书 F1 对 PH 同样正确），断言塌缩后为两行、各自 `canonical_domain` 为 null、不被静默合并/误记 merge_conflict（注释：注释掉 2.1 修复则本用例应转红）；④ 缺 slug 不破坏其余键合并
- [x] 5.4 **端到端测试**（`*.integration.test.ts`，**跑真实 Postgres**、同 5.3 装置；注入 fetch 桩不触网；只验采集+塌缩段、不触发真实推送/redis 锁或注入其 mock，遵 memory `test-no-prod-sends`）：以注入的 PH + Show HN fetch 桩（经 `collectOptions:{productHunt:{...},showHn:{...}}`）驱动 `runProductDigest` 采集+塌缩段，断言 Show HN 产品经 `collectSources(PRODUCT_SOURCES)→store→collapseUncollapsedProductRawItems` 全链入 `ai_products`（覆盖 3.4 注入改造正确性与「Show HN 真被产品子集采集入库」，补 5.3 绕过采集层的缺口）

## 6. 远端 ts.mac-mini 同步生效

- [ ] 6.1 `ssh ts.mac-mini` → `cd ~/ai-radar` → `cp -p .env .env.bak.$(date +%Y%m%d-%H%M%S)` 备份
- [ ] 6.2 python3 精确追加 `SHOW_HN_MIN_POINTS`/`SHOW_HN_MAX_PER_RUN` 到远端 `.env`（带断言：键尚不存在；勿整文件覆盖）
- [ ] 6.3 本地 `docker build` → `docker save | ssh ts.mac-mini docker load`（GHCR 受阻，部署 memory）→ 远端 `docker compose --profile app up -d` 重建 worker/web
- [ ] 6.4 `docker compose exec -T worker printenv SHOW_HN_MIN_POINTS` 确认；`docker compose logs --since 60s worker` 确认 env 校验通过、调度链已启动

## 7. 提交与规范归档

- [ ] 7.1 提交代码 + `.env.example`（`.env` 不入库）；含 src 实现 → **走 PR**（实现代码走 PR，归档/纯文档直推 main——按本仓库约定与 memory）
- [ ] 7.2 `/opsx:sync` 将增量规范并入 `source-collectors` 与 `product-discovery` 主规范（含 F1 github.com 修复需求）
- [ ] 7.3 `/opsx:archive` 归档本变更（纯文档归档步骤直推 main、不另开 PR）
