/**
 * 正文补全集成测试（任务 2.5）——需本地 Postgres（compose 起的库；缺 DATABASE_URL 整套件 skip）。
 *
 * **注入 fetchImpl / resolve 桩，全程不触网、不触真 DNS**；DB 是本地测试 pg（`!~ '\S'` 空谓词
 * 的 JS/Postgres trim 方言分歧只有真 pg 能暴露，故用集成测而非 mock db）。
 *
 * 覆盖 spec source-content-enrichment 场景 + design D1/D3：
 * - 空 content + 可抓公网 URL → 抓 og:description 原子写回（断言内容被填）。
 * - **纯空白 content 视同空**：输入含 '\t\n'（tab/换行，非仅空格），经**同一** `content !~ '\S'`
 *   谓词在工作集选取与写回两处一致 → 写回成功（断言内容被填，真正暴露方言分歧）。
 * - 已有非空 content 不覆盖（断言 DB 未变 + 该 URL 未被抓取）。
 * - 单条抓取失败隔离（断言失败条 content 仍空 AND 兄弟条仍被填）。
 * - 无可抓 URL / tombstone 事件跳过（断言不抓取、content 不变）。
 * - SSRF：URL 指向 169.254.169.254 / 内网 IP / 经 302 跳内网 / 域名解析到内网 → 被守卫拒绝、
 *   不写回、记失败计数、内网目标绝不被抓取。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { enrichRawItemContent } = await import('../content-enrichment.js');
type FetchResponseLike = import('../content-enrichment.js').FetchResponseLike;

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'content-enrichment-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

/** 默认 resolve 桩：任何主机 → 公网 TEST-NET-3 地址（保证不触真 DNS；IP 字面量 URL 根本不会调它）。 */
const publicResolve = async () => ['203.0.113.10'];

let seq = 0;
function uniq(tag: string): string {
  seq += 1;
  return `${tag}-${Date.now()}-${seq}`;
}

/** 造一条待判事件（代表 raw_item content 由入参精确控制）+ 返回 raw_item id 与它的抓取 URL。 */
async function seedCandidate(opts: {
  content: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
  mergedInto?: string | null;
}): Promise<bigint> {
  const sourceItemId = uniq('ri');
  const ri = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, canonical_url, title, content)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      SOURCE,
      sourceItemId,
      opts.url ?? null,
      opts.canonicalUrl ?? null,
      'seed title',
      opts.content,
    ],
  );
  const rawItemId = BigInt(ri.rows[0]!.id);
  await pool!.query(
    `INSERT INTO ai_news_events (dedup_key, representative_raw_item_id, representative_title, merged_into)
     VALUES ($1,$2,$3,$4)`,
    [uniq('dedup'), rawItemId.toString(), 'seed title', opts.mergedInto ?? null],
  );
  return rawItemId;
}

async function readContent(rawItemId: bigint): Promise<string | null> {
  const { rows } = await pool!.query<{ content: string | null }>(
    `SELECT content FROM raw_items WHERE id = $1`,
    [rawItemId],
  );
  return rows[0]!.content;
}

function htmlResponse(ogDescription: string): FetchResponseLike {
  return {
    status: 200,
    ok: true,
    headers: {
      get: (n) => (n.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
    },
    text: async () =>
      `<html><head><meta property="og:description" content="${ogDescription}" /></head></html>`,
  };
}

function redirectResponse(location: string): FetchResponseLike {
  return {
    status: 302,
    ok: false,
    headers: { get: (n) => (n.toLowerCase() === 'location' ? location : null) },
    text: async () => '',
  };
}

/** fetchImpl 桩：按 url 路由；未知 url 抛错（绝不填外部/兄弟套件的行，也证明「被跳过者未被抓取」）。 */
function makeFetchImpl(
  routes: Record<string, FetchResponseLike | (() => Promise<FetchResponseLike>)>,
) {
  const calledUrls: string[] = [];
  const fn = vi.fn(async (url: string): Promise<FetchResponseLike> => {
    calledUrls.push(url);
    const r = routes[url];
    if (r === undefined) throw new Error(`unknown URL (test stub): ${url}`);
    return typeof r === 'function' ? await r() : r;
  });
  return { fn: fn as unknown as import('../content-enrichment.js').FetchImplFn, calledUrls };
}

async function cleanup() {
  if (!pool) return;
  await pool.query(
    `DELETE FROM ai_news_events WHERE representative_raw_item_id IN
       (SELECT id FROM raw_items WHERE source = $1)`,
    [SOURCE],
  );
  await pool.query(`DELETE FROM raw_items WHERE source = $1`, [SOURCE]);
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('正文补全单条函数（enrichRawItemContent：补抓 + 原子写回 + SSRF 守卫）', () => {
  it('可抓公网 URL → og:description 原子写回，且**正文经返回值回传**（供本次判分）', async () => {
    const url = `http://93.184.216.34/${uniq('happy')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const { fn } = makeFetchImpl({ [url]: htmlResponse('Grounded AI content') });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      { fetchImpl: fn, resolve: publicResolve, logError: () => {} },
    );

    expect(result.status).toBe('hit');
    expect(result.content).toBe('Grounded AI content'); // **返回值**回传正文（不只写库）。
    expect(await readContent(id)).toBe('Grounded AI content');
  });

  it('补抓到全站样板 og:description → status=fail、content 保持空（不回注、不击穿下游护栏）', async () => {
    // 若原样写回 → content 变非空样板 → digest 的 hasContent 护栏不触发 → LLM 拿全站公司简介当正文；且该行
    // 永久离开工作集、样板成终身正文。故必须与采集器共享同一个 isSiteBoilerplate、写回前判样板。
    // 撇号用 &#x27; 实体（真页面形态；裸 ' 会在 content="…" 属性里撞 extractOgTag 的引号边界）。
    const boilerplate =
      'Anthropic is an AI safety and research company that&#x27;s working to build reliable, interpretable, and steerable AI systems.';
    const url = `http://93.184.216.34/${uniq('boiler')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const { fn } = makeFetchImpl({ [url]: htmlResponse(boilerplate) });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      { fetchImpl: fn, resolve: publicResolve, logError: () => {} },
    );

    expect(result.status).toBe('fail'); // 命中全站样板 → 按 fail 计。
    expect(result.content).toBeNull();
    expect(await readContent(id)).toBe(''); // content 保持为空——绝不回注样板。
  });

  it("纯空白 content（含 '\\t\\n'）→ 同一 !~ '\\S' 谓词写回成功", async () => {
    const url = `http://93.184.216.34/${uniq('ws')}`;
    // tab + 换行（非仅空格）：JS String.trim() 与 Postgres trim() 对它分歧；唯统一 `content !~ '\S'` 写回成功。
    const id = await seedCandidate({ content: '\t\n', canonicalUrl: url });
    const { fn } = makeFetchImpl({ [url]: htmlResponse('Filled from whitespace') });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      { fetchImpl: fn, resolve: publicResolve, logError: () => {} },
    );

    expect(result.status).toBe('hit');
    expect(await readContent(id)).toBe('Filled from whitespace');
  });

  it('写回命中 0 行（已被并发填充）→ 返回 DB 里既有正文（不是 null）、不覆盖', async () => {
    // 单条函数总会抓取（isEmpty 门在判分入口、不在此）；但写回受 EMPTY_CONTENT 挡下（content 已非空）
    // ⇒ 命中 0 行 ⇒ **返回既有正文**——该事件确有正文，判分不该退化仅标题。
    const url = `http://93.184.216.34/${uniq('concurrent')}`;
    const id = await seedCandidate({ content: 'Existing real content', canonicalUrl: url });
    const { fn } = makeFetchImpl({ [url]: htmlResponse('SHOULD NOT OVERWRITE') });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      { fetchImpl: fn, resolve: publicResolve, logError: () => {} },
    );

    expect(result.status).toBe('hit');
    expect(result.content).toBe('Existing real content'); // 返回既有正文，**不是** null、**不是**新抓的。
    expect(await readContent(id)).toBe('Existing real content'); // DB 未被覆盖。
  });

  it('写回命中 0 行 + logError 抛错 -> 仍返回既有正文（hit），不被 logError 改成 fail/null', async () => {
    // Codex round 3：try 块内的 logError（concurrent-fill 分支）若抛错，会使函数落入 catch -> 返回 fail/null，
    // 丢失既有正文。logError 已 try/catch 包裹 -> 返回值不受影响。
    const url = `http://93.184.216.34/${uniq('concurrent-throw-log')}`;
    const id = await seedCandidate({ content: 'Existing real content', canonicalUrl: url });
    const { fn } = makeFetchImpl({ [url]: htmlResponse('SHOULD NOT OVERWRITE') });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      {
        fetchImpl: fn,
        resolve: publicResolve,
        logError: () => { throw new Error('logError itself throws'); },
      },
    );

    expect(result.status).toBe('hit'); // 仍是 hit，不是 fail。
    expect(result.content).toBe('Existing real content'); // 既有正文不丢。
    expect(await readContent(id)).toBe('Existing real content');
  });

  it('抓取失败 → status=fail、content=null、绝不抛出', async () => {
    const url = `http://93.184.216.34/${uniq('boom')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const { fn } = makeFetchImpl({
      [url]: async () => {
        throw new Error('network boom');
      },
    });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      { fetchImpl: fn, resolve: publicResolve, logError: () => {} },
    );

    expect(result.status).toBe('fail');
    expect(result.content).toBeNull();
    expect(await readContent(id)).toBe(''); // 失败条 content 仍空。
  });

  it('整次补全一条 deadline：多跳 302 全部共用**同一个** AbortSignal（非每跳一个）', async () => {
    // 每跳各建一个 signal ⇒ 一次补全真实上限 (maxRedirects+1)×F，而 claim 回收按 F 记账、会误回收。
    const a = `http://93.184.216.34/${uniq('hop-a')}`;
    const b = `http://93.184.216.34/${uniq('hop-b')}`;
    const c = `http://93.184.216.34/${uniq('hop-c')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: a });
    const seenSignals: AbortSignal[] = [];
    const fn = vi.fn(async (url: string, init: { signal: AbortSignal }): Promise<FetchResponseLike> => {
      seenSignals.push(init.signal);
      if (url === a) return redirectResponse(b);
      if (url === b) return redirectResponse(c);
      return htmlResponse('after two redirects');
    });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: a },
      db!,
      {
        fetchImpl: fn as unknown as import('../content-enrichment.js').FetchImplFn,
        resolve: publicResolve,
        logError: () => {},
      },
    );

    expect(result.status).toBe('hit');
    expect(seenSignals.length).toBeGreaterThanOrEqual(3); // ≥3 跳
    // 所有跳收到的 signal 是**同一个引用**（整次一条 deadline）。
    for (const s of seenSignals) expect(s).toBe(seenSignals[0]);
  });

  // ── SSRF 守卫（单条函数口径）：目标为内网/元数据 → status=fail、内网目标绝不被抓取 ──
  const ssrfCases: Array<{ name: string; target: string; resolve?: () => Promise<string[]> }> = [
    { name: '169.254.169.254（云元数据）', target: 'http://169.254.169.254/latest/meta-data/' },
    {
      name: 'IPv4-mapped IPv6 压缩 hex（::ffff:a9fe:a9fe）',
      target: 'http://[::ffff:169.254.169.254]/latest/meta-data/',
    },
    { name: '内网 IP（10/8）', target: 'http://10.0.0.5/internal' },
    {
      name: '域名解析到内网（DNS rebinding）',
      target: `http://rebind.example.test/${uniq('rebind')}`,
      resolve: async () => ['10.1.2.3'],
    },
  ];
  for (const tc of ssrfCases) {
    it(`SSRF：${tc.name} → status=fail、不抓取`, async () => {
      const id = await seedCandidate({ content: '', canonicalUrl: tc.target });
      const { fn, calledUrls } = makeFetchImpl({ [tc.target]: htmlResponse('LEAKED') });

      const result = await enrichRawItemContent(
        { rawItemId: id, target: tc.target },
        db!,
        { fetchImpl: fn, resolve: tc.resolve ?? publicResolve, logError: () => {} },
      );

      expect(calledUrls).not.toContain(tc.target); // 发起前即被守卫拒绝、内网目标绝不被抓取。
      expect(result.status).toBe('fail');
      expect(await readContent(id)).toBe('');
    });
  }

  it('SSRF：公网 URL 经 302 跳内网 → 逐跳重校验拒绝、内网目标绝不被抓取', async () => {
    const originUrl = `http://93.184.216.34/${uniq('redir')}`;
    const internalUrl = 'http://10.0.0.5/internal';
    const id = await seedCandidate({ content: '', canonicalUrl: originUrl });
    const { fn, calledUrls } = makeFetchImpl({
      [originUrl]: redirectResponse(internalUrl),
      [internalUrl]: htmlResponse('LEAKED VIA REDIRECT'),
    });

    const result = await enrichRawItemContent(
      { rawItemId: id, target: originUrl },
      db!,
      { fetchImpl: fn, resolve: publicResolve, logError: () => {} },
    );

    expect(calledUrls).toContain(originUrl); // 首跳公网被放行
    expect(calledUrls).not.toContain(internalUrl); // 302 目标内网在下一跳被守卫拒绝、绝不抓取
    expect(result.status).toBe('fail');
    expect(await readContent(id)).toBe('');
  });

  it('6.11 结构性守卫：未注入 resolve -> 默认 dns.lookup 在 VITEST 下抛错（不发真实 DNS）', async () => {
    // 域名目标 ⇒ assertHostAllowed 调 resolve；未注入 ⇒ 默认 defaultResolve 在 VITEST 下 throw ⇒ status=fail、不出网。
    const url = `http://example.test/${uniq('guard-dns')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const logged: unknown[] = [];
    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      { logError: (_msg: string, detail?: unknown) => { logged.push(detail); } },
    );
    expect(result.status).toBe('fail');
    expect(await readContent(id)).toBe('');
    // 仅断言 status==='fail' 无法区分「守卫抛错」与「DNS 自然失败」（example.test 保留 TLD 也会 DNS 失败）--
    // 删掉守卫会让本用例静默通过并允许真实 DNS 出网。断言守卫消息使删除守卫时本用例变红。
    expect(logged.some((e) => e instanceof Error && /禁止真实 DNS 解析/.test(e.message))).toBe(true);
  });

  it('6.11 结构性守卫：未注入 fetchImpl -> 默认 global fetch 在 VITEST 下抛错（IP 目标跳过 DNS、直命中 fetch 守卫）', async () => {
    // 公网 IP 字面量目标 ⇒ 跳过 resolve、直到 fetchImpl；未注入 ⇒ 默认 defaultFetchImpl 在 VITEST 下 throw。
    const url = `http://93.184.216.34/${uniq('guard-fetch')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const fetchMock = vi.fn(async () => { throw new Error('mock: fetch 不应被调用--VITEST 守卫应在之前抛错'); });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const logged: unknown[] = [];
      const result = await enrichRawItemContent(
        { rawItemId: id, target: url },
        db!,
        { logError: (_msg: string, detail?: unknown) => { logged.push(detail); } },
      );
      expect(result.status).toBe('fail');
      expect(await readContent(id)).toBe('');
      // fetch 未被调用 + 守卫消息：删掉守卫会让 defaultFetchImpl 直调 globalThis.fetch（真实出网）。
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged.some((e) => e instanceof Error && /禁止真实 HTTP 抓取/.test(e.message))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('logError 自身抛错 -> enrichRawItemContent 仍不抛出（绝不抛出契约）', async () => {
    // 验证 Fix：catch 块里的 logError 若抛错（注入的 logError 可能抛、或 stderr 断裂），
    // enrichRawItemContent 自身仍不逃逸抛出--否则会击穿 scoreUnscoredEvents 的 fail-open、中断整批。
    const url = `http://example.test/${uniq('throw-log')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const result = await enrichRawItemContent(
      { rawItemId: id, target: url },
      db!,
      {
        resolve: async () => ['93.184.216.34'],
        fetchImpl: async () => { throw new Error('fetch failed'); },
        logError: () => { throw new Error('logError itself throws'); },
      },
    );
    expect(result.status).toBe('fail');
    expect(result.content).toBeNull();
    expect(await readContent(id)).toBe('');
  });
});
