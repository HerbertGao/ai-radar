/**
 * Model Radar 只读比价 **Web 页**（5d-B / add-model-radar-compare-web-page，组 B1，task 2.1/2.2/2.3/4.3）。
 *
 * `GET /model-radar`：Hono JSX SSR。**只读**——经组 D `getModelRadarSnapshot()` 取进程内快照、SSR 出 HTML；
 * 不查规范化 `mr_*` 表、不写库、不 bump version（design D3）。
 *
 * 关键不变量：
 * - **不挂 version-304**（design D3 / spec）：每请求以 live `render_now`（`new Date()`）重渲——HTML 含 render-time
 *   相对 age（「N 天前」），用 snapshot version 作 ETag 会在快照未变而日界已过时服务陈旧「今日」。JSON
 *   `/model-radar/snapshot`（api/model-radar.ts）的内容哈希 ETag 不受本页影响。
 * - **冷启动首建失败 → 503**（沿用 5c fail-closed，镜像 api/model-radar.ts 的 try/catch），不渲坏快照。
 * - **桶2 UI gate**（task 4.3）：把 `category:'coding_plan'` 强行注入查询参数（枚举字面）——用户无 category chip、
 *   不读用户传入的 category，故无文档化手段切桶；不动数据层。
 * - **money-path 经 vetted 函数**（design D4）：过滤/排序/最划算由 `queryModelRadarSnapshot` 决定；只把 API 子集
 *   喂 `.strict()` `modelRadarQueryParamsSchema`（ZodError→400），web-only 参数（`sort`）留 schema 外、render 层用。
 * - **安全头**（design D7）：CSP `default-src 'none'` 收口 + `script-src 'self'` + `style-src 'self' 'unsafe-inline'`
 *   （容内联 `<style>`——`default-src 'none'` 配**显式** style-src 不拦内联样式，与禁 `default-src 'self'` 不矛盾）
 *   + `base-uri 'none'`（防注入 `<base>` 劫持相对链接，对 5d-C 流入抓取内容尤要）+ `form-action 'self'`
 *   + `frame-ancestors 'none'`（防点击劫持）。`source_url` 经 render 层 `safeHref` scheme 闸（主防线）。
 *
 * 仿 api/model-radar.ts 的可注入风格：`getSnapshot` 可注入，使 `app.request('/model-radar')` 直接测（合成快照、不触 DB）。
 */
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Child } from 'hono/jsx';
import { getModelRadarSnapshot, type CachedSnapshot } from '../snapshot/cache.js';
import { modelRadarQueryParamsSchema, queryModelRadarSnapshot } from '../snapshot/query.js';
import { ComparePage, PageShell, type WebQuery } from './components.js';
import { facetOptions, resolveTokensPerRound, type FreshnessSort } from './render.js';

// default-src 'none' 收口未声明取数指令（object/connect/img…全拦）；显式 style-src 容内联 <style>；
// font-src 'self' 放行同源自托管 webfont（未列 font-src 时字体由 default-src 'none' 兜底拦截），且不放行任何
// 外部/CDN 源——其余取数指令仍全拦；base-uri/form-action/frame-ancestors 补纵深（防 <base> 劫持 / 表单外泄
// / 点击劫持）。首个公开页基线。
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 本页桶2 gate（枚举字面，design D6/task 4.3）。 */
const GATE_CATEGORY = 'coding_plan';

/** 用户可经 query 调的 API 子集（category 由本页强注入、不读用户值；sort 是 web-only、不入 schema）。 */
const API_QUERY_KEYS = ['model', 'tool', 'protocol', 'currency', 'maxMonthlyPrice'] as const;

/** 快照取用函数（默认走组 D 缓存；测试注入合成快照，不触 DB）。 */
export type SnapshotProvider = () => Promise<CachedSnapshot>;
const defaultProvider: SnapshotProvider = () => getModelRadarSnapshot();

/** 从 query map 抽本页识别的 web 参数（透传给链接/chip/下拉预选）。 */
function readWebQuery(raw: Record<string, string | undefined>): WebQuery {
  const q: WebQuery = {};
  for (const k of API_QUERY_KEYS) {
    const v = raw[k];
    if (v != null && v.trim() !== '') q[k] = v;
  }
  if (raw.sort === 'stale' || raw.sort === 'fresh') q.sort = raw.sort;
  // 估算旋钮（web-only，不入 .strict() schema / 不进哈希）：**归一到预设值**再透传，使链接/chip 的 URL 参数
  // 与生效估算一致（防 `?tokensPerRound=9999` 表现为 15000 却把 9999 继续传播）。
  if (raw.tokensPerRound != null && raw.tokensPerRound.trim() !== '') {
    q.tokensPerRound = String(resolveTokensPerRound(raw.tokensPerRound));
  }
  return q;
}

/** 描述性 `<title>`（随筛选反映当前态，spec WCAG ⑧）。 */
function pageTitle(q: WebQuery): string {
  const parts = ['Model Radar 比价 · Coding Plan'];
  if (q.model) parts.push(`模型 ${q.model}`);
  if (q.tool) parts.push(`工具 ${q.tool}`);
  if (q.protocol) parts.push(`协议 ${q.protocol}`);
  if (q.currency) parts.push(`币种 ${q.currency}`);
  if (q.maxMonthlyPrice) parts.push(`预算 ${q.maxMonthlyPrice}`);
  return parts.join(' · ');
}

/** 渲染完整文档（带 doctype；组件无异步 → await 同步取串）。 */
async function renderDocument(title: string, body: Child): Promise<string> {
  const doc = await (<PageShell title={title}>{body}</PageShell>);
  return '<!DOCTYPE html>' + doc;
}

/**
 * 构造挂载了 Model Radar 比价 Web 页的 Hono app。
 * @param getSnapshot 快照提供者（默认组 D 缓存；测试注入合成快照）。
 */
export function createModelRadarWebApp(getSnapshot: SnapshotProvider = defaultProvider): Hono {
  const app = new Hono();

  // 自托管 Latin webfont（首个静态资源路由）。root 钉死到 `src/mr/web/assets`（唯一放行目录，MUST NOT
  // 放宽到仓库其它目录）；`rewriteRequestPath` 剥 `/model-radar/assets` 前缀映射到 root 下同名文件；路径穿越
  // （`../`、`\\`、`//`）由 serveStatic 在 rewrite 前拦截 → 404（见 @hono/node-server serve-static）。
  // 注意：serveStatic 的 root 是**进程 cwd 相对**——容器化 / 编译产物运行时工作目录须含 `src/mr/web/assets`
  //（GHCR 镜像须打进字体资产），否则 prod 字体 404（需 prod smoke 验证 /model-radar/assets/*.woff2 可达）。
  // 长缓存头在**外层中间件 after-next** 里落位，而非 serveStatic 的 `onFound`——该版本 @hono/node-server 的
  // onFound 在 `c.body()` 生成响应之后才回调，其时再写头不进响应；故只对已命中的 200 woff2 响应补 immutable
  // 缓存头（404 不缓存）。Content-Type `font/woff2` 由 serveStatic 自身 mime 查表已给出。
  app.use('/model-radar/assets/*', async (c, next) => {
    c.header('Content-Security-Policy', CSP); // 纵深防御：资源响应也携带 CSP（仅页面路由设不够）
    await next();
    if (c.res.status === 200 && c.req.path.endsWith('.woff2')) {
      c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  });
  app.use(
    '/model-radar/assets/*',
    serveStatic({
      root: 'src/mr/web/assets',
      rewriteRequestPath: (p) => p.replace(/^\/model-radar\/assets/, ''),
    }),
  );

  app.get('/model-radar', async (c) => {
    c.header('Content-Security-Policy', CSP);

    const raw = c.req.query();
    const webQuery = readWebQuery(raw);
    const sort: FreshnessSort | undefined = webQuery.sort as FreshnessSort | undefined;

    // 只把 API 子集喂 .strict() schema（去空值防 `?model=` 触 400；强注入 category gate；不读用户 category）。
    const apiInput: Record<string, string> = { category: GATE_CATEGORY };
    for (const k of API_QUERY_KEYS) {
      const v = raw[k];
      if (v != null && v.trim() !== '') apiInput[k] = v;
    }
    const parsed = modelRadarQueryParamsSchema.safeParse(apiInput);
    if (!parsed.success) {
      const html = await renderDocument(
        '筛选参数无效 · Model Radar',
        (
          <p>
            筛选参数无效（如模型须 <code>family:version</code>、预算须「数额 币种」如 <code>100 CNY</code>）。{' '}
            <a href="/model-radar">返回比价页</a>
          </p>
        ),
      );
      return c.html(html, 400);
    }

    let cached: CachedSnapshot;
    try {
      cached = await getSnapshot();
    } catch (err) {
      // 冷启动首建失败：不渲坏快照，如实 503（沿用 5c fail-closed）。
      console.error('[model-radar-web] /model-radar 快照不可用（冷启动首建或重建失败）', err);
      return c.json({ error: 'snapshot unavailable' }, 503);
    }

    const snapshot = cached.snapshot;
    // money-path：过滤/排序/最划算经 vetted 函数；裸快照只用于派生下拉选项（桶2 全集）。
    const result = queryModelRadarSnapshot(snapshot, parsed.data);
    const options = facetOptions(snapshot.plans.filter((p) => p.category === GATE_CATEGORY));
    // 「另有 N 未核未参与」的 N：跨引该 category 的 currency=null 组 unknownCount（已核组上恒 0，design D4）。
    const unknownGroup = result.groups.find((g) => g.sortScope.currency === null);
    const unknownInCategory = unknownGroup ? unknownGroup.unknownCount : 0;

    const now = new Date(); // live render_now：相对 age 每请求重算（不挂 version-304）。
    // 估算旋钮假设：web-only query-param、render 层算（不喂 .strict() schema、不进哈希，design D5）。
    const tokensPerRound = resolveTokensPerRound(raw.tokensPerRound);
    const body = (
      <ComparePage
        groups={result.groups}
        unknownInCategory={unknownInCategory}
        options={options}
        query={webQuery}
        now={now}
        tokensPerRound={tokensPerRound}
        {...(sort ? { sort } : {})}
      />
    );
    return c.html(await renderDocument(pageTitle(webQuery), body));
  });

  return app;
}
