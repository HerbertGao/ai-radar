/**
 * Model Radar `/model-radar` 公开页 `llm` 解释的**整条解释缓存 + 进程内单飞**（web-only，
 * add-model-radar-explain-public-cost-bound 组 C，spec「公开 web 页 llm 解释的成本边界」/ design D1·D4·D5）。
 *
 * web 侧模块（有全 env、可用 Redis）——**非** env-clean（env-clean 是 MCP / explain-llm.ts 的铁律，与本模块无关）。
 * MCP 路径不 import 本模块（web 缓存不漂进 MCP env-clean 链，静态钉见 task 2.3）。
 *
 * 三件事：
 * - `computeSetupHash`：把 `RecommendInput` 稳定哈希成缓存副键——**凡影响 recommend() 输出的字段皆入 hash**，
 *   **先套 recommend() 缺省（currency??CNY、usageProfile??medium）再哈希**（`{}` 与 `{CNY,medium}` 同 hash）。
 * - `get/setCachedExplanation`：Redis 键 `mr:explain:<version>:<setupHash>`、TTL 15min、**fail-open**（读写抛错 ⇒
 *   get 返 null（未命中）、set 静默不抛）——缓存故障绝不阻塞或使页失败。
 * - `withSingleFlight`：进程内 `Map<key, Promise>` 单飞（仿快照 `cache.ts` 的进程内 Promise 单飞、本模块多缓存键用
 *   Map），收敛 cache stampede 为至多 1 次 produce；settle 后清键、可重试。部署单实例故进程内足够（多实例升级路径见
 *   design D4：届时改 Redis 租约）。
 */
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { DEFAULT_CURRENCY, DEFAULT_USAGE, type RecommendInput } from '../recommend/recommend.js';

/** 叙述—证据新鲜度的唯一界（version 正交的 KB 新增 / price_history 回填 / 待复核 均由 TTL 统一兜住陈旧）。 */
export const EXPLAIN_CACHE_TTL_MS = 15 * 60 * 1000;

/** 本模块所需的最小 Redis 能力面（便于测试注入内存/抛错桩；真实用 ioredis）。 */
export interface ExplainCacheRedis {
  get(key: string): Promise<string | null>;
  /** `SET key value PX ttlMs`（写入即带 TTL；无需 NX——缓存值 = (version,setupHash) 纯函数、覆盖即幂等）。 */
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
}

export interface ExplainCacheDeps {
  /** 注入 Redis（默认懒建的模块级单连接）。测试注入内存桩或抛错桩。 */
  redis?: ExplainCacheRedis;
}

let sharedRedis: Redis | undefined;
function defaultRedis(): ExplainCacheRedis {
  if (!sharedRedis) {
    // maxRetriesPerRequest:1 + commandTimeout：Redis 不可达时 get/set 快速 reject → fail-open（非无限阻塞）。
    sharedRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 3000 });
    // 失败语义由各调用点 try/catch fail-open 承载；吞 error 事件避免不可达时刷屏。
    sharedRedis.on('error', () => {});
  }
  return sharedRedis as unknown as ExplainCacheRedis;
}

/**
 * `RecommendInput` → 稳定缓存副键（sha256 hex）。**固定字段序** + 数值 canonical 化后稳定序列化再哈希。
 *
 * 入 hash 的字段 = `RecommendInput` 全部**影响 recommend() 输出**者（按 recommend.ts 核对）：
 * `model` / `tool` / `protocol`（喂 recall query）、`currency`（锁币种组）、`maxMonthlyPrice`（超预算判级）、
 * `usageProfile`（用量档旋钮 → fitsWindow）。`render_now` 与 web-only `tokensPerRound` **不入** `RecommendInput`、
 * 天然不参与。
 *
 * **先套 recommend() 缺省再哈希**（`currency ?? DEFAULT_CURRENCY`、`usageProfile ?? DEFAULT_USAGE`）——使
 * `{}` 与显式 `{currency:'CNY', usageProfile:'medium'}` 同 hash（免语义同而 hash 异的额外未命中；过缓存安全向、
 * 非错缓存）。缺省常量 import 自 recommend.ts（single source，防漂移）。
 *
 * `maxMonthlyPrice` 数值归一（`Number()`）：连续数值**不离散化**（不同预算 ⇒ 不同推荐 ⇒ 不可共享缓存）；
 * `undefined`（无预算约束，语义 ≠ 任一数值）序列化为 `null`、与任一数值 hash 不同。
 */
export function computeSetupHash(input: RecommendInput): string {
  // 固定字段序对象字面量 ⇒ JSON.stringify 输出确定；缺省与数值归一在此就地套。
  const canonical = {
    model: input.model ?? null,
    tool: input.tool ?? null,
    protocol: input.protocol ?? null,
    currency: input.currency ?? DEFAULT_CURRENCY,
    usageProfile: input.usageProfile ?? DEFAULT_USAGE,
    maxMonthlyPrice: input.maxMonthlyPrice === undefined ? null : Number(input.maxMonthlyPrice),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function explainKey(version: string, setupHash: string): string {
  return `mr:explain:${version}:${setupHash}`;
}

/**
 * 读缓存的 explainer 叙述串（= explainer 返回值，**不含 recommend() 的 guidance 前缀**）。
 * **fail-open**：未命中 / Redis 不可用 / 读抛错 ⇒ 返 `null`（当作未命中，调用方走正常装配路径）。
 */
export async function getCachedExplanation(
  version: string,
  setupHash: string,
  deps: ExplainCacheDeps = {},
): Promise<string | null> {
  const redis = deps.redis ?? defaultRedis();
  try {
    return await redis.get(explainKey(version, setupHash));
  } catch {
    return null; // fail-open：缓存故障视为未命中，绝不阻塞或使页失败。
  }
}

/**
 * 写缓存 explainer 叙述串（`explanation` = explainer 返回值、**不含 guidance**；带 `EXPLAIN_CACHE_TTL_MS`）。
 * **fail-open**：Redis 不可用 / 写抛错 ⇒ 静默不抛（写缓存是尽力而为、失败不影响本次响应）。
 */
export async function setCachedExplanation(
  version: string,
  setupHash: string,
  explanation: string,
  deps: ExplainCacheDeps = {},
): Promise<void> {
  const redis = deps.redis ?? defaultRedis();
  try {
    await redis.set(explainKey(version, setupHash), explanation, 'PX', EXPLAIN_CACHE_TTL_MS);
  } catch {
    // fail-open：写缓存失败静默——不固化错误、不阻塞响应。
  }
}

/** 进行中的 produce（按缓存键去重并发；仿快照 cache.ts 的进程内 Promise 单飞、多键故用 Map）。 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * 进程内单飞：同 `key` 并发调用复用同一 `produce()` promise（首个真跑、其余 `await` 同一 promise 得同结果），
 * 收敛 cache stampede 为至多 1 次 `produce`。promise settle（成/败）后清除该键。
 *
 * **fail-open**：`produce()` 抛错 ⇒ 清键 + 拒绝传播给全部 awaiter（各自回落由调用方处理、不缓存、下次可重试）。
 * 部署单实例故进程内足够（多实例共享 Redis 缓存时升级为 Redis 租约，见 design D4）。
 */
export function withSingleFlight<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  // settle 后清键（.finally 对成/败都触发）——同键后续调用可重新 produce（含首个失败后重试）。
  const p = produce().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}
