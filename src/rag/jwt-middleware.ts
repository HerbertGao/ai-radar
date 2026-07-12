/**
 * `/advisor` in-app CF Access JWT 校验中间件（add-conversational-rag / Plan A A3，design D10 /
 * spec「公开 Web 出口多层防护与最小下限」「直连绕过边缘鉴权被 in-app 拦」）。
 *
 * 承重层（非单点）：即便 CF Access 边缘误配 / 请求直连绕过 origin，本中间件仍拦住 `/advisor`。
 * **不手写 RS256/JWKS**（那是过度工程 + 踩自造密码学）——用 Hono 内置 `hono/jwk`，但须读
 * **`CF_Authorization` cookie 的裸 JWT**：`hono/jwk` 的 header 路径强制 `Bearer <token>` 两段式，
 * 而 CF 的 `Cf-Access-Jwt-Assertion` header 是裸 token；CF 登录后同时下发 `CF_Authorization` cookie
 * （裸 token）→ 用 `cookie: 'CF_Authorization'` 选项走裸 token 分支（评审已核实此坑）。
 *
 * 结构化红线（design D10）：
 * - 校验 `aud`(CF_ACCESS_AUD) + `iss`(team 域) + 默认 `exp`；**pin `alg: ['RS256']`**
 *   （省 alg → `hono/jwk` 的 `allowedAlgorithms` undefined → `undefined.includes()` 抛错、端点整个不可用）。
 * - **JWKS 拉取失败 / 任何校验异常 → fail-closed 拒绝**（绝不 fail-open）。内置无缓存、每请求 fetch
 *   （WAF 限流 + CF JWKS 高可用下可接受；**不宣称带缓存**）。
 * - **no-network 测试 seam**：测试传静态 `keys`（自签 RS256 测试密钥对）、prod 传 `jwks_uri`。
 * - **未配置 → fail-closed 拒绝服务**（CF_ACCESS_AUD/CF_ACCESS_TEAM_DOMAIN 任一为空）：不半开放公开
 *   LLM 端点，也不影响 worker / 纯 Model Radar 部署启动（这两项 env 可选、默认空）。
 * - 只挂 `/advisor/*`、**不挂**公开只读的 Model Radar 路由；跑在 daily-cap 与任何 LLM 调用**之前**。
 */
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { jwk } from 'hono/jwk';
import { env } from '../config/env.js';

/** `hono/jwk` 的 `keys` 参数类型（静态 JWK 数组分支；no-network 测试 seam 用）。 */
type JwkKeys = NonNullable<Parameters<typeof jwk>[0]['keys']>;

export interface CfAccessJwtOptions {
  /** CF Access 应用 AUD tag（校验 `aud`）。 */
  aud: string;
  /** 期望 issuer（如 `https://myteam.cloudflareaccess.com`）。 */
  iss: string;
  /** prod：CF team JWKS 端点（每请求 fetch，失败 fail-closed）。 */
  jwksUri?: string;
  /** 测试：静态公钥 JWK（自签测试密钥对；传此则不触网）。 */
  keys?: JwkKeys;
}

/**
 * 构造 `/advisor` 的 CF Access JWT 校验中间件。
 *
 * 成功放行（`next()`）；无/伪/过期/异 aud/异 iss token → 401；JWKS 拉取失败或任何异常 → fail-closed
 * （503，绝不放行）。`keys` 与 `jwksUri` 至少给一个，否则视为未配置 → 恒 503（fail-closed）。
 */
export function cfAccessJwt(opts: CfAccessJwtOptions): MiddlewareHandler {
  const hasVerifier = Boolean((opts.keys && opts.keys.length > 0) || opts.jwksUri);
  // 未配置校验源（无 keys 也无 jwks_uri）或缺 aud → fail-closed 拒绝服务，绝不放行未鉴权流量。
  if (!hasVerifier || opts.aud.length === 0 || opts.iss.length === 0) {
    return async (c) =>
      c.json(
        { error: '/advisor 未配置 CF Access 校验（CF_ACCESS_AUD / CF_ACCESS_TEAM_DOMAIN），拒绝服务' },
        503,
      );
  }

  const inner = jwk({
    cookie: 'CF_Authorization', // CF 下发的裸 JWT cookie（绕开 hono/jwk header 路径的 Bearer 强制）。
    ...(opts.keys ? { keys: opts.keys } : {}),
    ...(opts.jwksUri ? { jwks_uri: opts.jwksUri } : {}),
    verification: { aud: opts.aud, iss: opts.iss }, // exp 默认校验；不 pin alg 会令端点不可用。
    alg: ['RS256'],
  });

  return async (c, next) => {
    try {
      return await inner(c, next);
    } catch (err) {
      // hono/jwk 对无/伪/过期 token 抛 HTTPException(401)——原样透传其 401 响应。
      if (err instanceof HTTPException) throw err;
      // 非 HTTPException 异常（JWKS 非 200 的裸 Error、配置缺失等）→ 统一 503。注：网络级 JWKS 失败会被
      // hono 内部包成 HTTPException(401) 走上面透传——故 JWKS 不可达时状态码可能是 401 或 503，二者**皆
      // fail-closed 拒绝、绝不 fail-open**（无论哪条路径都不 next()、不放行未鉴权流量）。
      console.error('[advisor-jwt] JWKS/JWT 校验异常，fail-closed 拒绝', err);
      return c.json({ error: '访问凭据校验失败（fail-closed）' }, 503);
    }
  };
}

/**
 * 从全局 env 构造 prod 中间件：team 域派生 `iss` + `jwks_uri`；aud/域任一为空 → fail-closed 拒绝服务。
 * 测试**不**走此函数（用 `cfAccessJwt({ keys })` no-network seam）。
 */
export function cfAccessJwtFromEnv(): MiddlewareHandler {
  // `?? ''` 容缺失字段（app.ts 于模块加载即构造本中间件；部分 env mock 可能不含这两项）——缺失 → 走下方
  // fail-closed 拒绝服务分支，绝不抛错破坏 app 装配。
  const team = (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim();
  const aud = (env.CF_ACCESS_AUD ?? '').trim();
  if (team.length === 0 || aud.length === 0) {
    return cfAccessJwt({ aud: '', iss: '' }); // 未配置 → 恒 503 fail-closed。
  }
  return cfAccessJwt({
    aud,
    iss: `https://${team}`,
    jwksUri: `https://${team}/cdn-cgi/access/certs`,
  });
}
