/**
 * 判分/摘要前的确定性正文补全（source-content-enrichment，任务 2.2/2.3，仅新闻）。
 *
 * 对「待判新闻事件代表 raw_item `content` 为空/纯空白且有可抓 URL」者，抓取文章 HTML、取
 * `og:description` 写回 `raw_items.content`，供 Value Judge 判分与摘要器 grounding。
 *
 * 关键不变量（spec source-content-enrichment / design D1/D3，逐条守住）：
 * - **工作集与 `scoreUnscoredEvents` 判分集同口径**：`importance_score IS NULL AND
 *   merged_into IS NULL` 的事件，其代表 raw_item content 为空/纯空白且有 canonical_url/url。
 *   窄于判分集会致漏补事件仍被判分却退化仅标题（违反 value-judge 普遍约束）。
 * - **空定义单一谓词、选取与写回一字不差**：`content IS NULL OR content !~ '\S'`（无非空白
 *   字符即空白，等价 `btrim(content, E' \t\n\r\f\v')=''`）。禁止一处 JS `String.trim()`、
 *   一处 Postgres `trim()`——前者剥 tab/换行/Unicode 空白、后者仅 ASCII 空格，对 '\t\n' 分歧
 *   致选中却写回 0 行。此处用**同一个** `EMPTY_CONTENT` SQL 片段跨选取/写回，杜绝方言分歧。
 * - **原子判空写回**：`UPDATE ... WHERE id=? AND (content IS NULL OR content !~ '\S')`，0 行=
 *   已被并发填充（RSS/Ask HN 再抓）→ 跳过、良性；绝不「先 SELECT 判空后无条件 UPDATE」。
 * - **SSRF 出网守卫（提交者可控 URL）**：补抓 URL 源自 HN/Show HN/PH/RSS 等外部提交者可控内容，
 *   与 sitemap 的一方 Anthropic URL 不同信任级。`defaultFetchArticle` 无 host/IP 守卫且默认
 *   `redirect:'follow'`——**绝不裸调它随访**。本模块自带受控抓取：发起前拒私网/环回/链路本地/
 *   云元数据地址，`redirect:'manual'` 逐跳 host 重校验（防 302 跳内网绕过首跳校验）。
 * - **逐条隔离、best-effort、永不拖垮流水线**：单条失败 try/catch、记日志、content 保持为空、
 *   继续下一条；整阶段不抛错、不进熔断分母（分母口径由编排层维持不变）。
 *
 * 复用 `extractOgTag` + `MAX_BODY_BYTES`（sitemap.ts 导出）与 `env.COLLECTOR_FETCH_TIMEOUT_MS`
 * 的校验逻辑（2xx / content-type html / 大小 / 超时），不引 readability/jsdom 新依赖。
 *
 * ponytail: 只取 og:description，不做「有限正文文本」回退（spec 用「可退回」非「必须」）——
 * og 缺失即按失败处理、下游退化仅标题；真需要正文抽取再引专用解析（YAGNI）。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, rawItems } from '../db/schema.js';
import { env } from '../config/env.js';
import { extractOgTag, MAX_BODY_BYTES } from '../collectors/sitemap.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 单跳 fetch 响应的最小契约（global fetch 的 Response 天然满足；测试桩返此形即可）。 */
export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** 单跳 fetch 契约（默认 global fetch）；受控抓取逐跳调用它并自带 redirect:'manual' + SSRF 守卫。 */
export type FetchImplFn = (
  url: string,
  init: {
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** 主机名 → IP 列表解析契约（默认 dns.lookup(all)）；使单测可注入、不触真 DNS。 */
export type ResolveFn = (host: string) => Promise<string[]>;

export interface EnrichContentOptions {
  /** 注入的单跳 fetch 实现（默认 global fetch）。 */
  fetchImpl?: FetchImplFn | undefined;
  /** 注入的主机名解析实现（默认 dns.lookup all）。 */
  resolve?: ResolveFn | undefined;
  /** 错误日志 sink。 */
  logError?: ((message: string, detail?: unknown) => void) | undefined;
  /** 最大跳转次数（防重定向环）。 */
  maxRedirects?: number | undefined;
}

export interface EnrichContentResult {
  /** 成功抓取 og:description 并原子写回（命中非 0 行）的条目数。 */
  hit: number;
  /** 失败条目数（网络错误/非 2xx/非 HTML/超限/超时/og 缺失/**被 SSRF 守卫拒绝**）。 */
  fail: number;
}

/**
 * 空/纯空白单一谓词（Postgres POSIX：`!~ '\S'` = 无非空白字符 = 空/纯空白）。
 * **工作集选取与原子写回复用同一 SQL 对象**，保证「一字不差」、杜绝 JS/Postgres trim 方言分歧。
 * 源码 `'\\S'` → 生成 SQL `'\S'`（drizzle 用 cooked 模板串）。
 */
const EMPTY_CONTENT = sql`(${rawItems.content} IS NULL OR ${rawItems.content} !~ '\\S')`;

/** 被 SSRF 出网守卫拒绝（私网/环回/链路本地/元数据/非公网主机）时抛出，供日志区分。 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * IPv4 是否为拒绝地址（私网/环回/链路本地含元数据/未指定）。畸形串一律拒（保守）。
 * 覆盖 spec 枚举：127/8、10/8、172.16/12、192.168/16、169.254/16（含 169.254.169.254）+ 0/8。
 */
function isDeniedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 未指定
  if (a === 127) return true; // 环回
  if (a === 10) return true; // 私网
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地（含 169.254.169.254 云元数据）
  return false;
}

/**
 * IPv6 是否为拒绝地址（::1 环回、:: 未指定、fc00::/7 唯一本地、fe80::/10 链路本地、
 * IPv4-mapped ::ffff:a.b.c.d 内嵌 v4 复判）。畸形一律拒。
 */
function isDeniedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isDeniedIpv4(mapped[1]!);
  // IPv4-mapped **十六进制**形态：Node WHATWG URL 把 `[::ffff:127.0.0.1]` 归一为 `::ffff:7f00:1`
  // （压缩 hex，非点分十进制）——仅匹配点分会漏放内网/环回/元数据（如 ::ffff:a9fe:a9fe=169.254.169.254）。
  // 取末 32 位两组 hex → 还原 4 字节 IPv4 → 复用 isDeniedIpv4。
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return isDeniedIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  if (/^f[cd][0-9a-f]{2}(:|$)/.test(lower)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f](:|$)/.test(lower)) return true; // fe80::/10
  return false;
}

/** 某个 IP 字面量（v4/v6）是否被拒；无法识别为 IP → 拒（保守）。 */
function isDeniedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isDeniedIpv4(ip);
  if (kind === 6) return isDeniedIpv6(ip);
  return true;
}

/**
 * SSRF 出网守卫：校验单个 URL 的主机为公网可抓（发起前 / 每一跳调用）。
 * - 非 http(s) 协议直接拒。
 * - 主机为 IP 字面量 → 直接按 denylist 判（无需 DNS）。
 * - 主机为域名 → 经 resolve 解析全部 IP，任一为私网/拒绝地址即拒（挡 DNS-rebinding/内网别名）。
 *
 * ponytail: resolve→check 后 fetch 会再解析一次，存在 rebinding TOCTOU 残窗；根除需 pin 到已解析
 * IP + Host 头连接（自定义 dispatcher）。本期 best-effort 守卫足以挡直连内网/元数据，残窗记为已知
 * 天花板，真受攻击面上升再上 pinned-IP 连接。
 */
async function assertHostAllowed(urlStr: string, resolve: ResolveFn): Promise<void> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new SsrfBlockedError(`SSRF 守卫：无法解析 URL ${urlStr}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfBlockedError(`SSRF 守卫：非 http(s) 协议 ${u.protocol} for ${urlStr}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // 去 IPv6 字面量方括号
  if (isIP(host) !== 0) {
    if (isDeniedIp(host)) {
      throw new SsrfBlockedError(`SSRF 守卫：主机 ${host} 为私网/环回/链路本地/元数据地址`);
    }
    return;
  }
  // 域名：解析全部 IP，任一被拒即拒。
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch (err) {
    throw new SsrfBlockedError(`SSRF 守卫：主机 ${host} 解析失败：${String(err)}`);
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError(`SSRF 守卫：主机 ${host} 无法解析为任何地址`);
  }
  for (const addr of addrs) {
    if (isDeniedIp(addr)) {
      throw new SsrfBlockedError(
        `SSRF 守卫：主机 ${host} 解析到私网/拒绝地址 ${addr}`,
      );
    }
  }
}

/** dns.lookup(all) 默认解析实现：返回主机的全部 A/AAAA 地址。 */
const defaultResolve: ResolveFn = async (host) => {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
};

/**
 * 受控 SSRF-safe 文章抓取：逐跳 `redirect:'manual'` + 每跳 host 重校验，复用
 * defaultFetchArticle 的 2xx/content-type html/大小/超时**校验逻辑**（不裸调它随访）。
 * 返回文章 HTML 文本；任何校验/守卫失败抛错（由上层 try/catch 计入 fail）。
 */
async function fetchArticleGuarded(
  urlStr: string,
  fetchImpl: FetchImplFn,
  resolve: ResolveFn,
  maxRedirects: number,
): Promise<string> {
  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 每一跳发起前重校验 host（防 302 跳内网/元数据绕过首跳校验）。
    await assertHostAllowed(current, resolve);
    const res = await fetchImpl(current, {
      headers: { 'User-Agent': 'ai-radar (content enrichment)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
    });
    // 3xx：读 Location、拼绝对 URL，进入下一跳（循环顶部重校验新 host）。
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`重定向 ${res.status} 缺 Location for ${current}`);
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) {
      throw new Error(`article ${res.status} for ${current}`);
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('html')) {
      throw new Error(`article content-type 非 HTML（${contentType || '缺失'}）for ${current}`);
    }
    const cl = Number(res.headers.get('content-length') ?? 0);
    if (cl > MAX_BODY_BYTES) {
      throw new Error(`article body content-length ${cl} 超 ${MAX_BODY_BYTES} 字节上限`);
    }
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Error(`article body 超 ${MAX_BODY_BYTES} 字节上限 for ${current}`);
    }
    return text;
  }
  throw new Error(`重定向跳数超上限（${maxRedirects}）for ${urlStr}`);
}

/**
 * 对待判新闻事件代表 raw_item 做一次确定性正文补全。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 * @returns `{hit, fail}` 命中/失败计数。整阶段永不抛错（逐条 try/catch 隔离）。
 */
export async function enrichCandidateContent(
  dbh: DbLike = defaultDb,
  options: EnrichContentOptions = {},
): Promise<EnrichContentResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImplFn);
  const resolve = options.resolve ?? defaultResolve;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[content-enrichment] ${message}`, detail));
  const maxRedirects = options.maxRedirects ?? 5;

  // 工作集：与 scoreUnscoredEvents 判分集同口径（importance_score IS NULL AND merged_into IS NULL），
  // 其代表 raw_item content 为空/纯空白（EMPTY_CONTENT）且有可抓 URL（canonical_url 或 url 非空）。
  const candidates = await dbh
    .select({
      rawItemId: rawItems.id,
      canonicalUrl: rawItems.canonicalUrl,
      url: rawItems.url,
    })
    .from(aiNewsEvents)
    .innerJoin(rawItems, eq(aiNewsEvents.representativeRawItemId, rawItems.id))
    .where(
      and(
        isNull(aiNewsEvents.importanceScore),
        isNull(aiNewsEvents.mergedInto),
        EMPTY_CONTENT,
        sql`(${rawItems.canonicalUrl} IS NOT NULL OR ${rawItems.url} IS NOT NULL)`,
      ),
    );

  let hit = 0;
  let fail = 0;

  for (const cand of candidates) {
    // 优先 canonical_url（已去追踪参数、规范化），回退原始 url。
    const target = cand.canonicalUrl ?? cand.url;
    if (!target) continue; // WHERE 已保证有 URL；防御性跳过、不产生外部请求。
    try {
      const html = await fetchArticleGuarded(target, fetchImpl, resolve, maxRedirects);
      const description = extractOgTag(html, 'og:description');
      if (!description) {
        // og:description 缺失/空：按失败处理，content 保持为空，下游退化仅标题。
        fail += 1;
        logError(`补抓 og:description 缺失（content 保持为空，退化仅标题）：${target}`, null);
        continue;
      }
      // 原子判空写回：命中 0 行 = 已被并发填充（RSS/Ask HN 再抓），跳过、良性、不计 hit/fail。
      const updated = await dbh
        .update(rawItems)
        .set({ content: description })
        .where(and(eq(rawItems.id, cand.rawItemId), EMPTY_CONTENT))
        .returning({ id: rawItems.id });
      if (updated.length === 0) {
        logError(
          `补抓写回命中 0 行（已被并发填充，跳过，不覆盖）：raw_item ${cand.rawItemId}`,
          null,
        );
        continue;
      }
      hit += 1;
    } catch (err) {
      // 单条失败（网络/非 2xx/非 HTML/超限/超时/SSRF 拒绝）：隔离、记日志、content 保持为空、继续。
      fail += 1;
      const prefix =
        err instanceof SsrfBlockedError
          ? '补抓被 SSRF 守卫拒绝（不抓内网/元数据，content 保持为空）'
          : '补抓失败（跳过该条，content 保持为空）';
      logError(`${prefix}：${target}`, err);
    }
  }

  return { hit, fail };
}
