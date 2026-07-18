/**
 * 对话 RAG 公开端点每日 LLM 调用上限（add-conversational-rag / Plan A A3，design D11 /
 * spec「超出每日调用上限 fail-closed」）。
 *
 * 公开 LLM 端点的**成本安全地板**：全局每日 LLM 调用上限，防单个已鉴权会话秒级刷穿、无界烧 OpenRouter。
 *
 * 关键不变量（design D11，绝不违背）：
 * - **Redis 计数、非内存**：`INCR <namespace>:llmcalls:<UTC-date>`（namespace 默认 `'rag'`，见 dailyCapKey）——
 *   抗进程重启归零、按日期自动滚动、多进程正确。
 * - **每次 INCR 都幂等 `EXPIRE key ttl NX`**（镜像 `alert-lock.ts` 的 `SET NX PX` 原子惯用法）：
 *   防 INCR 后、EXPIRE 前崩留下**无 TTL 孤儿键**（否则该日键永不过期、次日仍计旧数 → 永久 fail-closed）。
 * - **越限 fail-closed**：当日计数达上限 → 拒绝作答（不发起 LLM）。
 * - **Redis 不可用亦 fail-closed**：`incr`/`expire` 抛错 → 拒绝作答（不静默放行）——成本兜底绝不 fail-open。
 *
 * ponytail: 每提交一次 `/advisor` 作答 POST 记一次（每次触发 ≥1 次 rewrite/作答 LLM 调用）——粗粒度地板足矣，
 * 精确 per-call 计数留待专业成本栈（design 非目标）。
 */
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * 计数键按 UTC 自然日滚动（跨进程/跨时区一致，与 push_date 无关——纯成本地板）。
 * `namespace` 默认 `'rag'` ⇒ 键 `rag:llmcalls:<date>` 与 advisor 现状逐字节不变；model-radar 显式传 `'mr'`
 * 得独立预算键 `mr:llmcalls:<date>`（两面预算互不影响）。
 */
export function dailyCapKey(now: Date = new Date(), namespace = 'rag'): string {
  return `${namespace}:llmcalls:${now.toISOString().slice(0, 10)}`;
}

/** 键 TTL（秒）：~48h，覆盖当日 + 跨 UTC 零点裕量；键含日期、过期即自然清理（防孤儿键）。 */
const KEY_TTL_SECONDS = 48 * 60 * 60;

/** 本模块所需的最小 Redis 能力面（便于测试注入内存桩；真实用 ioredis）。 */
export interface DailyCapRedis {
  incr(key: string): Promise<number>;
  /** `EXPIRE key seconds NX`（仅在无 TTL 时设，幂等；Redis 7+）。 */
  expire(key: string, seconds: number, nx: 'NX'): Promise<number>;
}

export interface DailyCapDeps {
  /** 注入 Redis（默认懒建的模块级单连接）。测试注入内存桩或抛错桩。 */
  redis?: DailyCapRedis;
  /** 每日上限（默认 env.RAG_DAILY_LLM_CALL_CAP）。 */
  cap?: number;
  /** 计数键的“现在”（默认 new Date()），供测试固定 UTC 日期。 */
  now?: () => Date;
  /**
   * 计数键命名空间（默认 `'rag'` ⇒ advisor 键与行为逐字节不变）。model-radar 传 `'mr'` 得独立预算键，
   * 两面预算互不影响。
   */
  namespace?: string;
}

export interface DailyCapResult {
  /**
   * true → 未越限、可发起作答；false → 越限或 Redis 不可用。**函数绝不 fail-open 放行**，但
   * `allowed=false` 的处置留给调用方：advisor fail-closed 拒服务、model-radar fail-open 回落模板。
   */
  allowed: boolean;
  /** 本次 INCR 后的当日计数（Redis 不可用时为 null）。 */
  count: number | null;
  /**
   * `allowed=false` 的原因（`allowed=true` 时 undefined），供调用方两态分别观测：
   * `'quota-exceeded'`=当日达上限（成本放大）；`'infra-error'`=Redis 不可用（可用性降级、非成本放大）。
   */
  reason?: 'quota-exceeded' | 'infra-error';
}

let sharedRedis: Redis | undefined;
function defaultRedis(): DailyCapRedis {
  if (!sharedRedis) {
    // maxRetriesPerRequest:1 + commandTimeout：Redis 不可达时 incr 快速 reject → fail-closed（非无限阻塞）。
    sharedRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 3000 });
    // 失败语义由 checkAndBumpDailyCap 的 try/catch fail-closed 承载；吞 error 事件避免不可达时刷屏。
    sharedRedis.on('error', () => {});
  }
  return sharedRedis as unknown as DailyCapRedis;
}

/**
 * 记一次调用并判是否越限（**先 INCR 再判**，恰好放行 `cap` 次/日）。
 *
 * 越限 → `{ allowed: false, reason: 'quota-exceeded' }`；Redis 抛错（不可达/超时）→
 * `{ allowed: false, count: null, reason: 'infra-error' }`（函数绝不 fail-open 放行；`allowed=false`
 * 的 deny/降级处置由调用方决定）。EXPIRE 失败不影响本次判定（TTL 是防孤儿键的兜底、非放行前置）——
 * 但仍在 try 内、抛错同上走 infra-error。
 */
export async function checkAndBumpDailyCap(deps: DailyCapDeps = {}): Promise<DailyCapResult> {
  const redis = deps.redis ?? defaultRedis();
  const cap = deps.cap ?? env.RAG_DAILY_LLM_CALL_CAP;
  const namespace = deps.namespace ?? 'rag';
  const key = dailyCapKey(deps.now ? deps.now() : new Date(), namespace);
  try {
    const count = await redis.incr(key);
    // 幂等续 TTL：仅当键当前无 TTL 时设（NX），防 INCR 后崩留无 TTL 孤儿键（design D11）。
    await redis.expire(key, KEY_TTL_SECONDS, 'NX');
    return count <= cap
      ? { allowed: true, count }
      : { allowed: false, count, reason: 'quota-exceeded' };
  } catch (err) {
    // Redis 不可用即 allowed=false（infra-error）——两态分别记日志/指标的落点在调用方（持完整结果）；
    // 此处只记中性 infra-error 通用日志（去 advisor 专属「拒绝作答」措辞，本函数已被 mr 复用）。
    console.error(`[daily-cap] Redis 不可用（namespace=${namespace}），allowed=false（reason=infra-error）`, err);
    return { allowed: false, count: null, reason: 'infra-error' };
  }
}
