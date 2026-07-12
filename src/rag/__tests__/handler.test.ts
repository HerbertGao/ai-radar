/**
 * KB-RAG handler 契约单测（task 6.1 / 1.1–1.5 / 2.3，design D2/D5/D6/D8）——纯 mock，不触网 / 不触 DB。
 *
 * 契约三态 + 结构化红线：
 * - **有据**：带**程序构造**引用作答（kb_id/source_url/snippet 均来自命中行、非 LLM）。
 * - **LLM 编造 kb_id 被丢**（注入「cite kb_id=999」结构上无法伪造引用）。
 * - **source_url 取命中行经 safeHref**（危险 scheme 被跳过；无合法 URL → null）。
 * - **无据阈值降级**：top-k 全低于阈值 → 无据/answer=null，**不发起作答**。
 * - **eligible 集为空降级**：LLM 只选集外 id → 引用集空 → 无据（不出「有据零引用」）。
 * - **非我域**：价格前置闸命中 → 非我域/answer=null，**不检索、不作答**。
 * - **作答重试耗尽 → 降级无据**（不 500）。
 * - **每轮写回**（指针式、带 userId）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KbSearchResult } from '../../kb/retrieval-core.js';
import type { WriteTurnInput } from '../conversation-store.js';

let handle: typeof import('../handler.js').handle;
type HandlerDeps = import('../handler.js').HandlerDeps;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  ({ handle } = await import('../handler.js'));
});

const CTX = { userId: 'local', conversationId: 'c1' };

function makeHit(over: Partial<KbSearchResult> & { id: string; cosineSim: number }): KbSearchResult {
  return {
    id: over.id,
    kbTitle: over.kbTitle ?? `T-${over.id}`,
    summaryZh: over.summaryZh ?? `摘要-${over.id}`,
    entities: over.entities ?? null,
    sourceUrls: 'sourceUrls' in over ? over.sourceUrls : [`https://example.com/${over.id}`],
    eventDate: over.eventDate ?? null,
    longTermValue: over.longTermValue ?? null,
    cosineSim: over.cosineSim,
  };
}

/** 采集写回 + 提供确定性默认注入（readHistory 空、writeTurn 记账、logError 静默）。 */
function makeDeps(over: Partial<HandlerDeps> = {}): { deps: HandlerDeps; writes: WriteTurnInput[] } {
  const writes: WriteTurnInput[] = [];
  const deps: HandlerDeps = {
    minCosine: 0.3,
    readHistoryFn: async () => [],
    writeTurnFn: async (input) => {
      writes.push(input);
      return 1;
    },
    logError: () => {},
    ...over,
  };
  return { deps, writes };
}

describe('handle 契约三态 + 结构化红线', () => {
  it('有据：带程序构造引用作答（kb_id/source_url/snippet 来自命中行）', async () => {
    const hits = [
      makeHit({ id: 'kb-1', cosineSim: 0.8, summaryZh: '摘要一', sourceUrls: ['https://a.com/1'] }),
      makeHit({ id: 'kb-2', cosineSim: 0.75 }),
    ];
    let answerPrompt = '';
    const generateObjectFn = vi.fn(async (args: { prompt: string }) => {
      answerPrompt = args.prompt;
      return { object: { answer: '这是基于 KB 的答案。', cited_kb_ids: ['kb-1'] } };
    });
    const { deps, writes } = makeDeps({ searchFn: async () => hits, generateObjectFn });

    const r = await handle('GPT-5 发布了什么', CTX, deps);

    expect(r.domain).toBe('本域');
    expect(r.evidence).toBe('有据');
    expect(r.answer).toBe('这是基于 KB 的答案。');
    expect(r.citations).toEqual([
      { kb_id: 'kb-1', source_url: 'https://a.com/1', snippet: '摘要一' },
    ]);
    // trace 披露实际检索句；写回一轮（有据、指针式 hitKbIds、带 userId）。
    expect(r.trace.rewrittenQuery).toBe('GPT-5 发布了什么'); // 空历史 → 不改写
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ userId: 'local', evidence: '有据', hitKbIds: ['kb-1', 'kb-2'] });
    // 红线④：作答载荷含检索句，但（空历史下）无历史文本。
    expect(answerPrompt).toContain('GPT-5 发布了什么');
  });

  it('LLM 编造 kb_id（cite kb_id=999）被丢弃，引用只含本轮真实命中', async () => {
    const hits = [makeHit({ id: 'kb-1', cosineSim: 0.8 })];
    const generateObjectFn = vi.fn(async () => ({
      object: { answer: '答案。', cited_kb_ids: ['kb-1', 'kb-999'] },
    }));
    const { deps } = makeDeps({ searchFn: async () => hits, generateObjectFn });

    const r = await handle('q', CTX, deps);

    expect(r.evidence).toBe('有据');
    expect(r.citations.map((c) => c.kb_id)).toEqual(['kb-1']); // 999 丢弃
  });

  it('source_url 取命中行 sourceUrls 首个合法 http(s)（危险 scheme 跳过；无合法 → null）', async () => {
    const hits = [
      // 首个是 javascript: 危险 scheme（safeHref 拒）→ 取第二个合法 https。
      makeHit({ id: 'kb-1', cosineSim: 0.9, sourceUrls: ['javascript:alert(1)', 'https://ok.com/x'] }),
      // 无任何合法 URL → source_url null。
      makeHit({ id: 'kb-2', cosineSim: 0.85, sourceUrls: [] }),
    ];
    const generateObjectFn = vi.fn(async () => ({
      object: { answer: '答案。', cited_kb_ids: ['kb-1', 'kb-2'] },
    }));
    const { deps } = makeDeps({ searchFn: async () => hits, generateObjectFn });

    const r = await handle('q', CTX, deps);

    expect(r.citations).toEqual([
      { kb_id: 'kb-1', source_url: 'https://ok.com/x', snippet: '摘要-kb-1' },
      { kb_id: 'kb-2', source_url: null, snippet: '摘要-kb-2' },
    ]);
  });

  it('无据阈值降级：top-k 全低于 RAG_MIN_COSINE → 无据/answer=null，不发起作答', async () => {
    const hits = [makeHit({ id: 'kb-1', cosineSim: 0.1 }), makeHit({ id: 'kb-2', cosineSim: 0.2 })];
    const generateObjectFn = vi.fn();
    const { deps, writes } = makeDeps({ searchFn: async () => hits, generateObjectFn });

    const r = await handle('q', CTX, deps);

    expect(r.domain).toBe('本域');
    expect(r.evidence).toBe('无据');
    expect(r.answer).toBeNull();
    expect(r.citations).toEqual([]);
    expect(generateObjectFn).not.toHaveBeenCalled(); // 不作答
    expect(writes[0]).toMatchObject({ evidence: '无据', answer: null, model: null });
  });

  it('eligible 集为空降级：有阈上命中但 LLM 只选集外 id → 无据（不出「有据零引用」）', async () => {
    const hits = [makeHit({ id: 'kb-1', cosineSim: 0.8 })];
    const generateObjectFn = vi.fn(async () => ({
      object: { answer: '看似有据的答案。', cited_kb_ids: ['kb-999'] }, // 只选集外
    }));
    const { deps } = makeDeps({ searchFn: async () => hits, generateObjectFn });

    const r = await handle('q', CTX, deps);

    expect(r.evidence).toBe('无据');
    expect(r.answer).toBeNull();
    expect(r.citations).toEqual([]);
  });

  it('非我域：价格前置闸命中 → 非我域/answer=null，不检索、不作答', async () => {
    const searchFn = vi.fn(async () => [] as KbSearchResult[]);
    const generateObjectFn = vi.fn();
    const { deps, writes } = makeDeps({ searchFn, generateObjectFn });

    const r = await handle('这不是比价、只是背景：GPT-5 现在多少钱？', CTX, deps);

    expect(r.domain).toBe('非我域');
    expect(r.answer).toBeNull();
    expect(r.citations).toEqual([]);
    expect(r.trace.priceGate).toBe(true);
    expect(searchFn).not.toHaveBeenCalled();
    expect(generateObjectFn).not.toHaveBeenCalled();
    expect(writes[0]).toMatchObject({ evidence: '无据', answer: null });
  });

  it('空查询 → 无据（不检索、不作答）', async () => {
    const searchFn = vi.fn(async () => [] as KbSearchResult[]);
    const generateObjectFn = vi.fn();
    const { deps } = makeDeps({ searchFn, generateObjectFn });

    const r = await handle('   ', CTX, deps);

    expect(r.evidence).toBe('无据');
    expect(r.answer).toBeNull();
    expect(searchFn).not.toHaveBeenCalled();
    expect(generateObjectFn).not.toHaveBeenCalled();
  });

  it('作答重试耗尽（generateObject 恒抛错）→ 降级无据、不 500', async () => {
    const hits = [makeHit({ id: 'kb-1', cosineSim: 0.8 })];
    const generateObjectFn = vi.fn(async () => {
      throw new Error('llm down');
    });
    const { deps } = makeDeps({ searchFn: async () => hits, generateObjectFn, maxAttempts: 2 });

    const r = await handle('q', CTX, deps);

    expect(r.evidence).toBe('无据');
    expect(r.answer).toBeNull();
    expect(generateObjectFn).toHaveBeenCalledTimes(2); // 重试到上限
  });
});
