// 先加载 .env（若存在）到 process.env，再做下方校验。
// dotenv 默认不覆盖已存在的 process.env，故 CI / shell 注入的变量仍优先，
// 本地 `cp .env.example .env` 填好后 `npm run dev` 等脚本即可读到（修复 README 快速开始）。
import 'dotenv/config';
import { z } from 'zod';
// 仅取类型（verbatimModuleSyntax 下 import type 编译期擦除）：不引入 collectors 运行期依赖，
// 保 env.ts 作为基础配置模块不被 opencc-js/emoji-regex 等采集侧重依赖污染、且无循环依赖。
import type { CollectorSource } from '../collectors/types.js';

/**
 * 环境配置 schema（承载 spec「环境配置校验」需求）。
 *
 * 关键不变量：缺关键变量启动即报错，禁止静默用空值/默认值继续运行。
 * - DATABASE_URL / REDIS_URL：基础设施连接串，必填。
 * - LLM_API_KEY / LLM_MODEL：LLM provider 凭据与模型名，Value Judge 往返必需。
 * - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID：Telegram 单通道推送凭据与目标，必填
 *   （P1 推送链路上线，缺则无法发日报）。
 *
 * provider 经 Vercel AI SDK 抽象，本模块对具体 provider 无硬编码偏好；
 * key、model 名与 base URL 从 env 注入。
 * - LLM_BASE_URL：OpenAI 兼容端点，默认指向 OpenRouter（https://openrouter.ai/api/v1）。
 *
 * P1 流水线配置（组合分权重 / Top N / 闸值 / 时区 / 源清单）以默认值兜底，
 * 但所有 number/ratio 都经 coerce + 范围校验，非法值（NaN / 负数 / 越界）启动即报错，
 * 不静默退化。
 */

/** 带 vendor 标记的单个 RSS feed 配置（vendor 可空，普通博客无映射时为 null）。 */
export interface RssFeedConfig {
  url: string;
  vendor: string | null;
}

/**
 * 把 `RSS_FEEDS` 由「URL 逗号列表」升级为「带 vendor 标记的 feed 配置」（design D2 / spec）。
 *
 * 格式：逗号分隔多个条目，每个条目形如 `url|vendor`。
 * 解析每个条目的确定性顺序（消除「以是否含 `|` 区分新旧」与「URL 不得含 `|`」的环形依赖）：
 *   ① 按**首个** `|` split 成两段；
 *   ② split 后第二段再含 `|`（即原 URL 含 `|`、条目含多于一个 `|`）→ 配置错误、启动报错；
 *   ③ 条目不含 `|`（split 仅 1 段）→ 旧裸 URL 格式、启动快速失败并提示新格式；
 *   ④ vendor 段（第二段）可空：`url|`（尾随空 vendor）→ vendor=null、不报错、不阻塞采集。
 *
 * 这是破坏性 env 变更：禁止静默把所有 feed 的 vendor 置空入库。
 */
const rssFeedList = z
  .string()
  .default('')
  .transform((raw, ctx) => {
    const entries = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const feeds: RssFeedConfig[] = [];
    for (const entry of entries) {
      const sepIdx = entry.indexOf('|');
      if (sepIdx === -1) {
        // 旧裸 URL 格式（无 |）：机械判为旧格式，快速失败提示新格式。
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'RSS_FEEDS 条目「' +
            entry +
            '」缺少 vendor 分隔符 |（旧裸 URL 格式已废弃）。' +
            '请改用新格式 url|vendor（vendor 可空，如 https://example.com/feed| 表示无厂商标记），' +
            '多个 feed 用逗号分隔。',
        });
        continue;
      }
      const url = entry.slice(0, sepIdx).trim();
      const rest = entry.slice(sepIdx + 1);
      if (rest.includes('|')) {
        // 第二段再含 |（即原 URL 含 |、条目含多于一个 |）：配置错误，启动报错。
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'RSS_FEEDS 条目「' +
            entry +
            '」含多于一个 | 分隔符（URL 不得含 |）。每个条目须恰好形如 url|vendor。',
        });
        continue;
      }
      if (url.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'RSS_FEEDS 条目「' + entry + '」的 URL 段为空。',
        });
        continue;
      }
      const vendorRaw = rest.trim();
      feeds.push({ url, vendor: vendorRaw.length > 0 ? vendorRaw : null });
    }
    return feeds;
  });

/** 单个 sitemap 增量源配置（add-tier1-ai-sources，design D3）：sitemap URL + 路径前缀 + vendor。 */
export interface SitemapSourceConfig {
  sitemapUrl: string;
  pathPrefix: string;
  vendor: string;
}

/**
 * 把 `SITEMAP_SOURCES` 解析为「sitemap 增量源配置」列表（add-tier1-ai-sources，design D3 / spec）。
 *
 * 格式：逗号分隔多个条目，每个条目形如 `url|pathPrefix|vendor`（**恰好 2 个 `|`、3 段**）。
 * 比照上方 `rssFeedList` 的「钉死错误分支、绝不静默退化」范式，启动期快速失败：
 *   ① 按 `|` split；段数 ≠ 3（`|` 不恰好 2 个）→ `addIssue`；
 *   ② 任一段 trim 后为空 → `addIssue`；
 *   ③ pathPrefix 不以 `/` 开头 → `addIssue`（用于 `new URL(c).pathname.startsWith(pathPrefix)` 过滤，
 *      非 `/` 开头的前缀必不匹配规范化后的 pathname，属配置错误）。
 * 空字符串 `SITEMAP_SOURCES=` → 解析为空数组（该源不采，与 RSS_FEEDS 空值处理一致）。
 * 未设置 env 时默认含 Anthropic News 一条（design D3 默认配置）。
 */
const sitemapSourceList = z
  .string()
  .default('https://www.anthropic.com/sitemap.xml|/news/|anthropic')
  .transform((raw, ctx) => {
    const entries = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const sources: SitemapSourceConfig[] = [];
    for (const entry of entries) {
      const parts = entry.split('|');
      if (parts.length !== 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'SITEMAP_SOURCES 条目「' +
            entry +
            '」格式错误：须恰好形如 url|pathPrefix|vendor（恰好 2 个 | 分隔符、3 段）。',
        });
        continue;
      }
      const sitemapUrl = parts[0]!.trim();
      const pathPrefix = parts[1]!.trim();
      const vendor = parts[2]!.trim();
      if (sitemapUrl.length === 0 || pathPrefix.length === 0 || vendor.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'SITEMAP_SOURCES 条目「' +
            entry +
            '」含空段：sitemapUrl / pathPrefix / vendor 三段均不得为空。',
        });
        continue;
      }
      if (!pathPrefix.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'SITEMAP_SOURCES 条目「' +
            entry +
            '」的 pathPrefix「' +
            pathPrefix +
            '」必须以 / 开头（用于在规范化绝对 URL 上 new URL(c).pathname.startsWith 过滤）。',
        });
        continue;
      }
      sources.push({ sitemapUrl, pathPrefix, vendor });
    }
    return sources;
  });

/**
 * 全部已注册采集源名（供按源覆盖串校验源名拼写）。
 * `satisfies Record<CollectorSource, true>` 强制与 `CollectorSource` 联合类型逐一对齐：
 * 联合类型新增成员却漏加此处 → typecheck 立即失败（防「加了源、覆盖校验却把它当未知源拒掉」的漂移）。
 * 注意：这里是**已注册源全集**（用于拼写校验），与陈旧度**监控集**（另在 source-staleness.ts 里
 * 取 `buildRegistry().map(e=>e.source)` 并剔除结构性停用源）不同——覆盖 `blogger:7` 即便本部署
 * BLOGGER_FEEDS 为空也算合法源名（不属拼写错误），故此处不排除结构性停用源。
 */
const ALL_COLLECTOR_SOURCE_SET = {
  rss: true,
  hacker_news: true,
  github: true,
  arxiv: true,
  product_hunt: true,
  show_hn: true,
  hugging_face_papers: true,
  sitemap: true,
  blogger: true,
} satisfies Record<CollectorSource, true>;

/**
 * 把 `SOURCE_STALENESS_ALERT_DAYS_OVERRIDES` 解析为按源覆盖阈值 `Map<source, days>`
 * （add-per-source-staleness-alert，design D3 / spec「覆盖配置解析为容错跳过而非 fail-fast」）。
 *
 * 格式：逗号分隔多个 `source:days` 条目（如 `product_hunt:2,blogger:7`）。
 * **有意偏离本文件其它 env 的 fail-fast 风格**——陈旧度告警是 advisory 可观测能力，一条坏覆盖不应
 * 拖垮整个应用启动。**误配项跳过并记日志（console.warn 到 stderr）、绝不 addIssue**；**纯空串项**
 * （如 `a,,b`、首尾逗号产生的空段）是良性格式、**静默跳过不记日志**（避免噪音）：
 *   - 缺 `:` 分隔 / source 段空 / days 段空（非空但缺段）→ 跳过并记日志；
 *   - days 非正整数（0 / 负 / 非整数 / NaN）→ 跳过并记日志（禁止 0/负阈值致该源恒判陈旧）；
 *   - source 不在已注册源集合（ALL_COLLECTOR_SOURCE_SET）→ 跳过并记日志提示拼写（防真源被误以为已配置）；
 *   - 纯空串项（split+trim 后为空）→ **静默跳过**（良性，不记日志）；
 *   - 同源多次 → last-wins（Map.set 后者覆盖前者）；
 *   - 空值 `''` → 空 Map。
 */
const stalenessOverrideMap = z
  .string()
  .default('')
  .transform((raw) => {
    const overrides = new Map<string, number>();
    const known = new Set<string>(Object.keys(ALL_COLLECTOR_SOURCE_SET));
    const skip = (entry: string, why: string): void =>
      console.warn(
        `[env] SOURCE_STALENESS_ALERT_DAYS_OVERRIDES 条目「${entry}」${why}，已跳过` +
          `（陈旧度告警为 advisory，坏覆盖不阻断启动）。`,
      );
    for (const entry of raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      const sepIdx = entry.indexOf(':');
      if (sepIdx === -1) {
        skip(entry, '缺少 : 分隔符（须为 source:days）');
        continue;
      }
      const source = entry.slice(0, sepIdx).trim();
      const daysRaw = entry.slice(sepIdx + 1).trim();
      if (source.length === 0 || daysRaw.length === 0) {
        skip(entry, 'source 段或 days 段为空');
        continue;
      }
      if (!known.has(source)) {
        skip(entry, `源名「${source}」不在已注册源集合内（疑似拼写错误）`);
        continue;
      }
      const days = Number(daysRaw);
      if (!Number.isInteger(days) || days <= 0) {
        skip(entry, `天数「${daysRaw}」不是正整数`);
        continue;
      }
      overrides.set(source, days); // 同源多次：后者覆盖前者（last-wins）。
    }
    return overrides;
  });

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL 缺失：需提供 PostgreSQL 连接串')
    .url('DATABASE_URL 必须是合法 URL（如 postgres://user:pass@host:5432/db）'),
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL 缺失：需提供 Redis 连接串')
    .url('REDIS_URL 必须是合法 URL（如 redis://localhost:6379）'),
  LLM_API_KEY: z
    .string()
    .min(1, 'LLM_API_KEY 缺失：需提供 LLM provider API key'),
  LLM_MODEL: z
    .string()
    .min(1, 'LLM_MODEL 缺失：需提供模型名（如 openai/gpt-4o-mini）'),
  LLM_BASE_URL: z
    .string()
    .url('LLM_BASE_URL 必须是合法 URL（OpenAI 兼容端点，如 https://openrouter.ai/api/v1）')
    .default('https://openrouter.ai/api/v1'),
  // 单次 LLM 调用（generateObject）超时毫秒数；防一条挂起的响应卡死 Value Judge / 摘要阶段。
  // LLM 比普通 fetch 慢，默认给 60s。
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  // --- Telegram 推送（telegram-push）---
  TELEGRAM_BOT_TOKEN: z
    .string()
    .min(1, 'TELEGRAM_BOT_TOKEN 缺失：需提供 Telegram bot token（@BotFather 获取）'),
  TELEGRAM_CHAT_ID: z
    .string()
    .min(1, 'TELEGRAM_CHAT_ID 缺失：需提供目标 chat id（推送日报的目标会话）'),

  // --- 飞书自定义机器人推送（可选，feishu-push 5.1，design D5）---
  // **飞书可选**：两者均缺 → 飞书 disabled、不纳入「已配置通道」集、纯 Telegram 部署照常启动；
  // 仅配其一（不完整）→ 由下方 superRefine 快速失败；两者全配 → enabled。
  // 这里两个字段各自 optional（不无条件必填，否则破坏纯 Telegram 向后兼容）；
  // 「配其一即报错」的完整性约束在 schema 级 superRefine 里跨字段判定。
  FEISHU_WEBHOOK_URL: z
    .string()
    .url('FEISHU_WEBHOOK_URL 必须是合法 URL（飞书自定义机器人 webhook 地址）')
    .optional(),
  FEISHU_SIGN_SECRET: z.string().min(1).optional(),

  // --- 推送时区（daily-intel-pipeline / telegram-push）---
  // push_date 与候选窗口「今天」同源此时区，钉死防跨 UTC 零点重复推送（design D6）。
  PUSH_TIMEZONE: z.string().min(1).default('Asia/Shanghai'),

  // --- Top N 与组合分权重（daily-intel-pipeline D5）---
  TOP_N: z.coerce.number().int().positive().default(8),
  RANK_WEIGHT_IMPORTANCE: z.coerce.number().min(0).default(0.45),
  RANK_WEIGHT_DEVELOPER_RELEVANCE: z.coerce.number().min(0).default(0.25),
  RANK_WEIGHT_NOVELTY: z.coerce.number().min(0).default(0.2),
  // hype_risk 为减项（rank_score 里以负权重计），此处取其非负幅度，组合分时作减项。
  RANK_WEIGHT_HYPE_RISK: z.coerce.number().min(0).default(0.1),
  // importance 下限闸：宁可某天少于 N 条也不凑数推垃圾（design D5）。
  IMPORTANCE_FLOOR: z.coerce.number().min(0).max(100).default(60),

  // --- 降级率熔断（daily-intel-pipeline D8）---
  // 任一阶段分母 > 0 且其降级率严格 > 此值 → 中止 + 告警，不推残缺日报。
  DEGRADE_ABORT_RATIO: z.coerce.number().min(0).max(1).default(0.5),

  // --- 候选窗口（daily-intel-pipeline D5；fix-push-recency-by-published-at D1/D5）---
  // 日报候选时效窗口天数（近 N 天）。**语义已变更**：天数复用、变量名保留（保配置兼容），
  // 但时效闸的键已由「抓取近 N 天（first_seen_at）」改为「**发布近 N 天（published_at）**」——
  // first_seen_at 仅记首次抓取时刻、与文章真实发布时间无关，会把冷启动抓到的历史老文误当近期。
  // 改键后 NULL published_at 经 AI 推断回填、仍 NULL 则排除（详见 top-n.ts 顶部注释与 design D1）。
  FIRST_SEEN_WINDOW_DAYS: z.coerce.number().int().positive().default(3),

  // --- 发布时间 AI 推断成本闸（fix-push-recency-by-published-at D4）---
  // 单轮回填（published-at-inference）最多对多少个 NULL published_at 事件调 LLM 推断。
  // 回填作用域（should_push=true / 达阈值 + published_at IS NULL）可能远大于 Top N / 告警单次上限，
  // 故须独立成本闸硬封单轮 LLM 调用量（Top N / ALERT_MAX_PER_SCAN 限不住）；超出者下轮补填。
  // 进 zod 校验：非法值（负数/NaN/0）启动即报错，守 env 全局不变量（裸读 process.env 会绕过）。
  PUBLISHED_AT_INFERENCE_MAX_PER_RUN: z.coerce.number().int().positive().default(20),

  // --- BullMQ 每日定时触发（daily-intel-pipeline D7 / feishu-push 5.5）---
  // cron 表达式（BullMQ repeat.pattern）触发 daily-digest 任务，默认每日 08:03。
  // **分钟字段默认避整点/半点（∉ {0, 30}）**：飞书自定义机器人单租户限流（11232），
  // 整点/半点是多机器人/多服务集中推送的高压时刻，08:03 错峰降低限流概率（feishu-push 5.5）。
  // cron 时区由 DAILY_DIGEST_CRON_TZ 指定（默认与 push 同源 Asia/Shanghai），
  // 防触发时区与 push_date 口径漂移。
  DAILY_DIGEST_CRON: z.string().min(1).default('3 8 * * *'),
  DAILY_DIGEST_CRON_TZ: z.string().min(1).default('Asia/Shanghai'),
  // 整 job 重试次数（BullMQ 作整 job 重试外壳，不拆阶段队列，design D7）。
  DAILY_DIGEST_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // 周报调度开关：默认 'false'（暂禁用，待打磨后改 'true' 启用）。
  // 关闭时 worker 不注册/启动 weekly-report 调度链；周报实现与测试保留、随时可开。
  WEEKLY_REPORT_ENABLED: z.enum(['true', 'false']).default('false'),

  // --- Collector 源清单（source-collectors）---
  // 带 vendor 标记的 RSS feed 配置：逗号分隔多个 `url|vendor` 条目（vendor 可空），
  // 解析为 {url, vendor}[]；旧裸 URL 格式（无 `|`）启动即报错（design D2）。可为空（空则该源不采）。
  RSS_FEEDS: rssFeedList,
  // 策划 AI 博主 feed（add-ai-blogger-experience-mining，design D1）：复用 `rssFeedList` 的
  // `url|vendor` 解析（同 RSS_FEEDS 语义、同破坏性约束），解析为 {url, vendor}[]。独立于 RSS_FEEDS——
  // 经验链以 `source='blogger'` + `raw_type='experience'` 两硬字段隔离，**不**混入新闻链。
  // 可为空（空 → 空数组，该源不采）；非空时每条须为新格式 `url|vendor`（旧裸 URL 启动即报错）。
  BLOGGER_FEEDS: rssFeedList,
  // GitHub API token，用于提额（带 token 提速率上限）；可空，空则匿名调用受更严限流。
  GITHUB_TOKEN: z.string().default(''),
  // Product Hunt Developer Token（只读，无需交互 OAuth）：产品发现采集器用它调 GraphQL。
  // 必填且非空：缺失则产品发现无法采集，按既有 env 校验快速失败，禁止匿名静默继续（spec product-discovery）。
  PRODUCT_HUNT_TOKEN: z
    .string()
    .min(1, 'PRODUCT_HUNT_TOKEN 缺失：需提供 Product Hunt Developer Token（只读，用于产品发现采集）'),
  // 单次源网络调用（fetch / RSS parseURL）超时毫秒数；防实网挂起无限期卡死整个采集。
  COLLECTOR_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // --- Show HN 产品采集（HN Algolia，source-collectors / design D1/D4）---
  // 众投质量闸：仅采 points >= 此值的 Show HN（HN 群体投票信号，**非内容语义判断**，
  // 与 GitHub collector「按 star 倒序」同属确定性群体信号；区别：这是绝对阈值，某轮可能 0 条达标
  // → 返回空，属预期、不触发告警）。默认 10（实测拍的保守值）；非法值（NaN/负/0）启动即报错。
  SHOW_HN_MIN_POINTS: z.coerce.number().int().positive().default(10),
  // 单轮采集上限（Algolia hitsPerPage，本期不翻页）。时间窗（借 FIRST_SEEN_WINDOW_DAYS 天）
  // **仅采集期控量**——产品选品按 ai_products.last_seen_at、不经 published_at 时效窗（见 product-digest）。
  // 默认 30（10 points 阈值下近 3 天有裕量）；非法值启动即报错。
  SHOW_HN_MAX_PER_RUN: z.coerce.number().int().positive().default(30),

  // --- 扩源第一梯队（add-tier1-ai-sources，design D2/D3）---
  // HF Papers 单轮采集上限（daily_papers 单轮取前 N 条；比照 SHOW_HN_MAX_PER_RUN 控量）。
  // 默认 50（实测 ~50 条/日）；非法值（NaN/负/0）启动即报错。
  HF_PAPERS_MAX_PER_RUN: z.coerce.number().int().positive().default(50),
  // sitemap 增量源配置：逗号分隔多个 `url|pathPrefix|vendor` 条目（恰好 3 段），
  // 解析为 {sitemapUrl, pathPrefix, vendor}[]；段数≠3 / 任一段空 / pathPrefix 不以 / 开头 → 启动即报错。
  // 默认含 Anthropic News；可为空（空则该源不采）。sitemap 窗口复用 FIRST_SEEN_WINDOW_DAYS。
  SITEMAP_SOURCES: sitemapSourceList,

  // --- 实时重大发布告警（realtime-alerts，design D6）---
  // 实时告警总开关。默认 'false'（功能打磨期关闭）；设为 'true' 才注册 alert-scan 队列与 worker。
  // 关闭时 worker-main.ts 完全跳过该调度链，不注册 BullMQ 队列/worker。
  ALERT_SCAN_ENABLED: z.enum(['true', 'false']).default('false'),
  // 「重大发布」实时告警阈值：评分**后**判 `importance_score IS NOT NULL AND >= 此值` 才告警。
  // 默认 85，严于日报候选 should_push 的 importance>=75 与 Top N 下限闸>=60（实时门槛更高防刷屏）。
  // 判定纯程序阈值，禁止 LLM 决定是否告警。
  ALERT_IMPORTANCE_THRESHOLD: z.coerce.number().min(0).max(100).default(85),
  // 实时告警高频轮询 cron（BullMQ repeat.pattern）。默认每 15 分钟（落 base spec「15–30 分钟」保守窗口内、
  // 对稀有 P0 已足够即时；仍 env 可配，靠真实数据调）。
  // 高频链路全源 0/空轮是常态、不告警；只采实时新闻源 {rss,hacker_news,github}，不碰 arXiv/PH。
  ALERT_SCAN_CRON: z.string().min(1).default('*/15 * * * *'),
  ALERT_SCAN_CRON_TZ: z.string().min(1).default('Asia/Shanghai'),
  ALERT_SCAN_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // 告警单例锁 `alert:{channel}:{event_id}` TTL（毫秒）：job 级短时持有，覆盖「单事件渲染+单通道送达」
  // 最坏时长；崩溃后经 TTL 自动释放（锁键不含时间，无 TTL 会永久死锁该事件告警，故释放语义不可省）。
  ALERT_LOCK_TTL_MS: z.coerce.number().int().positive().default(60000),
  // 告警候选时间窗口（天数）：仅对近 N 天内的事件发告警（防冷启动积压刷屏）。
  // **语义已变更**（fix-push-recency-by-published-at D1/D5）：天数复用、变量名保留（保配置兼容），
  // 但时效闸的键已由「抓取近 N 天（first_seen_at）」改为「**发布近 N 天（published_at）**」。
  // 默认 3（同日报候选窗口量级）；0 表示不限窗口（不推荐）——旁路仅免下界 gte，仍须排除 NULL
  // 与未来 published_at（见 alert-scan.ts 顶部注释与 design D1）。
  ALERT_FIRST_SEEN_WINDOW_DAYS: z.coerce.number().int().nonnegative().default(3),
  // 单次 alert-scan 最多发送的告警条数（防 Telegram rate limit 刷屏）。
  // 默认 5；超出的候选按 published_at DESC 保留最新，其余待下轮（15min 后）补发。
  ALERT_MAX_PER_SCAN: z.coerce.number().int().positive().default(5),
  // 首次启用发布时间基线水位（守 policy-push-timeliness）：
  // 启用瞬间防旧消息刷屏——告警候选须额外满足 `published_at >= 此基线`（与时效下界取 max），只告警基线之后
  // 发布的新闻，启用前发布的存量（无论何时被评分、无论后加了哪个通道）一律排除（谓词见 selectAlertCandidates）。
  // Zod 校验为**合法 ISO 时刻或显式空串**；**必须 .optional()、不给 .default('')**，使「未设(undefined)
  // vs 显式空串('') vs ISO」三态可分（仿 Feishu .optional()+superRefine 先例）——
  // 未设 + ALERT_SCAN_ENABLED='true' → superRefine fail-fast（防启用却忘设基线刷屏）；
  // 空串 = 运维明示放弃基线、自担刷屏风险；ISO = 水位。非法 ISO 启动即报错（不静默匹配空/静默压制全部）。
  // 经 alertMinPublishedAt() 解析成 Date 一次，绝不在查询站点逐次解析。
  ALERT_MIN_PUBLISHED_AT: z.string().datetime().or(z.literal('')).optional(),

  // --- 按源采集陈旧度告警（add-per-source-staleness-alert，design D3）---
  // 全局默认陈旧阈值天数：某已注册源连续超过此天数零新增（max(fetched_at) 早于 now-此天数，
  // 或从未产出）即经既有 AlertSink 上报。正整数，默认 3。判定纯 DB + 程序比较，绝不交 LLM。
  SOURCE_STALENESS_ALERT_DAYS: z.coerce.number().int().positive().default(3),
  // 按源覆盖阈值：逗号分隔 `source:days` 串（如 product_hunt:2,blogger:7），解析为 Map<source, days>。
  // 容错解析（advisory，有意不 fail-fast）：非法项（非正整数天数 / 缺段 / 未知源名 / 空串项）跳过并记日志、
  // 同源 last-wins、空值 → 空 Map（见上方 stalenessOverrideMap）。某源无覆盖时用 SOURCE_STALENESS_ALERT_DAYS。
  SOURCE_STALENESS_ALERT_DAYS_OVERRIDES: stalenessOverrideMap,

  // --- 并发评分原子 claim 回收阈值 T（daily-intel-pipeline「降级逐条容错」/ realtime-alerts，design D6）---
  // 日报链与告警高频链可能并发对同一未评分事件评分；送 LLM 前原子 claim（写 judge_claimed_at），
  // 仅 claim 成功者评分。一个被 claim 的事件停在「score NULL + 已 claim」的总时长 = L（单条 LLM 硬超时
  // LLM_TIMEOUT_MS）+ W（LLM 返回后写分/事务提交延迟上界）。回收阈值 T 必须 **> L + W**——否则
  // 慢评分会被另一链路误回收双写；过短则误回收，过长则僵尸 claim 回收慢。
  // 默认 = LLM_TIMEOUT_MS(60s) + 写分裕量 W(60s) 后再留余量，取 180000（180s > 60 + 60）。
  // 启动期跨字段校验 T > LLM_TIMEOUT_MS + JUDGE_WRITE_BUDGET_MS（见 superRefine）。
  JUDGE_CLAIM_RECLAIM_MS: z.coerce.number().int().positive().default(180000),
  // 写分提交延迟上界 W（毫秒）：LLM 返回后写 *_score / 事务提交的延迟上界（含 DB 写排队与进程暂停容限）。
  // 仅用于启动期校验 T > L + W；默认 60000。
  JUDGE_WRITE_BUDGET_MS: z.coerce.number().int().positive().default(60000),

  // --- P3 语义去重 + 知识库 embedding（add-semantic-dedup-and-store-hardening，design D1/D2/D4）---
  // embedding 模型名（经 Vercel AI SDK embed/embedMany 调用）。默认 text-embedding-3-small（1536 维、
  // 多语种含中英文、便宜）。**注意**：向量列维度在迁移中钉死 1536（design D1），换不同维度模型属新的
  // forward-only 迁移、非热切——改本值不会自动重建向量列，须配套迁移，否则维度不匹配落库报错。
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  // 构造 embedding 文本时代表 raw_item content 摘录的截断字符数（design D2）。
  // embedding 文本 = representative_title ‖ content 摘录（截断到此值）；防超长文本撑爆 token/调用。
  // 非法值（NaN/负/0）启动即报错（守 env 不变量，裸读 process.env 会绕过校验）。
  EMBEDDING_TEXT_MAX_CHARS: z.coerce.number().int().positive().default(2000),
  // 候选窗口 bootstrap 单轮 backlog 上限（design D3 / spec「候选窗口 bootstrap」）：单轮日报最多为多少条
  // embedding IS NULL 的窗内事件补嵌（先本轮新事件、再 first_seen_at 升序填补历史存活者）；余量后续轮次续嵌。
  // 防 P3 首部署一次性嵌满 14 天 backlog 撑爆 embedding 调用 / 拖住日报单例锁。默认 500；非法值启动即报错。
  EMBEDDING_BOOTSTRAP_MAX_PER_RUN: z.coerce.number().int().positive().default(500),
  // 语义去重高相似度自动合并阈值（design D4）：cosine_sim > 此值 → 直接判同事件、合并（跳过 LLM）。
  // 默认 0.88（QA §9.2 起点，非实测调优）。范围 [0,1]；越界/NaN 启动即报错。
  SEMANTIC_DEDUP_HIGH: z.coerce.number().min(0).max(1).default(0.88),
  // 语义去重 LLM 二次判断下界阈值（design D4）：SEMANTIC_DEDUP_LLM < sim <= SEMANTIC_DEDUP_HIGH → 交 LLM；
  // sim <= 此值 → 不合并。默认 0.82（QA §9.2 起点）。范围 [0,1]；越界/NaN 启动即报错。
  // 跨字段不变量（见下方 superRefine）：必须 SEMANTIC_DEDUP_LLM < SEMANTIC_DEDUP_HIGH，否则灰区为空/反转。
  SEMANTIC_DEDUP_LLM: z.coerce.number().min(0).max(1).default(0.82),
  // 语义去重候选时间窗（天数，design D4）：仅在 first_seen_at >= now()-此值 的窗内检索 KNN 候选 + 补嵌。
  // 默认 14（跨天去重需比历史存活者）。非法值（NaN/负/0）启动即报错。
  SEMANTIC_WINDOW_DAYS: z.coerce.number().int().positive().default(14),
  // 语义去重总开关（design「迁移计划·回滚」）：'on' 启用语义合并阶段；'off' 跳过、退回硬去重态。
  // 默认 'on'。仅日报链调用语义层（告警链恒走硬去重快路径，不受此开关影响）。
  SEMANTIC_DEDUP_ENABLED: z.enum(['on', 'off']).default('on'),

  // --- AI 博主经验提炼（add-ai-blogger-experience-mining，design 风险/权衡）---
  // 经验提炼前对超长 transcript/博文的截断字符数（**镜像 EMBEDDING_TEXT_MAX_CHARS**）：
  // 防长文本 token 爆。提炼 Agent 取 raw_item content 摘录（截断到此值）后调 generateObject。
  // 非法值（NaN/负/0/小数）启动即报错（守 env 不变量，裸读 process.env 会绕过校验）。
  EXPERIENCE_TEXT_MAX_CHARS: z.coerce.number().int().positive().default(2000),

  // ─── Model Radar 5b（add-model-radar-ingestion-freshness）保鲜回路调度 ───
  // 各调度链总开关，默认 'false'（打磨期关闭；worker-main 不注册对应 BullMQ 链，仿 ALERT_SCAN_ENABLED）。
  // 待 seed 录入 + 真实源勘验后改 'true' 启用。
  MR_EVENT_REVIEW_ENABLED: z.enum(['true', 'false']).default('false'),
  MR_SCRAPE_ENABLED: z.enum(['true', 'false']).default('false'),
  MR_STALENESS_ENABLED: z.enum(['true', 'false']).default('false'),

  // 事件流触发复核（design D8）：cron 在日报产出事件之后错峰。
  // **MR_EVENT_REVIEW_WINDOW_DAYS 必须 >=1**（`positive()` 拒 0/负）——0 会令
  // startOfDayInTimeZone(now, windowDays-1)=明天 00:00、候选闭区间空集 → 静默停打标（design D8）。
  MR_EVENT_REVIEW_CRON: z.string().min(1).default('23 8 * * *'),
  MR_EVENT_REVIEW_CRON_TZ: z.string().min(1).default('Asia/Shanghai'),
  MR_EVENT_REVIEW_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  MR_EVENT_REVIEW_WINDOW_DAYS: z.coerce.number().int().positive().default(1),

  // 三档抓取（design D10–D15）：http 日级 / browser 周级 cron 错峰。
  MR_SCRAPE_HTTP_CRON: z.string().min(1).default('13 9 * * *'),
  MR_SCRAPE_BROWSER_CRON: z.string().min(1).default('17 9 * * 1'),
  MR_SCRAPE_CRON_TZ: z.string().min(1).default('Asia/Shanghai'),
  MR_SCRAPE_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // 抓取裸请求可识别 UA（design D12，无凭据仅此头；守 robots 礼貌）。
  MR_SCRAPE_USER_AGENT: z
    .string()
    .min(1)
    .default('ai-radar-model-radar/1.0 (+https://github.com/HerbertGao/ai-radar; pricing-change-detector)'),
  // 单次抓取 fetch 超时毫秒 / 最大重定向跳数（SSRF 每跳重验 D10）/ 最大响应体字节（防 OOM D11）。
  MR_SCRAPE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  MR_SCRAPE_MAX_REDIRECTS: z.coerce.number().int().nonnegative().default(3),
  MR_SCRAPE_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(2_000_000),

  // 抓取快照临时存储（design D13，best-effort 证据、不入 mr_*）：目录 / TTL 毫秒 / 总字节上限（janitor 扫删）。
  MR_SNAPSHOT_DIR: z.string().min(1).default('.mr-snapshots'),
  MR_SNAPSHOT_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  MR_SNAPSHOT_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(100_000_000),

  // 陈旧度排程（design D9）：cron + last_checked 超阈值天数（默认 30；markChecked 掩盖窗口 = 此值）。
  MR_STALENESS_CRON: z.string().min(1).default('43 9 * * *'),
  MR_STALENESS_CRON_TZ: z.string().min(1).default('Asia/Shanghai'),
  MR_STALENESS_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  MR_STALENESS_THRESHOLD_DAYS: z.coerce.number().int().positive().default(30),

  // ─── Model Radar 5d（add-model-radar-snapshot-cross-process-invalidation）服务进程周期 rebuild ───
  // HTTP server 进程内 setInterval 周期重建快照缓存的间隔（毫秒）：驱动 `freshness.stale` 阈值穿越翻转、
  // 作 pub/sub 漏消息的自愈网、并令不走 publish 的 flag/staleness 日级写在一个间隔内可见（design D2/D3）。
  // **刻意用 `_MS`/setInterval，而非既有 `MR_*_CRON`+`_CRON_TZ`**——后者是 BullMQ repeatable job 约定，
  // D2 已否决「周期 rebuild 做成 worker BullMQ 链」（刷 worker 内存、没人服务）。它属服务进程的进程内定时器。
  // 与既有 `MR_SNAPSHOT_TTL_MS`（5b 抓取文件快照 TTL，design D13）**无关**：那管 .mr-snapshots 临时证据文件保留期，
  // 此管 5c 进程内只读快照缓存的重建周期，二者除名字相近外无任何关系。默认 300000（5min，价改/陈旧可见延迟上界）。
  MR_SNAPSHOT_REBUILD_INTERVAL_MS: z.coerce.number().int().positive().default(300000),

  // ─── Model Radar 价格 curation 一键批准（add-model-radar-price-curation-approval，design D4/D5）───
  // 总开关，默认 'false'（合并即门控关；仿 ALERT_SCAN_ENABLED / MR_SCRAPE_ENABLED）。
  // 关闭时 proposer 不注册 curation lane、接收侧不 start bot。
  MR_PRICE_CURATION_ENABLED: z.enum(['true', 'false']).default('false'),
  // proposer BullMQ lane 日级 cron（错峰其余 MR 链：http 13:09 / browser 周一 09:17 / staleness 09:43）。
  MR_PRICE_CURATION_CRON: z.string().min(1).default('53 9 * * *'),
  // Telegram 一键批准白名单：逗号分隔的**数值** user id 清单，解析为 number[]（callback 鉴权按
  // `from.id` 数值比较、**非** chat.id，design D4/D5）。默认空 = 无人可批 → 跨镜像 fail-closed：
  // proposer 须 MR_PRICE_CURATION_ENABLED 且本清单非空才注册 lane（否则发卡无人能批），
  // 接收侧缺清单即不 start bot（各由后续 group 门控）。非正整数条目启动即报错（守 env 不变量）。
  TELEGRAM_APPROVER_IDS: z
    .string()
    .default('')
    .transform((raw, ctx) => {
      const ids: number[] = [];
      for (const part of raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)) {
        const n = Number(part);
        if (!Number.isInteger(n) || n <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'TELEGRAM_APPROVER_IDS 条目「' +
              part +
              '」不是正整数 Telegram user id（逗号分隔的数值 id 清单，按 from.id 数值鉴权）。',
          });
          continue;
        }
        ids.push(n);
      }
      return ids;
    }),
  // 待批记录有效期（小时）：批准 CAS 谓词含 `extracted_at > now()-make_interval(hours => <此值>)`，
  // 闭合"泄漏令牌长期可用"窗口。**必须是正整数**——下游 approve 用它拼 make_interval（校验过的整数、
  // 非字面拼接），非法值（NaN/负/0/小数）启动即报错。默认 72（3 天，够人工批一次）。
  MR_PRICE_REVIEW_TTL_HOURS: z.coerce.number().int().positive().default(72),
})
  // 飞书配置完整性跨字段校验（feishu-push 5.1）：
  // - 两者均缺 → 飞书 disabled（向后兼容纯 Telegram 部署），放行；
  // - 两者全配 → enabled，放行；
  // - 仅配其一（不完整）→ 快速失败，禁止用空值发送或静默半启用。
  .superRefine((data, ctx) => {
    const hasUrl = Boolean(data.FEISHU_WEBHOOK_URL);
    const hasSecret = Boolean(data.FEISHU_SIGN_SECRET);
    if (hasUrl !== hasSecret) {
      const missing = hasUrl ? 'FEISHU_SIGN_SECRET' : 'FEISHU_WEBHOOK_URL';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [missing],
        message:
          `飞书通道配置不完整：FEISHU_WEBHOOK_URL 与 FEISHU_SIGN_SECRET 必须同时配置或同时缺省。` +
          `检测到仅配置了其中之一，缺少 ${missing}。` +
          `（飞书是可选通道：两者均不配则飞书 disabled、纯 Telegram 部署照常启动；` +
          `若要启用飞书须两者都填，禁止半启用用空值发送。）`,
      });
    }
  })
  // 首次启用防旧消息刷屏跨字段不变量（add-high-freq-p0-push，design D6，守 policy-push-timeliness）：
  // ALERT_SCAN_ENABLED='true' 但 ALERT_MIN_PUBLISHED_AT **未设置**（undefined——既非 ISO 亦非显式空串 opt-out）
  // → 启动即 fail-fast、拒绝注册告警链。把首次启用防刷屏守卫从「部署次序文档」升级为「代码强制」，
  // 防「启用却忘设基线 → 存量 P0 刷屏」这一 policy-push-timeliness 事故；运维须显式二选一。
  // 注：显式空串('') 是合法的「放弃基线」opt-out、不触发本闸（与 undefined 三态可分，见字段定义）。
  .superRefine((data, ctx) => {
    if (data.ALERT_SCAN_ENABLED === 'true' && data.ALERT_MIN_PUBLISHED_AT === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALERT_MIN_PUBLISHED_AT'],
        message:
          `实时告警已启用（ALERT_SCAN_ENABLED='true'）但未设置发布时间基线水位 ALERT_MIN_PUBLISHED_AT。` +
          `启用瞬间会把 published_at 近 N 天内、达阈值、从未告警的存量事件当作 P0 批量推送（刷屏，违反 policy-push-timeliness）。` +
          `请显式二选一：① 将 ALERT_MIN_PUBLISHED_AT 设为启用时刻的 ISO 时刻（如 new Date().toISOString()），只告警启用后发布的新闻；` +
          `② 设为显式空串('')明示放弃基线、自担旧消息刷屏风险。`,
      });
    }
  })
  // 并发评分原子 claim 回收阈值不变量（realtime-alerts / daily-intel-pipeline「降级逐条容错」）：
  // 回收阈值 T 必须 **严格 > L + W**（L=LLM_TIMEOUT_MS 单条 LLM 硬超时，W=JUDGE_WRITE_BUDGET_MS
  // 写分提交延迟上界）。否则正在合法评分/写分（总时长 < L+W）的事件可能被另一链路误回收 → 双评分覆写。
  // 启动期快速失败，禁止配出「会误回收慢评分」的危险阈值。
  .superRefine((data, ctx) => {
    const minReclaim = data.LLM_TIMEOUT_MS + data.JUDGE_WRITE_BUDGET_MS;
    if (data.JUDGE_CLAIM_RECLAIM_MS <= minReclaim) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JUDGE_CLAIM_RECLAIM_MS'],
        message:
          `并发评分 claim 回收阈值 T（JUDGE_CLAIM_RECLAIM_MS=${data.JUDGE_CLAIM_RECLAIM_MS}ms）` +
          `必须严格大于 L + W = LLM_TIMEOUT_MS(${data.LLM_TIMEOUT_MS}) + JUDGE_WRITE_BUDGET_MS(${data.JUDGE_WRITE_BUDGET_MS}) = ${minReclaim}ms。` +
          `否则正在合法评分/写分（总时长 < L+W）的事件会被另一链路误回收 → 双评分覆写。` +
          `请上调 JUDGE_CLAIM_RECLAIM_MS 到 > ${minReclaim}。`,
      });
    }
  })
  // 语义去重阈值序不变量（add-semantic-dedup-and-store-hardening，design D4）：
  // 灰区 = (SEMANTIC_DEDUP_LLM, SEMANTIC_DEDUP_HIGH]，必须 SEMANTIC_DEDUP_LLM < SEMANTIC_DEDUP_HIGH。
  // 若 LLM >= HIGH，灰区为空或反转——0.82–0.88 的「交 LLM 二次判断」档位失效，分流语义破坏。
  // 启动期快速失败，禁止配出阈值倒挂。
  .superRefine((data, ctx) => {
    if (data.SEMANTIC_DEDUP_LLM >= data.SEMANTIC_DEDUP_HIGH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SEMANTIC_DEDUP_LLM'],
        message:
          `语义去重阈值倒挂：SEMANTIC_DEDUP_LLM(${data.SEMANTIC_DEDUP_LLM}) 必须严格小于 ` +
          `SEMANTIC_DEDUP_HIGH(${data.SEMANTIC_DEDUP_HIGH})——LLM 灰区为 (LLM, HIGH]，` +
          `两者相等或倒挂会使「0.82–0.88 交 LLM 二次判断」档位为空，分流失效。`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * 解析并校验环境变量。校验失败时抛出聚合了全部缺失/非法字段的明确错误，
 * 而非静默返回部分值。
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `环境配置校验失败，应用无法启动。请对照 .env.example 补齐以下变量：\n${details}`,
    );
  }
  return result.data;
}

/**
 * 类型化、已校验的 env。其他模块直接 `import { env }`。
 * 模块首次被 import 时即执行校验——缺关键变量则在启动阶段立即 throw。
 */
export const env: Env = parseEnv(process.env);

/**
 * 飞书通道是否已配置（enabled）。已校验完整性（superRefine 保证不会半配），
 * 故只需判其一非空即等价于「两者全配」。供「已配置通道集」计算（feishu-push 5.1 / 5.3）：
 * 飞书未配置 → 不纳入分发通道集、纯 Telegram 部署照常启动；禁止用空值发送。
 *
 * @param e 已校验 env（默认全局 env；测试可注入解析后的局部 env）。
 */
export function isFeishuEnabled(e: Env = env): boolean {
  return Boolean(e.FEISHU_WEBHOOK_URL && e.FEISHU_SIGN_SECRET);
}

/**
 * 周报调度是否启用。默认禁用（暂缓打磨）；启用时 worker 才注册/启动 weekly-report 调度链。
 *
 * @param e 已校验 env（默认全局 env；测试可注入局部 env）。
 */
export function isWeeklyReportEnabled(e: Env = env): boolean {
  return e.WEEKLY_REPORT_ENABLED === 'true';
}

export function isAlertScanEnabled(e: Env = env): boolean {
  return e.ALERT_SCAN_ENABLED === 'true';
}

/**
 * 首次启用发布时间基线水位（守 policy-push-timeliness）：
 * 把已校验的 ALERT_MIN_PUBLISHED_AT 解析成 Date 一次，供告警候选查询加 `published_at >= 基线` 谓词。
 * 未设（undefined——仅当 ALERT_SCAN_ENABLED!='true'，否则 superRefine 已 fail-fast）或显式空串('')opt-out → null（无水位、不加谓词）；
 * ISO 时刻 → new Date(iso)。**在此解析一次**，调用方绝不在查询站点逐次 new Date。
 *
 * @param e 已校验 env（默认全局 env；测试可注入局部 env）。
 */
export function alertMinPublishedAt(e: Env = env): Date | null {
  return e.ALERT_MIN_PUBLISHED_AT ? new Date(e.ALERT_MIN_PUBLISHED_AT) : null;
}

/** Model Radar 5b 各调度链是否启用（默认禁用；worker-main 据此决定是否注册对应 BullMQ 链）。 */
export function isMrEventReviewEnabled(e: Env = env): boolean {
  return e.MR_EVENT_REVIEW_ENABLED === 'true';
}
export function isMrScrapeEnabled(e: Env = env): boolean {
  return e.MR_SCRAPE_ENABLED === 'true';
}
export function isMrStalenessEnabled(e: Env = env): boolean {
  return e.MR_STALENESS_ENABLED === 'true';
}

/**
 * Model Radar 价格 curation 一键批准是否启用（默认禁用）。
 *
 * 仅本侧开关。**跨镜像 fail-closed 由调用方组合判定**（design D4/D5）：
 * - proposer（worker）须 `isMrPriceCurationEnabled() && env.TELEGRAM_APPROVER_IDS.length > 0`
 *   才注册 lane——单查本侧开关不足以防"发卡而无人能批"，故还须显式确认批准白名单就绪。
 * - 接收侧（web）须 `env.TELEGRAM_APPROVER_IDS.length > 0` 才 `bot.start()`。
 * lane / bot 注册由后续 group 接线，此处只提供开关与已解析的 `TELEGRAM_APPROVER_IDS`。
 */
export function isMrPriceCurationEnabled(e: Env = env): boolean {
  return e.MR_PRICE_CURATION_ENABLED === 'true';
}

/**
 * 价格 curation 一键批准是否「就绪」：本侧开关开 **且** 批准白名单非空 **且** TELEGRAM_CHAT_ID 数值化
 * （否则 worker 发卡 string chatId 可达但 web 端 Number()→NaN 令 bot 静默不 start → 发卡无人能批）。
 * proposer（worker）与接收侧（web）的跨镜像 fail-closed 门控复用此判定（design D4/D5）。
 */
export function isMrPriceCurationApprovalReady(e: Env = env): boolean {
  return (
    isMrPriceCurationEnabled(e) &&
    e.TELEGRAM_APPROVER_IDS.length > 0 &&
    Number.isFinite(Number(e.TELEGRAM_CHAT_ID))
  );
}
