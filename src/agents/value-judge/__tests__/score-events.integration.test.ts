/**
 * Value Judge 接入流水线集成测试（任务 6.3）——需本地 Postgres（compose 起的库）。
 *
 * 验证 spec「评分按映射写入真实事件并可读回」+ design D8 的核心不变量：
 * - 用 collapseRawItem 造**真实事件行**（塌缩首建 event_id / representative_* / first_seen_at /
 *   published_at），再对其 scoreUnscoredEvents 写分，读回各 *_score 与 Agent 输出一致（往返）。
 * - 写分用 `UPDATE ... WHERE event_id = ?` 仅改 *_score + should_push：断言塌缩首建的
 *   event_id / representative_raw_item_id / representative_title / first_seen_at / published_at /
 *   source_count 在评分后**不变**（不被覆盖致 Top N 退化）。
 * - 单条 judge 校验失败 → 降级跳过 + degraded_count++ + **不落库未校验数据**（该事件 *_score 仍 NULL）。
 * - 已评分事件（*_score 非 NULL）跳过不重判（不重复 LLM 调用、不覆盖旧分）。
 *
 * generateObjectFn 全程注入 mock，不依赖真实 LLM key；DATABASE_URL 缺则整套件 skip。
 * 每个用例用唯一 source_item_id 前缀隔离，afterAll 清理本套件造的行。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema.js';

// score-events.js / collapse.js 间接 import config/env（启动期校验全部必填变量）。
// 本套件 mock LLM、不发推送，为推送/LLM 相关变量注入占位（||= 兼容空串）；
// 真实 DATABASE_URL 仍由 .env / CI 注入（缺则整套件 skip）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
process.env.REDIS_URL ||= 'redis://localhost:6379';

const { collapseRawItem } = await import('../../../dedup/collapse.js');
const { scoreUnscoredEvents } = await import('../score-events.js');

const databaseUrl = process.env.DATABASE_URL;

const SOURCE = 'score-events-itest';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const VALID_OUTPUT = {
  is_ai_related: true,
  type: 'ai_product',
  category: 'AI Coding',
  importance: 82,
  novelty: 75,
  developer_relevance: 90,
  hype_risk: 35,
  should_push: true,
  reason: 'A new open-source coding agent.',
};

async function seedRawItem(args: {
  sourceItemId: string;
  url: string | null;
  title: string;
  publishedAt: Date | null;
  content?: string | null;
}): Promise<bigint> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO raw_items (source, source_item_id, url, title, published_at, content)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [SOURCE, args.sourceItemId, args.url, args.title, args.publishedAt, args.content ?? null],
  );
  return BigInt(rows[0]!.id);
}

async function fetchEventByDedupKey(dedupKey: string) {
  const { rows } = await pool!.query<{
    event_id: string;
    representative_raw_item_id: string | null;
    representative_title: string | null;
    first_seen_at: Date | null;
    published_at: Date | null;
    source_count: number;
    importance_score: string | null;
    novelty_score: string | null;
    developer_relevance_score: string | null;
    hype_risk_score: string | null;
    should_push: boolean | null;
    is_ai_related: boolean | null;
  }>(
    `SELECT event_id, representative_raw_item_id, representative_title,
            first_seen_at, published_at, source_count,
            importance_score, novelty_score, developer_relevance_score,
            hype_risk_score, should_push, is_ai_related
     FROM ai_news_events WHERE dedup_key = $1`,
    [dedupKey],
  );
  return rows;
}

/** 造一条真实事件并返回其 dedup_key（经塌缩首建）；可选 content 落到代表 raw_item 供 grounding。 */
async function seedEvent(
  prefix: string,
  title: string,
  content?: string | null,
): Promise<string> {
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `https://example.com/${prefix}/${ts}`;
  const id = await seedRawItem({
    sourceItemId: `${prefix}-${ts}`,
    url,
    title,
    publishedAt: new Date('2026-06-01T00:00:00Z'),
    content: content ?? null,
  });
  const out = await collapseRawItem(
    { id, url, source: 'rss', title, publishedAt: new Date('2026-06-01T00:00:00Z'), fetchedAt: new Date() },
    db!,
  );
  return out.dedupKey!;
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

afterAll(async () => {
  await cleanup();
  if (pool) await pool.end();
});

describe.skipIf(!databaseUrl)('Value Judge 接入流水线（评分往返 + 降级容错）', () => {
  it('真实事件评分按映射写入 *_score 列并可读回一致；身份/排序列不被覆盖', async () => {
    const dedupKey = await seedEvent('roundtrip', 'New open-source coding agent');
    const before = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 评分前各 *_score 为 NULL（塌缩不写分）。
    expect(before.importance_score).toBeNull();

    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const result = await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    // 至少把本事件送判并写分（其他并发套件造的未评分事件也可能被纳入，故用 >=）。
    expect(result.scored).toBeGreaterThanOrEqual(1);
    expect(result.degradedCount).toBe(0);

    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 往返：各 *_score 与 Agent 输出按映射一致（NUMERIC 落库为字符串，用 Number 比较）。
    expect(Number(after.importance_score)).toBe(VALID_OUTPUT.importance);
    expect(Number(after.novelty_score)).toBe(VALID_OUTPUT.novelty);
    expect(Number(after.developer_relevance_score)).toBe(
      VALID_OUTPUT.developer_relevance,
    );
    expect(Number(after.hype_risk_score)).toBe(VALID_OUTPUT.hype_risk);
    expect(after.should_push).toBe(VALID_OUTPUT.should_push);

    // 写分仅改 *_score + should_push：塌缩首建的身份/代表/排序列不变。
    expect(after.event_id).toBe(before.event_id);
    expect(after.representative_raw_item_id).toBe(before.representative_raw_item_id);
    expect(after.representative_title).toBe(before.representative_title);
    expect(after.first_seen_at?.toISOString()).toBe(
      before.first_seen_at?.toISOString(),
    );
    expect(after.published_at?.toISOString()).toBe(
      before.published_at?.toISOString(),
    );
    expect(Number(after.source_count)).toBe(Number(before.source_count));
  });

  it('单条 judge 校验失败：降级跳过 + degraded_count++ + 不落库未校验数据', async () => {
    const dedupKey = await seedEvent('degrade', 'Item that fails judging');

    // mock 始终返回不符 schema 的对象 → judgeRawItem 重试耗尽抛 ValueJudgeFailureError。
    const generateObjectFn = vi
      .fn()
      .mockResolvedValue({ object: { is_ai_related: 'not-a-bool' } });
    const logError = vi.fn();

    const result = await scoreUnscoredEvents(
      {
        judge: { generateObjectFn, maxAttempts: 2, logError: () => {} },
        logError,
      },
      db!,
    );

    // 本事件被降级计数，且记录了日志（非静默）。
    expect(result.degradedCount).toBeGreaterThanOrEqual(1);
    expect(logError).toHaveBeenCalled();

    // 关键不变量：降级事件未写库——各 *_score 仍为 NULL（未校验数据绝不落库）。
    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(after.importance_score).toBeNull();
    expect(after.novelty_score).toBeNull();
    expect(after.developer_relevance_score).toBeNull();
    expect(after.hype_risk_score).toBeNull();
  });

  it('已评分事件跳过不重判：第二轮不再调用 LLM、不覆盖旧分', async () => {
    const dedupKey = await seedEvent('skip', 'Already scored event');

    const firstFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn: firstFn, logError: () => {} }, logError: () => {} },
      db!,
    );
    const firstCalls = firstFn.mock.calls.length;
    expect(firstCalls).toBeGreaterThanOrEqual(1);

    // 第二轮：本事件 *_score 已非 NULL，应被 `importance_score IS NULL` 过滤掉，不再送判。
    // 若误把已评分事件再判，会用不同分覆盖——故第二轮 mock 返回不同分以放大该 bug。
    const DIFFERENT = { ...VALID_OUTPUT, importance: 11, novelty: 22 };
    const secondFn = vi.fn().mockResolvedValue({ object: DIFFERENT });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn: secondFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 旧分保持首轮值（82），未被第二轮的 11 覆盖 → 证明已评分被跳过。
    expect(Number(after.importance_score)).toBe(VALID_OUTPUT.importance);
    expect(Number(after.novelty_score)).toBe(VALID_OUTPUT.novelty);
  });

  it('is_ai_related 落库并可读回（false 值证明非硬编码 true、非被映射层丢弃）', async () => {
    const dedupKey = await seedEvent('ai-related', 'Some non-AI item');
    // 返回 is_ai_related=false：若映射/落库丢弃该字段，读回会是 NULL（或默认），非 false。
    const output = { ...VALID_OUTPUT, is_ai_related: false };
    const generateObjectFn = vi.fn().mockResolvedValue({ object: output });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    // 读回 false（既非 NULL 丢弃、也非硬编码 true）——证明 mapping.ts 映射 + UPDATE set 落库往返。
    expect(after.is_ai_related).toBe(false);
  });

  it('grounding：补全后 content 进入传给 generateObjectFn 的 prompt（非仅读回 mock 硬编码输出）', async () => {
    // 唯一标记落到代表 raw_item.content——判分候选 SELECT 经 representative_raw_item_id left join
    // raw_items 载入该 content，judgeRawItem 拼进 prompt。断言注入 generateObjectFn 收到的 prompt
    // 文本**含该 content**：若 score-events 只改签名不接 SELECT 载入，prompt 不含 content 则本用例红
    // （区别于「读回 mock 硬编码输出」的假绿——后者即使 content 未接入也绿）。
    const marker = `GROUNDING-MARKER-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const contentText = `Anthropic shipped a real release. ${marker}`;
    const dedupKey = await seedEvent('grounding', 'A grounded event', contentText);

    const prompts: string[] = [];
    const generateObjectFn = vi.fn(async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      return { object: VALID_OUTPUT };
    });
    await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, logError: () => {} },
      db!,
    );

    // 至少一次调用的 prompt 含补全后 content（本事件的判分 prompt）。
    expect(prompts.some((p) => p.includes(contentText))).toBe(true);
    // 事件确被判分落库（防「未送判」导致 grounding 断言空过）。
    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(after.importance_score).not.toBeNull();
  });

  // ── 补全折进判分入口（unify-judge-stage）：补全在 claim 之后、judge 之前，正文经返回值送入本次判分 ──
  type EnrichOpts = NonNullable<NonNullable<Parameters<typeof scoreUnscoredEvents>[0]>['enrich']>;
  const publicResolve = async () => ['93.184.216.34'];
  function enrichStub(og: string): EnrichOpts {
    return {
      resolve: publicResolve,
      fetchImpl: (async () => ({
        status: 200,
        ok: true,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
        text: async () => `<html><head><meta property="og:description" content="${og}"></head></html>`,
      })) as NonNullable<EnrichOpts>['fetchImpl'],
      logError: () => {},
    };
  }
  const THROW_ENRICH: EnrichOpts = {
    resolve: publicResolve,
    fetchImpl: (async () => {
      throw new Error('enrich fetch disabled');
    }) as NonNullable<EnrichOpts>['fetchImpl'],
    logError: () => {},
  };

  it('6.1 空 content + 可抓 URL → 先补全再判分，judgeRawItem 的 content 入参 = 补全后正文（权威验收）', async () => {
    const enriched = `ENRICHED-BODY-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dedupKey = await seedEvent('fold', 'Empty content link post', ''); // content 空。
    const prompts: string[] = [];
    const generateObjectFn = vi.fn(async (args: { prompt: string }) => {
      prompts.push(args.prompt);
      return { object: VALID_OUTPUT };
    });
    const res = await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, enrich: enrichStub(enriched), logError: () => {} },
      db!,
    );
    expect(res.enrichHit).toBe(1);
    // 断言落在 **judge 的输入**（不是只断言 DB 写入——只写库不回传时那也为绿、无证伪力）。
    expect(prompts.some((p) => p.includes(enriched))).toBe(true);
    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(after.importance_score).not.toBeNull(); // 确被判分落库。
    // DB 也写回了补全正文。
    const { rows } = await pool!.query<{ content: string | null }>(
      `SELECT content FROM raw_items WHERE source = $1 AND content = $2`,
      [SOURCE, enriched],
    );
    expect(rows).toHaveLength(1);
  });

  it('6.2 fail-open：补全 fetch 抛错 → 事件仍被判分（仅标题）、落库、enrichFail+1、degradedCount 不增', async () => {
    const dedupKey = await seedEvent('failopen', 'Enrich fails but judged', '');
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const res = await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, enrich: THROW_ENRICH, logError: () => {} },
      db!,
    );
    expect(res.enrichFail).toBe(1);
    expect(res.degradedCount).toBe(0); // 补全失败绝不进熔断分母。
    expect(res.scored).toBe(1);
    expect(generateObjectFn).toHaveBeenCalled(); // 照常送 LLM（仅标题）——绝不 continue 跳过。
    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(after.importance_score).not.toBeNull();
  });

  it("6.4 content=' '（NBSP，isEmpty 投影列为 false）→ 不发起补全 HTTP、照常送判", async () => {
    // NBSP 是非空白字符（PG `!~ '\S'` 为假）⇒ isEmpty=false ⇒ 不补全。TS trim() 会误判空→白抓。
    await seedEvent('nbsp', 'NBSP content post', '\u00A0');
    const fetchSpy = vi.fn(async () => {
      throw new Error('MUST NOT fetch for non-empty content');
    });
    const generateObjectFn = vi.fn().mockResolvedValue({ object: VALID_OUTPUT });
    const res = await scoreUnscoredEvents(
      {
        judge: { generateObjectFn, logError: () => {} },
        enrich: { resolve: publicResolve, fetchImpl: fetchSpy as NonNullable<EnrichOpts>['fetchImpl'], logError: () => {} },
        logError: () => {},
      },
      db!,
    );
    expect(fetchSpy).not.toHaveBeenCalled(); // 无白抓。
    expect(res.enrichHit + res.enrichFail).toBe(0); // 未进补全路径。
    expect(res.scored).toBe(1);
  });

  it('6.7 写分 CAS：claim 后另一路径已写 importance_score → 写命中 0 行、不覆写、不计 scored、记 WARN', async () => {
    const dedupKey = await seedEvent('cas', 'CAS guard event', 'has content'); // 非空 → 不触发补全。
    // 在 LLM 返回期间模拟另一路径合法写入 importance_score=91（并发评分）。
    const generateObjectFn = vi.fn(async () => {
      await pool!.query(`UPDATE ai_news_events SET importance_score = '91' WHERE dedup_key = $1`, [dedupKey]);
      return { object: { ...VALID_OUTPUT, importance: 11 } };
    });
    const logs: string[] = [];
    const res = await scoreUnscoredEvents(
      { judge: { generateObjectFn, logError: () => {} }, enrich: THROW_ENRICH, logError: (m) => logs.push(m) },
      db!,
    );
    expect(res.scored).toBe(0); // 写 CAS 命中 0 行 → 不计 scored。
    expect(res.degradedCount).toBe(0); // 非降级、不稀释分母。
    const after = (await fetchEventByDedupKey(dedupKey))[0]!;
    expect(Number(after.importance_score)).toBe(91); // 未被 11 覆写（永不覆写的结构保证）。
    // 与 tombstone 0 行路径可区分：记 WARN（importance_score 已非空）。
    expect(logs.some((l) => l.includes('WARN') && l.includes('importance_score 已非空'))).toBe(true);
  });
});

// ── 判分预算 maxPerRun（p0-alert-lane A5.1/A5.4/A5.5 / design D11）──────────────────────────────
// 给出 maxPerRun 时候选 SELECT 加 `ORDER BY first_seen_at DESC NULLS LAST, event_id DESC
// LIMIT maxPerRun + 1`、只处理前 maxPerRun 条（+1 仅触顶信号）；不传 = 全量（默认 undefined，
// 绝不可是模块常量——日报链靠它保持无界）。
describe.skipIf(!databaseUrl)('判分预算 maxPerRun（p0-alert-lane A5）', () => {
  // 预算断言需要精确控制全表未评分集：scoreUnscoredEvents 扫全表 `importance_score IS NULL`，
  // 残留未评分行会占掉预算名额、腐蚀「本轮只判 N 条」断言。beforeEach 全表 TRUNCATE
  //（同 alert-scan.integration.test.ts；vitest fileParallelism=false，文件间串行不互踩）。
  beforeEach(async () => {
    await pool!.query(`TRUNCATE TABLE push_records, ai_news_events, raw_items RESTART IDENTITY`);
  });

  // 收尾清理（与 beforeEach 同一批表、同一写法）：最后一个用例留下的已评分事件（embedding NULL）
  // 会被后续 semantic-merge 套件的全局 embed 扫描卷进合并，制造顺序依赖 flake。
  afterAll(async () => {
    await pool!.query(`TRUNCATE TABLE push_records, ai_news_events, raw_items RESTART IDENTITY`);
  });

  /**
   * 直接 INSERT 一条未评分事件（importance NULL），显式控制 event_id（varchar 列，可控值使
   * `event_id DESC` 断言不依赖 uuid 的 collation 序）与 first_seen_at（可 NULL——NULLS LAST 用例）。
   * 无代表 raw_item（rawItemId NULL ⇒ 不触发补全路径，无需 enrich 桩）。
   */
  async function seedUnscored(eventId: string, title: string, firstSeenAt: Date | null): Promise<void> {
    await pool!.query(
      `INSERT INTO ai_news_events (event_id, representative_title, first_seen_at) VALUES ($1, $2, $3)`,
      [eventId, title, firstSeenAt],
    );
  }

  /** 已评分事件的标题集（断言「谁被判了」——每条 seed 标题唯一）。 */
  async function scoredTitles(): Promise<Set<string>> {
    const { rows } = await pool!.query<{ representative_title: string }>(
      `SELECT representative_title FROM ai_news_events WHERE importance_score IS NOT NULL`,
    );
    return new Set(rows.map((r) => r.representative_title));
  }

  const budgetOpts = (maxPerRun?: number) => ({
    judge: { generateObjectFn: vi.fn().mockResolvedValue({ object: VALID_OUTPUT }), logError: () => {} },
    logError: () => {},
    ...(maxPerRun !== undefined ? { maxPerRun } : {}),
  });

  it('候选(5) > 预算(2)：本轮只判 first_seen_at 最新 2 条、budgetExhausted=true；超预算事件从未被 claim；余量下轮续判（不丢）', async () => {
    const base = Date.UTC(2026, 0, 1);
    for (let i = 1; i <= 5; i++) {
      await seedUnscored(`budget-e${i}`, `budget-title-${i}`, new Date(base + i * 60_000));
    }

    const res1 = await scoreUnscoredEvents(budgetOpts(2), db!);
    expect(res1.judged).toBe(2);
    expect(res1.scored).toBe(2);
    expect(res1.budgetExhausted).toBe(true); // LIMIT 2+1 取回 3 行 > 2 → 触顶。
    expect(res1.candidateCount).toBe(2);
    // first_seen_at DESC：最新的 5、4 被判。
    expect(await scoredTitles()).toEqual(new Set(['budget-title-5', 'budget-title-4']));
    // A5.4：LIMIT N+1 落在 claim 之【前】——超预算事件（含第 N+1 行）从未被 claim，
    // 下一轮即刻可取（不用等满 JUDGE_CLAIM_RECLAIM_MS 回收）。
    const { rows: claimedPending } = await pool!.query(
      `SELECT event_id FROM ai_news_events
        WHERE importance_score IS NULL AND judge_claimed_at IS NOT NULL`,
    );
    expect(claimedPending).toHaveLength(0);

    // 下一轮续判 3、2，仍触顶；第三轮判最后 1 条、不触顶——预算只裁单轮工作量、不丢事件。
    const res2 = await scoreUnscoredEvents(budgetOpts(2), db!);
    expect(res2.scored).toBe(2);
    expect(res2.budgetExhausted).toBe(true);
    expect(await scoredTitles()).toEqual(
      new Set(['budget-title-5', 'budget-title-4', 'budget-title-3', 'budget-title-2']),
    );
    const res3 = await scoreUnscoredEvents(budgetOpts(2), db!);
    expect(res3.scored).toBe(1);
    expect(res3.budgetExhausted).toBe(false);
    expect(res3.candidateCount).toBe(1);
    expect((await scoredTitles()).size).toBe(5); // 5 条全被判，无一条被截丢。
  });

  it('恰好 N 条候选（= 预算）→ 全判且 budgetExhausted=false（LIMIT N+1 区分「恰好 N」与「超过 N」）', async () => {
    await seedUnscored('exact-e1', 'exact-title-1', new Date('2026-01-05T00:00:00Z'));
    await seedUnscored('exact-e2', 'exact-title-2', new Date('2026-01-06T00:00:00Z'));
    const res = await scoreUnscoredEvents(budgetOpts(2), db!);
    expect(res.scored).toBe(2);
    expect(res.budgetExhausted).toBe(false); // 单靠 LIMIT N 无法给出这个区分——触顶信号会失真。
    expect(res.candidateCount).toBe(2);
  });

  it('取序确定性：first_seen_at 同值按 event_id DESC 稳定取（A5.5）', async () => {
    const same = new Date('2026-01-02T00:00:00Z'); // 同一轮采集入库常见同秒。
    await seedUnscored('tie-a', 'tie-title-a', same);
    await seedUnscored('tie-b', 'tie-title-b', same);
    await seedUnscored('tie-c', 'tie-title-c', same);
    const res = await scoreUnscoredEvents(budgetOpts(2), db!);
    expect(res.scored).toBe(2);
    // event_id DESC：'tie-c' > 'tie-b' > 'tie-a' → 判 c、b（漏 event_id 排序键时 PG 部分序任取）。
    expect(await scoredTitles()).toEqual(new Set(['tie-title-c', 'tie-title-b']));
  });

  it('first_seen_at IS NULL 的事件排最后、不占预算名额（NULLS LAST；防 PG DESC 默认 NULLS FIRST 让它恒排第一）', async () => {
    // 若取序退化为 PG 默认 NULLS FIRST，NULL 行恒排第一、每轮吃掉一个名额且永不老化（工作集无时间剪枝）。
    await seedUnscored('null-e', 'null-title', null);
    await seedUnscored('nn-1', 'nn-title-1', new Date('2026-01-03T00:00:00Z'));
    await seedUnscored('nn-2', 'nn-title-2', new Date('2026-01-04T00:00:00Z'));
    const res = await scoreUnscoredEvents(budgetOpts(2), db!);
    expect(res.scored).toBe(2);
    expect(res.budgetExhausted).toBe(true); // NULL 行占的是第 N+1 位（信号位）。
    expect(await scoredTitles()).toEqual(new Set(['nn-title-1', 'nn-title-2'])); // NULL 不占名额。
  });

  it('不传 maxPerRun → 全量判（6 条 > 告警预算 N 全被判；默认 MUST 是 undefined 而非模块常量）', async () => {
    for (let i = 1; i <= 6; i++) {
      await seedUnscored(`full-e${i}`, `full-title-${i}`, new Date(Date.UTC(2026, 0, 10 + i)));
    }
    const res = await scoreUnscoredEvents(budgetOpts(), db!);
    expect(res.scored).toBe(6);
    expect(res.budgetExhausted).toBe(false);
    expect(res.candidateCount).toBe(6);
    expect((await scoredTitles()).size).toBe(6);
  });
});
