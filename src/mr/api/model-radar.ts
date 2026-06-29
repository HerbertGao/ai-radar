/**
 * Model Radar（P5 / 5c，add-model-radar-compare-api）只读比价 HTTP 路由（组 E，task 4.1–4.3）。
 *
 * 两个 GET 路由，挂到 src/app.ts；**请求路径只读**——只经 `getSnapshot`（组 D 缓存层）读进程内快照，
 * 绝不写 `mr_*`/既有表、不在请求路径触发 rebuild/bump（spec「API 与快照路径只读、不碰既有表」）：
 * - `GET /model-radar/snapshot`：返回服务表征公开子集 + version/ETag。**version/ETag 唯一来源 = 内容哈希**
 *   （组 D `CachedSnapshot.version`，design D8）；设 `ETag` 头、处理 `If-None-Match` → 304。不 bump catalog。
 * - `GET /model-radar/plans`：用组 C `modelRadarQueryParamsSchema` 解析 query（Zod），失败 → 400
 *   （含裸 family、currency×maxMonthlyPrice 不一致等，组 C schema 已覆盖）；成功 → `queryModelRadarSnapshot`。
 *
 * **冷启动首建失败 → 503**：`getSnapshot`（默认 = 组 D `getModelRadarSnapshot`，冷启动失败上抛）抛错时
 * 返回 503、不返回坏快照（spec「冷启动首建即失败时 API 返回 503」）。
 *
 * 仿 `createHealthApp` 的可注入风格：`getSnapshot` 可注入，使路由能用 `app.request(...)` 直接测（合成快照、不触 DB）。
 */
import { Hono } from 'hono';
import { getModelRadarSnapshot, type CachedSnapshot } from '../snapshot/cache.js';
import { modelRadarQueryParamsSchema, queryModelRadarSnapshot } from '../snapshot/query.js';

/** 快照取用函数（默认走组 D 缓存；测试注入合成快照提供者，不触 DB）。 */
export type SnapshotProvider = () => Promise<CachedSnapshot>;

/** 默认提供者：组 D 缓存（warm 命中不触 DB；冷启动首建失败上抛 → 路由接 503）。 */
const defaultProvider: SnapshotProvider = () => getModelRadarSnapshot();

/**
 * `If-None-Match` 是否匹配当前内容哈希。
 * 容忍逗号列表、`W/` 弱校验前缀与外层引号；`*` 匹配任意（资源恒存在）。
 */
function ifNoneMatchHit(header: string | undefined, version: string): boolean {
  if (!header) return false;
  return header.split(',').some((raw) => {
    const t = raw.trim();
    if (t === '*') return true;
    return t.replace(/^W\//, '').replace(/^"|"$/g, '') === version;
  });
}

/**
 * 构造挂载了 Model Radar 只读路由的 Hono app。
 * @param getSnapshot 快照提供者（默认组 D 缓存；测试注入合成快照）。
 */
export function createModelRadarApp(getSnapshot: SnapshotProvider = defaultProvider): Hono {
  const app = new Hono();

  app.get('/model-radar/snapshot', async (c) => {
    let cached: CachedSnapshot;
    try {
      cached = await getSnapshot();
    } catch (err) {
      // 冷启动首建失败：不返回坏快照（spec），如实 503。记 server 端日志区分 transient DB 故障与坏快照。
      console.error('[model-radar] /snapshot 快照不可用（冷启动首建或重建失败）', err);
      return c.json({ error: 'snapshot unavailable' }, 503);
    }

    const etag = `"${cached.version}"`;
    c.header('ETag', etag);
    if (ifNoneMatchHit(c.req.header('If-None-Match'), cached.version)) {
      return c.body(null, 304);
    }
    // 公开子集 = 服务表征快照；version 是内容哈希的传输别名（包在响应外层，不入哈希输入）。
    return c.json({ version: cached.version, snapshot: cached.snapshot });
  });

  app.get('/model-radar/plans', async (c) => {
    // 先 Zod 闸：非法参数（裸 family / 未知参数 / 非法枚举 / 裸预算 / 币种不一致）→ 400，
    // 与快照可用性无关（即便冷启动会 503，错误参数也先 400）。
    const parsed = modelRadarQueryParamsSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }

    let cached: CachedSnapshot;
    try {
      cached = await getSnapshot();
    } catch (err) {
      console.error('[model-radar] /plans 快照不可用（冷启动首建或重建失败）', err);
      return c.json({ error: 'snapshot unavailable' }, 503);
    }

    return c.json(queryModelRadarSnapshot(cached.snapshot, parsed.data));
  });

  return app;
}
