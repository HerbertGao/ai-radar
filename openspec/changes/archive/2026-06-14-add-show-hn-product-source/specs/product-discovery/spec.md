## 新增需求

### 需求:产品塌缩为多源输入并支持跨源产品合并

产品塌缩（`ai_products`）MUST 为**多源**输入：消费**任何** `source` 的 `raw_items(raw_type='product')` 行（source-agnostic，按 `raw_type='product' AND collapsed=false` 选取，**不按 source 过滤**），不限于 Product Hunt。本期新增 Show HN（`source='show_hn'`，见 source-collectors）作为第二个产品源。塌缩入口 MUST 保持 source-agnostic——MUST NOT 为任何理由把入口收窄到按单一 source 过滤（否则会静默断掉除 PH 外的产品源）。塌缩的合并判定、三唯一键、`FOR UPDATE` 多键命中收集、`size` 分流、`merge_conflict` 不静默择一等 MUST **沿用既有「ai_products 硬规则产品合并」需求**，本需求不重定义这些判定。

产品发现链路的采集 MUST 经产品源子集 `PRODUCT_SOURCES`（见 source-collectors）取所有产品源（PH + Show HN），与产品塌缩在同一链路衔接，使新增产品源被采集后即被同链塌缩——MUST NOT 让某产品源仅被采集入库却无塌缩触发（避免依赖跨 workflow 隐式时序的脆弱闭合）。

**跨源合并** MUST 经非空归一键实现：不同源的产品共享同一非空归一键时合并为 `ai_products` 单行。归一键提取对所有产品源一致（`canonical_domain` 由产品 URL 经 URL 规范化提取、`github_repo` 由 github URL 归一为 `owner/name`、`product_hunt_slug` 取 PH 原生 slug；Show HN 无 slug，其 slug 键空、不参与合并，合规）。

**github 托管产品的合并键修复（必须）**：`extractProductMergeKeys` MUST **无条件**令 `canonical_domain='github.com'` 置 null（**不** gate 在 `github_repo` 非空上）。`github.com` 非有意义的产品域：指向具体 repo 者用 `github_repo` 作精确合并键；指向 `github.com/owner` org/profile 页者无具体 repo（`github_repo` 亦 null）→ 三键全空、由采集器跳过（见 source-collectors），不应靠 `github.com` 域合并。**为何不能仅在 `github_repo` 非空时抑制**：org 页（单段路径）`github_repo=null`，条件抑制会留它们仍共享 `canonical_domain='github.com'` 彼此静默合并（残留撞域）。否则所有 github 托管产品共享 `canonical_domain='github.com'`，在 `lockMatchingProductIds` 的 OR 命中里彼此 size=1 命中 → 被静默 `UPDATE` 合并为同一行（非 `merge_conflict`，更隐蔽）——Show HN 大量直链 `github.com/owner/repo` 会触发灾难性误并。修复后指向具体 repo 的 github 产品按各自 `github_repo` 独立、不因共享 `github.com` 域误并；此修复对 Product Hunt 同样正确（PH 的 github 托管产品同被抑制、改按 `github_repo` 合并）。

跨源合并后 `ai_products.name` 取**先 INSERT 的源**的标题（`resolveName` 仅 INSERT 时设、UPDATE 不更新）；下游 `product-digest` 展示用 `ai_products.name`（不依赖 `representative_raw_item_id`，故后者跨源 last-writer 语义不影响展示）。Show HN 标题须在采集器侧剥除 `Show HN:` 前缀（见 source-collectors），避免先到为 Show HN 时 name 带帖式前缀。`name` 统一口径富化留 P5。

#### 场景:Show HN 产品经 source-agnostic 入口塌缩入 ai_products
- **当** 一条 `source='show_hn'`、`raw_type='product'`、`url` 非空（归一后至少一键非空）的 Show HN raw_item 经真实入口 `collapseUncollapsedProductRawItems` 塌缩
- **那么** source-agnostic 入口按 `raw_type='product'` 选中它，经 `canonical_domain`/`github_repo` 键 INSERT/UPDATE 进 `ai_products`，无需 PH 专属字段；该行为构成回归守护——任何把入口收窄到单 source 的改动会使本断言失败

#### 场景:同一产品 PH 与 Show HN 经 github_repo 跨源合并为单行
- **当** 某 github 托管产品先经 Product Hunt 入 `ai_products`（`github_repo='owner/repo'`），其后又经 Show HN 采到同一 github 仓库（同 `github_repo`）
- **那么** 事务内多键 `FOR UPDATE` 命中既有行、塌缩为 `UPDATE`（同一 `product_id`、不新建第二行），实现跨源合并

#### 场景:两个不同 github 仓库的产品不因共享 github.com 域误并
- **当** 两个不同 github 托管产品（`url` 分别为 `github.com/a/a`、`github.com/b/b`，经 url 推导 `github_repo` + 撞出 `github.com` 域）先后塌缩（至少一个 `source='product_hunt'` 以背书修复对 PH 同样正确）
- **那么** 经无条件抑制后二者 `canonical_domain` 均为 null、仅按各自 `github_repo` 键匹配 → 互不命中 → 各成 `ai_products` 单独行（不被静默合并、不误记 merge_conflict）

#### 场景:Show HN 缺 product_hunt_slug 不影响其余键合并
- **当** Show HN 产品无 `product_hunt_slug`（仅 `canonical_domain` 或 `github_repo`）
- **那么** 空 slug 键不参与合并（不产生 `UNIQUE(product_hunt_slug, NULL)` 放行多行），塌缩仅用非空键，源内幂等与跨源合并不失效
