# 未来扩源方向（实证版）

> 实证日期 **2026-06-14**。所有 HTTP 状态/feed 条数/字段均为当日 `curl`/`WebFetch` 亲测（桌面 Chrome UA）。本文是规划文档，不是 OpenSpec 提案；接入某源时按 `/opsx:propose` 走正式流程。
>
> 协作产出：主 agent（厂商官方 RSS 实测扫 + 交叉复核）+ Tool Evaluator subagent（难源替代方案研究）。

## 0. 核心认知（本轮最大更新）

**「无原生 RSS」≠「无低成本入口」。** 早先把「站点没有 `/rss`」直接判为「需 HTML 抓取或放弃」是错的。实证发现三类**官方、确定性、可 schema 校验**的替代入口，能避开自托管 RSSHub 与无头浏览器、守住「确定性轻量采集」架构红线：

1. **官方 JSON API**（如 HF daily_papers）——结构化最干净，直接映射 `raw_items`。
2. **sitemap.xml 增量 diff**（如 Anthropic）——按 `<lastmod>` 取增量、URL 进 `raw_items` 交由 pipeline 抓正文，比抓 HTML 稳。
3. **藏在子域名/子路径的官方 feed**（如 AlternativeTo 子域名、Perplexity docs changelog）——复用现有 RSS collector，零新代码。

接入优先级排序的依据：**官方端点 > 桥接/抓取**，**复用现有 collector > 新增 collector 类型**，**信号纯度（一手 lab/产品）> 二手编辑/聚合**。

## 1. 现状（已接入）

| capability | 已接源 |
|---|---|
| §7.1 官方新闻（RSS） | OpenAI、DeepMind、HuggingFace、Mistral、Microsoft AI、GitHub Blog、GitHub Changelog |
| §7.2 技术社区 | Hacker News（topstories）、GitHub Search、arXiv（沉淀）、Lobsters |
| §7.3 产品发现 | Product Hunt、Show HN（HN Algolia） |

## 2. 推荐扩源（按梯队，含实证与接入方式）

### 第一梯队 —— 立即接，ROI 最高

**A. 厂商官方 RSS（7 个，零代码：仅改 `RSS_FEEDS`，复用现有 RSS collector）** ✅实证 200 + 原生 feed + 非空

| 源 | feed URL | 备注 |
|---|---|---|
| Together AI | `https://www.together.ai/blog/rss.xml` | 100 条 |
| NVIDIA 开发者博客 | `https://developer.nvidia.com/blog/feed/` | Atom，技术博文（含大量 CUDA/系统，靠 Value Judge 滤） |
| AWS ML Blog | `https://aws.amazon.com/blogs/machine-learning/feed/` | WP RSS，20 条 |
| Google Research | `https://research.google/blog/rss/` | 100 条 |
| Google AI（blog.google） | `https://blog.google/technology/ai/rss/` | AI 专栏、最贴合 |
| Microsoft Research | `https://www.microsoft.com/en-us/research/feed/` | 偏研究（与已接的 Microsoft AI news 互补） |
| Stability AI | `https://stability.ai/news-updates?format=rss` | Squarespace，首页 `<link rel=alternate>` 自曝；20 条 |

> vendor 标记建议：`together` / `nvidia` / `aws` / `google` / `google`（或 `google_ai`）/ `microsoft`（或 `microsoft_research`）/ `stability`。多 feed 同 vendor 已支持（feed_url 区分，见 source-collectors 主规范）。
> **无原生 RSS（实证确认）**：Cohere、LangChain、Replicate（现代 JS 站、HTML 无 alternate link）。
> **Vercel** 有 `vercel.com/atom`（1217 条）但**全站博客非 AI-only、噪音大** → 不建议接。

**B. Hugging Face Papers → 官方 JSON API** ✅实证 `GET https://huggingface.co/api/daily_papers` 200 application/json、~50 条/日、无鉴权
- 字段：`paper.id`/`title`/`summary`/`publishedAt`/`submittedBy`/`organization`…，结构化最干净。
- 定位：每日精选论文，质量高。**注意**：论文按 P2 既定策略 `rawType='paper'` 仅沉淀 `raw_items`、不进日报/推送（与 arXiv 同），论文板块留 P3。
- 工程：需新增「**JSON API 适配器**」采集器类型（区别于 RSS/Algolia）。

**C. Anthropic News → sitemap.xml 增量 diff** ✅实证 `https://www.anthropic.com/sitemap.xml` 200、**229 条 `/news/` + 457 个 `<lastmod>`**；`/news` 页直 fetch 也 200（**非整站 CF**，早先只测了 feed 路径 404）
- 顶级 lab 一手动态，无干净 feed 但 sitemap 是标准 XML、按 `lastmod` 取增量比抓 HTML 稳。
- 可顺带收 `/research`、`/engineering`（同 sitemap）。
- 工程：需新增「**sitemap 适配器**」采集器类型（按 `lastmod` 增量、URL 入 `raw_items` 后由 pipeline 抓正文）。

**D. AlternativeTo News → 子域名官方 feed** ✅实证 `https://feed.alternativeto.net/news/all` 200 application/rss+xml、15 条
- 主站 `alternativeto.net` 被 CF 拦，但 feed 在独立子域名绕过了。纯软件/AI 工具新闻，契合「AI 工具选型顾问」定位。
- 工程：**零代码**，复用现有 RSS collector。

### 第二梯队 —— 接，低优

**E. Perplexity changelog → Mintlify docs feed** ✅实证 `https://docs.perplexity.ai/docs/resources/changelog/rss.xml` 200 rss+xml、15 条
- **月级粒度**（按月聚合），只追 Perplexity API/产品迭代、非细粒度新闻；主站 Hub/news 仍被 CF 拦。复用 RSS collector，近零成本。

**F. 编辑/分析源（可选，二手内容）** 🔍检索（多数有 RSS，待逐一实测）
- MarkTechPost、MIT Tech Review AI、The Gradient、Ahead of AI（Sebastian Raschka）、Last Week in AI 等。
- 权衡：二手编辑/聚合内容，非一手 lab 源，噪音与重复偏高；可作日报「行业观点」补充，但优先级低于一手源。可挖 [feedspot Top 100 AI](https://rss.feedspot.com/ai_rss_feeds/) / [readless](https://www.readless.app/blog/best-ai-news-rss-feeds-2026) 的精选 feed 清单。

### 第三梯队 —— 缓（需额外处理才有价值）

**G. Meta AI Blog** ✅实证 `ai.meta.com/blog/{rss,feed,sitemap.xml}` 全 400（FB Error 非 CF）；`about.fb.com/news/feed/` 200 真 WP RSS
- 无干净 AI-only feed。备选：`about.fb.com/news/feed/`（全公司）+ LLM/关键词主题过滤出 AI 条目。信噪比差，等前面跑顺再做。

## 3. 放弃（无低成本可靠入口）

| 源 | 实证 | 原因 |
|---|---|---|
| **xAI** | `x.ai/*` 全 403（CF 浏览器墙）；`docs.x.ai` 无 changelog feed；RSSHub 无路由 | 整站 CF + 无 feed + 无桥接。发布量低，建议未来若接 X 平台源时经 @xai/@grok 账号侧收，否则人工 |
| **There's An AI For That** | `/feed`/`/rss`/`/sitemap.xml` 全 403 CF；RSSHub 无路由 | 硬 CF、无任何入口 |
| **Futurepedia** | `sitemap.xml` 200 但是工具目录、无时间序 lastmod；`/feed`/`/api/tools` 404 | sitemap 非新闻流；如做「工具库」二期可用 |
| **BetaList** | `/feed`/`/startups.rss`/`/sitemap.xml` 全 404 | 站点结构已变、无入口 |
| **Indie Hackers** | `/feed.xml` 重定向首页、`/rss` 返 HTML；sitemap 指向外部 GCS 桶 | 无真 feed、解析成本高、与定位弱相关 |
| **Reddit**（r/LocalLLaMA 等） | 公开 `.rss` 默认 UA 403、自定义 UA **429**（IP 级限流）；RSSHub 无路由 | `.rss` 技术上不可靠 + 触碰 Reddit 数据政策灰区。维持既有条款决策排除 |
| **Papers with Code** | Meta 2025 关停、重定向 HF | 已死 |
| **GitHub Trending** | 无官方 API/RSS | 已用 GitHub Search API 近似 |

## 4. 架构决策：不引入 RSSHub，不引入无头浏览器

**不引入 RSSHub**（自托管 feed 生成器）——实证依据：
1. 公共实例 `rsshub.app` 自身被 CF 拦（`/anthropic/news`、`/reddit/*` 等返 403），**必须自托管**，引入需长期运维的 Node 服务 + 反爬维护负担。
2. 路由覆盖**恰好缺**最头疼的 xAI / Reddit / theresanaiforthat / futurepedia / betalist / indiehackers（有 Anthropic/Meta/Perplexity/AlternativeTo/HF 路由，但这些我们已有更稳的官方入口）。
3. 机制脆弱（`ofetch + cheerio` 抓 HTML 选择器、无反 CF），站点改版即坏；对 Meta（返 400）易碎。
4. 违背 CLAUDE.md「确定性 + 轻量采集」——自托管 RSSHub = 引入黑盒 HTML 解析中间件，可观测性差、漂移风险高。

**不引入无头浏览器**（绕 CF）——为几个反爬站引入 Playwright 自动化，重依赖、脆弱（CF 挑战会升级）、性价比低，同样违背轻量确定性原则。

## 5. 工程影响（接入前需准备）

| 接入方式 | 现有 collector 可复用？ | 需新增 |
|---|---|---|
| 厂商官方 RSS（A）、AlternativeTo（D）、Perplexity changelog（E） | ✅ 复用现有 RSS collector，纯改 `RSS_FEEDS` | — |
| HF Papers（B） | ❌ | **JSON API 适配器**采集器类型 |
| Anthropic sitemap（C） | ❌ | **sitemap 适配器**采集器类型（按 `lastmod` 增量；URL 入库后由 pipeline 抓正文） |
| Meta（G） | ✅ RSS + 下游主题过滤 | （过滤逻辑） |

> 两个新采集器类型（sitemap / JSON API）都应遵守既有不变量：`source_item_id` 非空 fallback 链、`Promise.allSettled` 单源失败隔离、`withRetry` + 错误日志、registry 注册即接入。sitemap 适配器的 `source_item_id` 用 canonical_url（URL 本身稳定）；JSON API 用各源稳定 id（HF 用 `paper.id`）。

## 6. 难点归类（一句话）

1. **没有结构化 feed** → 优先找 sitemap/官方 JSON API（C/B），其次官方子路径/子域名 feed（D/E），最后才考虑 HTML 抓取（脆弱、无稳定 id）。
2. **反爬（CF）** → 子域名/docs 子路径可能绕过（D/E 实证可行）；整站硬墙（xAI/TAAFT）无低成本解，弃。
3. **条款/法律** → Reddit，决策而非技术。
4. **二手/低信号** → 编辑聚合源、AI 目录站，信噪比与定位匹配度低，缓或弃。

## 7. 建议执行顺序

1. **零代码批**：第一梯队 A 的 7 个厂商 RSS + D（AlternativeTo）+ E（Perplexity changelog）——一个 `/opsx:propose` 配置变更即可（与已做的 Mistral/Microsoft/GitHub/Lobsters 同模式），实测已确认全部可用。
2. **JSON API 适配器**：HF Papers（B）——新采集器类型，论文沉淀。
3. **sitemap 适配器**：Anthropic（C）——新采集器类型，一手 lab 动态；跑顺后可推广到其他无 feed 但有 sitemap 的 lab。
4. **缓**：Meta（G，需主题过滤）。
5. **不做**：xAI / TAAFT / Futurepedia / BetaList / Indie Hackers / Reddit / RSSHub / 无头浏览器。
