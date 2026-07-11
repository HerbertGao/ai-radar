/**
 * `/advisor` 多层安全单测（task 6.4，design D10/D11）——**全部 no-network**：JWT 注入自签 RS256 静态密钥
 * （不触真 JWKS）、daily-cap 注入内存/抛错桩（不触真 Redis）、handler 注入 fake（不触真 LLM/DB）。
 *
 * 覆盖：
 * - in-app JWT：无 CF 头 → 401；伪造/异 aud token → 401；合法 token → 放行；未配置 → 503 fail-closed。
 * - 每日成本地板：越限 fail-closed（429，不调 handler）；Redis 抛错 fail-closed（allowed=false）。
 * - 输入下限：超 `RAG_MAX_QUERY_CHARS` 拒绝（400，不调 handler）。
 */
import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import type { Hono, MiddlewareHandler } from 'hono';
import type { HandlerContext, HandlerResult } from '../../handler.js';
import type { AdvisorDeps } from '../advisor-page.js';

let cfAccessJwt: typeof import('../../jwt-middleware.js').cfAccessJwt;
let checkAndBumpDailyCap: typeof import('../../daily-cap.js').checkAndBumpDailyCap;
let createAdvisorApp: typeof import('../advisor-page.js').createAdvisorApp;

const AUD = 'test-aud-tag';
const ISS = 'https://team.cloudflareaccess.com';
const KID = 'test-kid';

// 自签 RS256 测试密钥对（no-network JWT seam：静态 keys，不触真 JWKS）。
const kpA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kpB = generateKeyPairSync('rsa', { modulusLength: 2048 }); // 用于伪造（异密钥同 kid）签名。
const privJwkA = { ...(kpA.privateKey.export({ format: 'jwk' }) as object), alg: 'RS256', kid: KID };
const privJwkB = { ...(kpB.privateKey.export({ format: 'jwk' }) as object), alg: 'RS256', kid: KID };
const pubJwkA = { ...(kpA.publicKey.export({ format: 'jwk' }) as object), alg: 'RS256', kid: KID };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Jwk = any;

async function makeToken(
  privJwk: Jwk,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ aud: AUD, iss: ISS, exp: now + 3600, iat: now, sub: 'u@example.com', ...claims }, privJwk, 'RS256');
}

/** 静态密钥 JWT 中间件（prod 用 jwksUri；测试用 keys）。 */
function testJwt() {
  return cfAccessJwt({ aud: AUD, iss: ISS, keys: [pubJwkA] });
}

function cookie(token: string): { headers: Record<string, string> } {
  return { headers: { cookie: `CF_Authorization=${token}` } };
}

const OK_RESULT: HandlerResult = {
  domain: '本域',
  answer: '这是一个有据回答。',
  citations: [{ kb_id: 'kb-1', source_url: 'https://example.com/1', snippet: '摘要一' }],
  trace: { rawQuery: 'q', rewrittenQuery: 'q', hitKbIds: ['kb-1'], topCosine: 0.8, priceGate: false },
  evidence: '有据',
};

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  ({ cfAccessJwt } = await import('../../jwt-middleware.js'));
  ({ checkAndBumpDailyCap } = await import('../../daily-cap.js'));
  ({ createAdvisorApp } = await import('../advisor-page.js'));
});

/** 组装一个注入了 no-network 依赖的 advisor app。 */
function buildApp(over: Partial<AdvisorDeps> = {}): {
  app: Hono;
  handleFn: ReturnType<typeof vi.fn>;
} {
  const handleFn = vi.fn(async (_q: string, _ctx: HandlerContext) => OK_RESULT);
  const deps: AdvisorDeps = {
    jwt: testJwt(),
    handleFn,
    readHistoryFn: async () => [],
    checkCapFn: async () => ({ allowed: true, count: 1 }),
    newConversationId: () => 'conv-fixed',
    maxQueryChars: 4000,
    ...over,
  };
  const app = createAdvisorApp(deps);
  return { app, handleFn };
}

describe('in-app CF Access JWT（no-network 静态密钥）', () => {
  it('无 CF_Authorization → 401（拒绝无头）', async () => {
    const { app } = buildApp();
    const res = await app.request('/advisor');
    expect(res.status).toBe(401);
  });

  it('畸形 cookie token → 401（拒绝伪头）', async () => {
    const { app } = buildApp();
    const res = await app.request('/advisor', cookie('not-a-jwt'));
    expect(res.status).toBe(401);
  });

  it('异密钥签名（伪造，同 kid）→ 401', async () => {
    const { app } = buildApp();
    const forged = await makeToken(privJwkB);
    const res = await app.request('/advisor', cookie(forged));
    expect(res.status).toBe(401);
  });

  it('异 aud → 401（校验 aud）', async () => {
    const { app } = buildApp();
    const wrongAud = await makeToken(privJwkA, { aud: 'other-aud' });
    const res = await app.request('/advisor', cookie(wrongAud));
    expect(res.status).toBe(401);
  });

  it('合法 token → 放行（200，reaches GET handler）', async () => {
    const { app } = buildApp();
    const token = await makeToken(privJwkA);
    const res = await app.request('/advisor', cookie(token));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AI 情报问答');
  });

  it('未配置（空 aud）→ 503 fail-closed，绝不放行', async () => {
    const app = createAdvisorApp({
      jwt: cfAccessJwt({ aud: '', iss: '' }),
      readHistoryFn: async () => [],
    });
    const token = await makeToken(privJwkA);
    const res = await app.request('/advisor', cookie(token));
    expect(res.status).toBe(503);
  });
});

describe('每日成本地板 checkAndBumpDailyCap（fake redis，no-network）', () => {
  function memRedis(store: Record<string, number> = {}) {
    return {
      incr: async (k: string) => (store[k] = (store[k] ?? 0) + 1),
      expire: vi.fn(async () => 1),
    };
  }

  it('未越限放行、达上限后 fail-closed', async () => {
    const redis = memRedis();
    const now = () => new Date('2026-07-12T00:00:00Z');
    const r1 = await checkAndBumpDailyCap({ redis, cap: 2, now });
    const r2 = await checkAndBumpDailyCap({ redis, cap: 2, now });
    const r3 = await checkAndBumpDailyCap({ redis, cap: 2, now });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false); // 第 3 次 count=3 > cap=2 → 越限 fail-closed
    expect(r3.count).toBe(3);
    // 每次 INCR 都幂等续 TTL（NX），防无 TTL 孤儿键。
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('rag:llmcalls:2026-07-12'), expect.any(Number), 'NX');
  });

  it('Redis 抛错 → fail-closed（allowed=false，绝不 fail-open）', async () => {
    const redis = {
      incr: async () => {
        throw new Error('redis down');
      },
      expire: async () => 1,
    };
    const r = await checkAndBumpDailyCap({ redis, cap: 100 });
    expect(r.allowed).toBe(false);
    expect(r.count).toBeNull();
  });
});

describe('POST /advisor 输入下限 + cap fail-closed（passthrough jwt）', () => {
  const passthrough: MiddlewareHandler = async (_c, next) => next();
  const postBody = (query: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `query=${encodeURIComponent(query)}`,
  });

  it('query 超 RAG_MAX_QUERY_CHARS → 400 拒绝、不调 handler', async () => {
    const { app, handleFn } = buildApp({ jwt: passthrough, maxQueryChars: 10 });
    const res = await app.request('/advisor', postBody('x'.repeat(20)));
    expect(res.status).toBe(400);
    expect(handleFn).not.toHaveBeenCalled();
  });

  it('每日上限已满（checkCapFn allowed=false）→ 429、不调 handler', async () => {
    const { app, handleFn } = buildApp({
      jwt: passthrough,
      checkCapFn: async () => ({ allowed: false, count: 999 }),
    });
    const res = await app.request('/advisor', postBody('正常长度问题'));
    expect(res.status).toBe(429);
    expect(handleFn).not.toHaveBeenCalled();
  });

  it('合法提交 → 调 handler 一次、200 渲染本轮引用', async () => {
    const { app, handleFn } = buildApp({
      jwt: passthrough,
      readHistoryFn: async () => [
        {
          turn: 1,
          rawQuery: '最近发生了什么？',
          rewrittenQuery: '最近 AI 行业发生了什么',
          hitKbIds: ['kb-1'],
          answer: OK_RESULT.answer,
          evidence: '有据',
          model: 'openai/gpt-4o-mini',
          createdAt: new Date(),
        },
      ],
    });
    const res = await app.request('/advisor', postBody('最近发生了什么？'));
    expect(res.status).toBe(200);
    expect(handleFn).toHaveBeenCalledTimes(1);
    const html = await res.text();
    expect(html).toContain('引用证据');
    expect(html).toContain('最近 AI 行业发生了什么'); // trace 披露 rewrittenQuery（纯转义）
  });

  it('原始 body 超 64KiB → 413 拒绝、不调 handler（parseBody 之前挡下）', async () => {
    const { app, handleFn } = buildApp({ jwt: passthrough, maxQueryChars: 4000 });
    const oversized = 'query=' + 'x'.repeat(70 * 1024);
    const res = await app.request('/advisor', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(handleFn).not.toHaveBeenCalled();
  });
});

describe('conversation_id 服务端签发校验（拒客户端伪造/超长）', () => {
  const passthrough: MiddlewareHandler = async (_c, next) => next();
  const CONV_COOKIE = 'advisor_conversation';
  const MINTED = '11111111-1111-4111-8111-111111111111';

  it('伪造（非 UUID）cookie → 服务端重签新会话（Set-Cookie 换成签发 UUID）', async () => {
    const { app } = buildApp({ jwt: passthrough, newConversationId: () => MINTED });
    const res = await app.request('/advisor', { headers: { cookie: `${CONV_COOKIE}=not-a-uuid` } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${CONV_COOKIE}=${MINTED}`);
    expect(setCookie).not.toContain('not-a-uuid');
  });

  it('超长（>128 字）cookie → 服务端重签（防撞 varchar(128) 列约束报 500）', async () => {
    const { app } = buildApp({ jwt: passthrough, newConversationId: () => MINTED });
    const oversized = 'a'.repeat(200);
    const res = await app.request('/advisor', { headers: { cookie: `${CONV_COOKIE}=${oversized}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${CONV_COOKIE}=${MINTED}`);
  });

  it('合法 UUID cookie → 复用（不重签、readHistory 用该 id）', async () => {
    const readHistoryFn = vi.fn(async () => []);
    const { app } = buildApp({ jwt: passthrough, readHistoryFn });
    const validId = '22222222-2222-4222-8222-222222222222';
    const res = await app.request('/advisor', { headers: { cookie: `${CONV_COOKIE}=${validId}` } });
    expect(res.status).toBe(200);
    expect(readHistoryFn).toHaveBeenCalledWith('local', validId);
    expect(res.headers.get('set-cookie')).toBeNull(); // 复用不重签
  });
});
