/**
 * Hugging Face Papers 采集器（add-tier1-ai-sources / design D2、spec「需求:Hugging Face Papers 采集」）。
 *
 * 经 **HF 官方 JSON API**（`GET https://huggingface.co/api/daily_papers`，**无鉴权**）拉每日精选论文，
 * 映射为统一 `CollectedItem`（`source='hugging_face_papers'`、`rawType='paper'`、`collapsed=true`）作
 * **数据沉淀源**（与 arXiv 同口径）。
 *
 * 不变量（spec / design D2）：
 * - **论文仅沉淀**：每条 `collapsed=true` 入库即标「已按 raw_type 路由/沉淀」，事件塌缩按类型路由
 *   排除 `paper`（dedup/collapse.ts `IS DISTINCT FROM 'paper'`），不进事件/日报/推送（论文板块留 P3）。
 *   `hugging_face_papers` 不入 `REALTIME_NEWS_SOURCES`（非实时）/`PRODUCT_SOURCES`（非产品）。
 * - **缺字段跳过（M-B，比照 arxiv.ts:195「无 identifier 跳过」）**：`paper.id` 缺失/null/空串 →
 *   跳过该条 + 记日志，**绝不** `String(null|undefined)`（否则产 `'null'`/`'undefined'` 假 source_item_id
 *   绕过 store 空 id 校验、互相 `ON CONFLICT` 吞掉致静默丢数据）；`paper.title` 缺失/空串 → 跳过该条 +
 *   记日志（`raw_items.title` NOT NULL，无合理回退源时不降级、不写空 title）。
 * - **publishedAt 复用 arxiv `toDate` NaN 守卫**（NIT-4，避免多套时间解析）：`paper.publishedAt` 为有效
 *   日期则 Date，否则 null。
 * - **来源身份由 metadata 承载**：HF 为 JSON API 源（非 RSS），不受 RSS vendor-provenance 不变量约束，
 *   来源身份由 `metadata` 的 `organization`/`submittedBy`/`hf_paper_id` 承载（无 `metadata.vendor`）。
 * - 外部调用经 `withRetry`（有限重试 + 错误日志）；整源失败抛出由编排层 `Promise.allSettled` 隔离。
 *   HF daily_papers 无鉴权、401/403 极罕见，用简单 withRetry 不精分错误码（design D2 accepted-degraded）。
 *
 * 依赖注入：`fetchJson`（默认 global fetch + 超时）使单测不触网；`maxPerRun` 可注入便于测截断。
 */
import { env } from '../config/env.js';
import { toDate } from './arxiv.js';
import {
  defaultLogError,
  stripUnsafeChars,
  withRetry,
  type CollectedItem,
  type LogError,
} from './types.js';

/** HF daily_papers 端点（官方 JSON API，无鉴权）。 */
const HF_DAILY_PAPERS_URL = 'https://huggingface.co/api/daily_papers';

/** daily_papers 单元素内嵌套的 `paper` 子对象的最小视图（字段名由真实响应 fixture 固化）。 */
export interface HfPaper {
  /** HF 稳定论文 id（多为 arXiv id）→ source_item_id；缺失/空时跳过该条。 */
  id?: string | number | null;
  /** 标题（raw_items.title NOT NULL；缺失/空时跳过该条）。 */
  title?: string | null;
  /** 摘要 → content。 */
  summary?: string | null;
  /** 发布时间（经 toDate NaN 守卫解析；有效则 Date 否则 null）。 */
  publishedAt?: string | null;
  /** 论文所属机构（防御性可选读取；可得才填入 metadata.organization，FIX-9）。 */
  organization?: string | null;
}

/** daily_papers 数组的单元素的最小视图（嵌套 paper 子对象 + 元素级字段）。 */
export interface HfDailyPaperEntry {
  /** 嵌套的论文子对象（核心字段所在）。 */
  paper?: HfPaper | null;
  /** 提交者（元素级，透传 metadata）。 */
  submittedBy?: { name?: string | null; fullname?: string | null } | string | null;
  /** 评论数（元素级，透传 metadata）。 */
  numComments?: number | null;
  /** 论文所属机构（元素级，防御性可选读取；可得才填入 metadata.organization，FIX-9）。 */
  organization?: string | null;
}

/** 抓取任意 JSON 的依赖契约（默认 global fetch + 超时；可注入 mock）。 */
export type FetchJsonFn = (url: string) => Promise<unknown>;

export interface HfPapersCollectorOptions {
  /** 注入的 JSON 抓取实现，默认 global fetch + 超时。 */
  fetchJson?: FetchJsonFn | undefined;
  /** 单轮采集上限，默认 env.HF_PAPERS_MAX_PER_RUN。 */
  maxPerRun?: number | undefined;
  /** 每次外部调用最大重试次数。 */
  maxAttempts?: number | undefined;
  /** 重试基础退避毫秒。 */
  baseDelayMs?: number | undefined;
  /** 错误日志 sink。 */
  logError?: LogError | undefined;
  /** 注入 sleep（测试免等待）。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultFetchJson: FetchJsonFn = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ai-radar (hf daily_papers collector)' },
    signal: AbortSignal.timeout(env.COLLECTOR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HF daily_papers ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
};

/**
 * 从已确认为数组的 body 过滤出对象元素（仅过滤，不判数组——非数组守卫在 collectHfPapers 调用处，FIX-4）。
 */
function extractEntries(body: unknown[]): HfDailyPaperEntry[] {
  const out: HfDailyPaperEntry[] = [];
  for (const e of body) {
    if (e && typeof e === 'object') out.push(e as HfDailyPaperEntry);
  }
  return out;
}

/**
 * 安全取可空字段的 trim 串：**非字符串（数字/对象/布尔/null/undefined）→ ''**。
 * HF API 若对 title/summary/organization 返非字符串，裸 `?.trim()` 会抛 TypeError 拖垮整个
 * `hugging_face_papers` 源（而非按 M-B 逐行跳过坏行）；本守卫把非字符串归一为空串、交由各字段的
 * 空值处理（title 空→跳过 / content 空→null / organization 空→不写）。
 */
function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 从 submittedBy（对象/字符串/缺失）安全取提交者名，无则 null（字段非字符串时不崩）。 */
function extractSubmittedBy(submittedBy: HfDailyPaperEntry['submittedBy']): string | null {
  if (typeof submittedBy === 'string') return submittedBy.trim() || null;
  if (submittedBy && typeof submittedBy === 'object') {
    const name = asTrimmedString(submittedBy.fullname) || asTrimmedString(submittedBy.name);
    return name || null;
  }
  return null;
}

/**
 * 采集 HF daily_papers → 统一结构（先落 raw_items 由编排层入库作沉淀）。
 *
 * - 缺 id / 缺 title 的条目跳过不发射（记日志），其余合法条目正常映射（M-B）。
 * - 取前 maxPerRun 条；整源调用失败（超时 / 非 2xx / 解析错）经 withRetry 重试耗尽后抛出，
 *   由编排层 `Promise.allSettled` 隔离、不拖垮整批。
 */
export async function collectHfPapers(
  options: HfPapersCollectorOptions = {},
): Promise<CollectedItem[]> {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const maxPerRun = options.maxPerRun ?? env.HF_PAPERS_MAX_PER_RUN;
  const logError = options.logError ?? defaultLogError;

  const body = await withRetry(() => fetchJson(HF_DAILY_PAPERS_URL), {
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs,
    logError,
    sleep: options.sleep,
    label: 'hugging_face_papers:daily_papers',
  });

  // FIX-4：非数组 body（疑似错误体，如 {error:'...'}）→ logError + throw，判源失败（对称 sitemap 的
  // loc_count=0 throw）。绝不静默返 [] 上报「成功 0 条」，否则编排层误记 ok=true 掩盖站点/接口异常。
  if (!Array.isArray(body)) {
    logError('hugging_face_papers daily_papers 响应非数组（疑似错误体），判源失败', { body });
    throw new Error('HF daily_papers 响应非数组（疑似错误体），判源失败');
  }

  const items: CollectedItem[] = [];
  // 取前 maxPerRun 条（截断在跳过判定前——与「单轮条数上限」语义一致，对返回顺序取头部）。
  for (const entry of extractEntries(body).slice(0, maxPerRun)) {
    const paper = entry.paper;
    if (!paper || typeof paper !== 'object') {
      logError('hugging_face_papers 条目缺 paper 子对象，跳过不发射', entry);
      continue;
    }

    // 缺 id 跳过（M-B）：null/undefined/空串/纯空白 → 跳过，绝不 String(null|undefined) 产假 id。
    const rawId = paper.id;
    const id = stripUnsafeChars(
      typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === 'string'
          ? rawId.trim()
          : '',
    );
    // strip 后再判空：全控制符 id（strip 致空）→ 跳过该条，绝不产假 id（保 M-B 语义）。
    if (id.length === 0) {
      logError('hugging_face_papers 条目缺 paper.id，跳过不发射（绝不产假 id）', { paper });
      continue;
    }

    // 缺 title 跳过（M-B）：title NOT NULL，无合理回退源时不降级、不写空 title。
    // asTrimmedString 防 paper.title 为非字符串时 .trim() 崩整个源（Bugbot #4）→ 非字符串归 '' → 跳过该行。
    const title = stripUnsafeChars(asTrimmedString(paper.title));
    // strip 后再判空：含危险字节的 title 经 strip 致空 → 跳过该条（不写空/退化 title）。
    if (title.length === 0) {
      logError('hugging_face_papers 条目缺 paper.title，跳过不发射（title NOT NULL 不降级）', {
        hf_paper_id: id,
      });
      continue;
    }

    const submittedBy = extractSubmittedBy(entry.submittedBy);
    const metadata: Record<string, unknown> = { hf_paper_id: id };
    // metadata 字符串值同样净化危险字节（jsonb INSERT 遇 NUL 会 REJECT 整批、lone surrogate 破坏 JSON.stringify）。
    if (submittedBy) metadata.submittedBy = stripUnsafeChars(submittedBy);
    if (typeof entry.numComments === 'number') metadata.num_comments = entry.numComments;
    // FIX-9：organization「可得才放」——元素级或 paper 子对象含非空 organization 则填 metadata.organization，
    // 否则不写该键（防御性可选读取，无则保持 metadata 不含 organization）。
    // asTrimmedString 防非字符串 .trim() 崩（Bugbot #4）；`||` 使元素级空/非字符串时回退 paper 级（顺带修元素级空串遮蔽 paper 级有效值）。
    const organization = asTrimmedString(entry.organization) || asTrimmedString(paper.organization);
    if (organization) metadata.organization = stripUnsafeChars(organization);

    // content：trim 后净化危险字节；strip 致空（全控制符 summary）→ null（content 可空，不写空串）。
    // asTrimmedString 防 paper.summary 为非字符串时 .trim() 崩（Bugbot #4）→ 非字符串归 '' → content null。
    const summary = asTrimmedString(paper.summary);
    const content = summary ? stripUnsafeChars(summary) || null : null;

    items.push({
      source: 'hugging_face_papers',
      sourceItemId: id,
      url: `https://huggingface.co/papers/${id}`,
      title,
      content,
      // publishedAt 复用 arxiv toDate NaN 守卫（NIT-4）：有效日期则 Date 否则 null。
      publishedAt: toDate(paper.publishedAt ?? null),
      rawType: 'paper',
      // P2：论文仅沉淀，入库即置 collapsed=true（无下游消费、不每轮重扫，与 arXiv 同口径）。
      collapsed: true,
      metadata,
    });
  }

  return items;
}
