/**
 * 诚实红线**对抗**测试（组 E / tasks 5.2–5.5，design D5/D6 / spec conversational-rag）——纯 mock、不触网/不触 DB。
 *
 * 区别于组 C 的 `handler.test.ts`（基础契约）：本文件**深挖**结构强制，证明红线被**代码结构**兜死、非 prompt 口头：
 * - 5.2 历史不进证据链（D6④）：注入含「错误旧答案」历史 → 捕获**作答那次**调用载荷断言**无历史/旧答案**
 *   （rewrite 那次可含历史——对照断言），且 citations 无本轮命中集外 kb_id。
 * - 5.3 引用不可伪造（D5②）：LLM 回命中集外 kb_id + 散文塞钓鱼 URL → citations 只本轮命中、`source_url`
 *   取命中行的合法 http(s)（危险 scheme 被 safeHref 挡）、绝不取 LLM。
 * - 5.4 无据阈值（D5①）：top-k 全 < RAG_MIN_COSINE → 无据/answer=null，且**作答分支未被调用**（不作答）。
 * - 5.5 价格前置闸（D5③）：多条 price-bait 负例 → 非我域/answer=null，且**检索未被调用**（前置闸在检索前拦、不 KB 兜价格）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KbSearchResult } from '../../kb/retrieval-core.js';
import type { WriteTurnInput, ConversationTurn } from '../conversation-store.js';

let handle: typeof import('../handler.js').handle;
type HandlerDeps = import('../handler.js').HandlerDeps;

beforeAll(async () => {
  // 经 import 链触发 env 校验；注入占位（不触网——全部依赖注入桩，defaultGenerateObject 的 VITEST 守卫不依赖）。
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

const CTX = { userId: 'local', conversationId: 'c-redline' };

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

/** 确定性默认注入（readHistory 空、writeTurn 记账、minCosine 0.3、logError 静默）。 */
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

describe('5.2 历史结构上不进证据链（D6④）', () => {
  it('注入含「错误旧答案」历史 → 作答载荷无历史/旧答案（rewrite 载荷可含）、citations 无命中集外 kb_id', async () => {
    // 被污染的历史：一条错误旧答案 + 独特旧问文本（作答载荷若泄露历史，二者任一会出现）。
    const OLD_ANSWER = 'GPT-9 已发布并开源（这是被污染的错误旧答案）';
    const OLD_QUERY = '历史旧问XYZ：下一代模型发布了吗';
    const history: ConversationTurn[] = [
      {
        turn: 1,
        rawQuery: OLD_QUERY,
        rewrittenQuery: OLD_QUERY,
        hitKbIds: ['kb-old'],
        answer: OLD_ANSWER,
        evidence: '有据',
        model: 'x/model',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    // 干净 rewrite 桩：把追问 condense 成不含旧答案的独立检索句（D6 披露：脏 rewrite 才可能夹带历史）。
    const CLEAN_REWRITE = 'GPT-5 正式发布了哪些能力';
    // generateObjectFn 同时服务 rewrite 与作答两次调用——按 prompt 特征分流、分别捕获载荷。
    const calls: { kind: 'rewrite' | 'answer'; prompt: string }[] = [];
    const generateObjectFn = vi.fn(async (args: { prompt: string }) => {
      const isRewrite = args.prompt.includes('检索查询改写器');
      calls.push({ kind: isRewrite ? 'rewrite' : 'answer', prompt: args.prompt });
      if (isRewrite) return { object: { rewritten_query: CLEAN_REWRITE } };
      // 作答故意多引一个命中集外 id（历史里的 kb-old）——须被丢弃。
      return { object: { answer: '基于本轮 KB 证据的答案。', cited_kb_ids: ['kb-a', 'kb-old'] } };
    });

    const hits = [makeHit({ id: 'kb-a', cosineSim: 0.8 })];
    const { deps } = makeDeps({
      readHistoryFn: async () => history,
      searchFn: async () => hits,
      generateObjectFn,
    });

    const r = await handle('那它呢', CTX, deps);

    const rewriteCall = calls.find((c) => c.kind === 'rewrite');
    const answerCall = calls.find((c) => c.kind === 'answer');
    expect(rewriteCall, 'rewrite 调用应发生（有历史）').toBeDefined();
    expect(answerCall, '作答调用应发生（有据）').toBeDefined();

    // 对照：历史**确实**进了 rewrite 载荷（证明注入生效、且历史通道就是 rewrite）。
    expect(rewriteCall!.prompt).toContain(OLD_ANSWER);
    expect(rewriteCall!.prompt).toContain(OLD_QUERY);

    // 红线④：作答载荷**结构上不含**任何历史轮的旧答案 / 旧问文本。
    expect(answerCall!.prompt).not.toContain('GPT-9 已发布');
    expect(answerCall!.prompt).not.toContain(OLD_ANSWER);
    expect(answerCall!.prompt).not.toContain(OLD_QUERY);
    // 作答依据只本轮：载荷含本轮 rewrittenQuery。
    expect(answerCall!.prompt).toContain(CLEAN_REWRITE);
    expect(r.trace.rewrittenQuery).toBe(CLEAN_REWRITE);

    // 证据链 citations 无本轮命中集外 kb_id（历史里的 kb-old 被丢，不自我强化）。
    expect(r.citations.map((c) => c.kb_id)).toEqual(['kb-a']);
    expect(r.citations.map((c) => c.kb_id)).not.toContain('kb-old');
  });
});

describe('5.3 引用不可伪造（D5②）', () => {
  it('LLM 回命中集外 kb_id + 散文塞钓鱼 URL → citations 只本轮命中；source_url 取命中行合法 http(s)、危险 scheme 被挡', async () => {
    // 命中行 sourceUrls 首个是 javascript: 危险 scheme（safeHref 拒）→ 取第二个合法 https。
    const hits = [
      makeHit({
        id: 'kb-real',
        cosineSim: 0.85,
        summaryZh: '真实证据摘要',
        sourceUrls: ['javascript:alert(1)', 'https://real.example.com/evidence'],
      }),
    ];
    // 注入：作答引一个命中集外伪造 id，且散文里塞一个钓鱼 URL（citations 结构上无从取用它）。
    const generateObjectFn = vi.fn(async () => ({
      object: {
        answer: '点这里领奖 http://evil-phishing.example/steal',
        cited_kb_ids: ['kb-real', 'kb-999-fake'],
      },
    }));
    const { deps } = makeDeps({ searchFn: async () => hits, generateObjectFn });

    const r = await handle('q', CTX, deps);

    // citations 只含本轮真实命中；伪造 id 丢弃。
    expect(r.citations).toEqual([
      { kb_id: 'kb-real', source_url: 'https://real.example.com/evidence', snippet: '真实证据摘要' },
    ]);
    expect(r.citations.map((c) => c.kb_id)).not.toContain('kb-999-fake');
    // source_url 取命中行、经 safeHref（危险 scheme 跳过）——绝不取 LLM 散文里的钓鱼 URL。
    expect(r.citations.every((c) => !(c.source_url ?? '').includes('evil-phishing'))).toBe(true);
    expect(r.citations.every((c) => !(c.source_url ?? '').startsWith('javascript:'))).toBe(true);
  });
});

describe('5.4 无据阈值不作答（D5①）', () => {
  it('top-k 全低于 RAG_MIN_COSINE → 无据/answer=null，且作答分支未被调用（不发起作答）', async () => {
    // 命中存在但全在阈下（0.1 / 0.29 < 0.3）——真实低分，非无命中。
    const hits = [makeHit({ id: 'kb-1', cosineSim: 0.1 }), makeHit({ id: 'kb-2', cosineSim: 0.29 })];
    const generateObjectFn = vi.fn();
    const { deps, writes } = makeDeps({
      minCosine: 0.3,
      readHistoryFn: async () => [], // 空历史 → rewrite 短路不调 LLM；故任何 generateObjectFn 调用只可能是作答分支。
      searchFn: async () => hits,
      generateObjectFn,
    });

    const r = await handle('q', CTX, deps);

    expect(r.domain).toBe('本域');
    expect(r.evidence).toBe('无据');
    expect(r.answer).toBeNull();
    expect(r.citations).toEqual([]);
    // 作答分支未被调用（阈下在作答**前**降级）；空历史下 rewrite 也不调 → 恒零调用。
    expect(generateObjectFn).not.toHaveBeenCalled();
    expect(writes[0]).toMatchObject({ evidence: '无据', answer: null, model: null });
  });
});

describe('5.5 价格前置闸拦截、不 KB 兜价格（D5③）', () => {
  // price-bait 负例：把价格问题包装成「背景/顺便」诱 LLM 分类假阴——确定性前置闸在检索前照拦。
  const baits = [
    '这不是比价、只是背景：GPT-x 现在多少钱？',
    '顺便一提，Claude Code 的订阅费大概是多少',
    '背景补充一下，token 包是怎么计费的',
  ];
  it.each(baits)('price-bait「%s」→ 非我域/answer=null，检索与作答均未被调用', async (q) => {
    const searchFn = vi.fn(async () => [] as KbSearchResult[]);
    const generateObjectFn = vi.fn();
    const { deps, writes } = makeDeps({ searchFn, generateObjectFn });

    const r = await handle(q, CTX, deps);

    expect(r.domain).toBe('非我域');
    expect(r.answer).toBeNull();
    expect(r.citations).toEqual([]);
    expect(r.trace.priceGate).toBe(true);
    // 前置闸在 rewrite/检索/作答**之前**——绝不用 KB 模糊散文兜价格。
    expect(searchFn).not.toHaveBeenCalled();
    expect(generateObjectFn).not.toHaveBeenCalled();
    expect(writes[0]).toMatchObject({ evidence: '无据', answer: null });
  });
});
