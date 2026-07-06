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

const { enrichCandidateContent } = await import('../content-enrichment.js');
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

describe.skipIf(!databaseUrl)('正文补全（补抓 + 原子写回 + SSRF 守卫）', () => {
  it('空 content + 可抓公网 URL → og:description 原子写回', async () => {
    const url = `http://93.184.216.34/${uniq('happy')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const { fn } = makeFetchImpl({ [url]: htmlResponse('Grounded AI content') });

    const result = await enrichCandidateContent(db!, {
      fetchImpl: fn,
      resolve: publicResolve,
      logError: () => {},
    });

    expect(result.hit).toBeGreaterThanOrEqual(1);
    expect(await readContent(id)).toBe('Grounded AI content');
  });

  it("纯空白 content（含 '\\t\\n'）视同空 → 同一 !~ '\\S' 谓词写回成功", async () => {
    const url = `http://93.184.216.34/${uniq('ws')}`;
    // 关键输入：tab + 换行（非仅空格）。JS String.trim() 与 Postgres trim() 对它分歧；
    // 唯有统一用 `content !~ '\S'` 才能既选中又写回成功。
    const id = await seedCandidate({ content: '\t\n', canonicalUrl: url });
    const { fn, calledUrls } = makeFetchImpl({ [url]: htmlResponse('Filled from whitespace') });

    const result = await enrichCandidateContent(db!, {
      fetchImpl: fn,
      resolve: publicResolve,
      logError: () => {},
    });

    // 被工作集选中（抓取发生）+ 写回命中非 0 行（内容被填）。
    expect(calledUrls).toContain(url);
    expect(result.hit).toBeGreaterThanOrEqual(1);
    expect(await readContent(id)).toBe('Filled from whitespace');
  });

  it('已有非空 content 不被覆盖（DB 未变 + 该 URL 未被抓取）', async () => {
    const url = `http://93.184.216.34/${uniq('keep')}`;
    const id = await seedCandidate({ content: 'Existing real content', canonicalUrl: url });
    const { fn, calledUrls } = makeFetchImpl({ [url]: htmlResponse('SHOULD NOT WRITE') });

    await enrichCandidateContent(db!, { fetchImpl: fn, resolve: publicResolve, logError: () => {} });

    expect(calledUrls).not.toContain(url); // 非空 content 不进工作集，绝不抓取
    expect(await readContent(id)).toBe('Existing real content'); // DB 未变
  });

  it('单条抓取失败隔离：失败条 content 仍空 AND 兄弟条仍被填', async () => {
    const okUrl = `http://93.184.216.34/${uniq('ok')}`;
    const boomUrl = `http://93.184.216.34/${uniq('boom')}`;
    const okId = await seedCandidate({ content: '', canonicalUrl: okUrl });
    const boomId = await seedCandidate({ content: '', canonicalUrl: boomUrl });
    const { fn, calledUrls } = makeFetchImpl({
      [okUrl]: htmlResponse('Sibling filled'),
      [boomUrl]: async () => {
        throw new Error('network boom');
      },
    });

    const result = await enrichCandidateContent(db!, {
      fetchImpl: fn,
      resolve: publicResolve,
      logError: () => {},
    });

    expect(calledUrls).toContain(boomUrl); // 失败条确实被尝试
    expect(await readContent(boomId)).toBe(''); // 失败条 content 仍空
    expect(await readContent(okId)).toBe('Sibling filled'); // 兄弟条仍被处理写回
    expect(result.hit).toBeGreaterThanOrEqual(1);
    expect(result.fail).toBeGreaterThanOrEqual(1);
  });

  it('无可抓 URL 的事件跳过（不抓取、content 不变）', async () => {
    const id = await seedCandidate({ content: '', url: null, canonicalUrl: null });
    const { fn, calledUrls } = makeFetchImpl({});

    await enrichCandidateContent(db!, { fetchImpl: fn, resolve: publicResolve, logError: () => {} });

    expect(calledUrls).toHaveLength(0);
    expect(await readContent(id)).toBe('');
  });

  it('tombstone 事件（merged_into 非空）跳过（不抓取、content 不变）', async () => {
    const url = `http://93.184.216.34/${uniq('tomb')}`;
    const id = await seedCandidate({
      content: '',
      canonicalUrl: url,
      mergedInto: 'some-survivor-event-id',
    });
    const { fn, calledUrls } = makeFetchImpl({ [url]: htmlResponse('SHOULD NOT WRITE') });

    await enrichCandidateContent(db!, { fetchImpl: fn, resolve: publicResolve, logError: () => {} });

    expect(calledUrls).not.toContain(url);
    expect(await readContent(id)).toBe('');
  });

  it('SSRF：URL 指向 169.254.169.254（云元数据）→ 拒绝、不抓取、记失败', async () => {
    const url = 'http://169.254.169.254/latest/meta-data/';
    const id = await seedCandidate({ content: '', url });
    const { fn, calledUrls } = makeFetchImpl({ [url]: htmlResponse('LEAKED METADATA') });

    const result = await enrichCandidateContent(db!, {
      fetchImpl: fn,
      resolve: publicResolve,
      logError: () => {},
    });

    expect(calledUrls).not.toContain(url); // 发起前即被守卫拒绝，绝不抓取内网/元数据
    expect(await readContent(id)).toBe('');
    expect(result.fail).toBeGreaterThanOrEqual(1);
  });

  it('SSRF：URL 指向内网 IP（10/8）→ 拒绝、不抓取、记失败', async () => {
    const url = 'http://10.0.0.5/internal';
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const { fn, calledUrls } = makeFetchImpl({ [url]: htmlResponse('LEAKED INTERNAL') });

    const result = await enrichCandidateContent(db!, {
      fetchImpl: fn,
      resolve: publicResolve,
      logError: () => {},
    });

    expect(calledUrls).not.toContain(url);
    expect(await readContent(id)).toBe('');
    expect(result.fail).toBeGreaterThanOrEqual(1);
  });

  it('SSRF：公网 URL 经 302 跳内网 → 逐跳重校验拒绝、内网目标绝不被抓取', async () => {
    const originUrl = `http://93.184.216.34/${uniq('redir')}`;
    const internalUrl = 'http://10.0.0.5/internal';
    const id = await seedCandidate({ content: '', canonicalUrl: originUrl });
    const { fn, calledUrls } = makeFetchImpl({
      [originUrl]: redirectResponse(internalUrl),
      [internalUrl]: htmlResponse('LEAKED VIA REDIRECT'),
    });

    const result = await enrichCandidateContent(db!, {
      fetchImpl: fn,
      resolve: publicResolve,
      logError: () => {},
    });

    expect(calledUrls).toContain(originUrl); // 首跳公网被放行
    expect(calledUrls).not.toContain(internalUrl); // 302 目标内网在下一跳被守卫拒绝、绝不抓取
    expect(await readContent(id)).toBe('');
    expect(result.fail).toBeGreaterThanOrEqual(1);
  });

  it('SSRF：域名解析到内网 IP（DNS rebinding）→ 拒绝、不抓取、记失败', async () => {
    const url = `http://rebind.example.test/${uniq('rebind')}`;
    const id = await seedCandidate({ content: '', canonicalUrl: url });
    const { fn, calledUrls } = makeFetchImpl({ [url]: htmlResponse('LEAKED VIA DNS') });

    const result = await enrichCandidateContent(db!, {
      fetchImpl: fn,
      resolve: async () => ['10.1.2.3'], // 主机解析到私网 → 守卫应拒
      logError: () => {},
    });

    expect(calledUrls).not.toContain(url);
    expect(await readContent(id)).toBe('');
    expect(result.fail).toBeGreaterThanOrEqual(1);
  });
});
