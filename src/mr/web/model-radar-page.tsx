/**
 * Model Radar **答案优先 Web 页**（add-model-radar-answer-first-web，组 2：路由改答案优先 + setup 校验/适配边界）。
 *
 * `GET /model-radar`：Hono JSX SSR。**只读呈现层**——经组 D `getModelRadarSnapshot()` 取进程内快照，
 * 把校验后的 setup 参数适配成 `RecommendInput` → `await recommend()` → 按 `candidates[].verdict` 四态过滤装配
 * 答案卡 / 备选 / 说明 / 输入 / 证据抽屉。**零判定**：不查规范化 `mr_*` 表、不写库、不 bump version、
 * 不重排 / 不重判 / 不重算 primary、不手搓 cheapest（money-path/判定全在 `recommend.ts`/`queryModelRadarSnapshot`）。
 *
 * 关键不变量：
 * - **setup 校验/适配先于 `recommend()`**（design D8）：schema 参数（model/tool/protocol/currency/`maxMonthlyPrice`）
 *   经 `modelRadarQueryParamsSchema` 直接 `.parse()`（该 schema 已 strict + superRefine、是 `ZodEffects`、无 `.strict()`
 *   方法），ZodError → **400**（不让其流进 `recommend()` 抛 500）；预算 wire `"100 CNY"` 解析出数值 amount + 币种，
 *   币种优先级 `显式 currency ?? 预算串币种 ?? 引擎默认`；web-only `usageProfile` 先从待 parse 的 map 剔除、单独校
 *   枚举，非法 clamp 到引擎默认（软旋钮、不崩不 400）。
 * - **不挂 version-304**（沿用比价页）：每请求以 live `render_now`（`new Date()`）重渲，相对 age 每请求重算。
 * - **冷启动首建失败 → 503**（沿用 5c fail-closed），不渲坏快照。
 * - **桶2 gate**：`category:'coding_plan'` 强注入召回参数（枚举字面）；用户不读 category、无切桶手段。
 * - **证据抽屉只按召回维度查**（design D6）：`queryModelRadarSnapshot` 只传 `{category, model, tool, protocol}`，
 *   **MUST NOT 传 currency/maxMonthlyPrice**——否则 `matchesFilters` 滤掉超预算 / 他币种 plan，使答案区 guidance
 *   引用的落选候选在证据里不可见。
 * - **安全头**（design D7）：CSP `default-src 'none'` 收口 + `script-src 'self'` + `style-src 'self' 'unsafe-inline'`
 *   + `font-src 'self'` + `base-uri 'none'` + `form-action 'self'` + `frame-ancestors 'none'`；`source_url` 经
 *   render 层 `safeHref` scheme 闸（主防线）。
 *
 * 仿 api/model-radar.ts 的可注入风格：`getSnapshot` 可注入，使 `app.request('/model-radar')` 直接测（合成快照、不触 DB）。
 */
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Child } from 'hono/jsx';
import { getModelRadarSnapshot, type CachedSnapshot } from '../snapshot/cache.js';
import { modelRadarQueryParamsSchema, queryModelRadarSnapshot } from '../snapshot/query.js';
import { recommend, type RecommendInput } from '../recommend/recommend.js';
import { usageProfileSchema, type Explainer, type RecommendationResult } from '../recommend/schema.js';
import { safeLog } from '../recommend/evidence.js';
import { buildExplainer, type RenderedBy } from '../recommend/explain-llm.js';
import { AlternativeCards, AnswerCard, ExplanationNote, SetupForm, type SetupQuery } from './answer.js';
import { EvidenceDrawer, PageShell, type WebQuery } from './components.js';
import { facetOptions, resolveTokensPerRound, type FreshnessSort } from './render.js';
import { computeSetupHash, getCachedExplanation, setCachedExplanation, withSingleFlight } from './explain-cache.js';
import { checkAndBumpDailyCap, type DailyCapResult } from '../../rag/daily-cap.js';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { embedTexts } from '../../dedup/embedding.js';

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

/**
 * 解释层工厂（5e / task 4.1）：`MR_RECOMMEND_EXPLAIN==='llm'` ⇒ 用主 env 凭据 + 标准 embed + 主 db + stdout
 * logger 构造 v2 LLM 证据叙述 explainer（注入 `recommend()` 第三参）；否则（默认 `template`）返回 `undefined`
 * ⇒ `recommend()` 走默认模板层。**构造抛错不在此吞**——由 handler 的 fail-open try/catch 兜住（构造抛错 ⇒ 回落
 * 模板 + 记错、绝不使公开页失败）。测试注入本工厂驱动 llm 路径（mock generateObjectFn/证据）或模拟构造抛错。
 * Web 进程持全量 env，故直接读主 env（不同于 MCP 的 `mcpEnvSchema`/`getContext()` env-clean 款式）。
 *
 * 组 D：工厂接受两个 opt-in hooks（`onRender` 写闸 / `beforeLlmCall` daily-cap permit-gate）并**透传给
 * `buildExplainer`**——web 侧的 Redis 缓存/日上限逻辑经回调注入，`explain-llm.ts` 本体保持 env-clean（回调实现
 * 体在本调用方）。缺省不传 hooks（如 template 模式或未装配）时 `...undefined` 展开为空、行为不变。
 */
export type ExplainerFactory = (hooks?: {
  onRender?: (rb: RenderedBy) => void;
  beforeLlmCall?: () => Promise<boolean>;
}) => Explainer | undefined;

const defaultExplainerFactory: ExplainerFactory = (hooks) => {
  if (env.MR_RECOMMEND_EXPLAIN !== 'llm') return undefined;
  return buildExplainer({
    credentials: { apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL },
    dbh: db,
    embed: (texts, signal) => embedTexts(texts, { ...(signal ? { signal } : {}) }),
    log: (message, detail) => console.log(`[model-radar-explain] ${message}`, detail ?? ''),
    ...hooks,
  });
};

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
  // 用量档带入排序链接：否则 `?usageProfile=heavy` 点抽屉排序会丢该参 → recommend() 静默回落默认 medium。非法值不透传。
  const up = usageProfileSchema.safeParse(raw.usageProfile);
  if (up.success) q.usageProfile = up.data;
  return q;
}

/**
 * 描述性 `<title>`（反映 setup 且**四态皆有意义**，spec WCAG 2.4.2）：有 primary → 「推荐 X」；无 primary（guidance
 * 态）→ 「未找到匹配首选」，不用「答案/推荐」误导措辞。
 */
function pageTitle(q: SetupQuery, primaryName: string | null): string {
  const parts = [primaryName ? `推荐 ${primaryName}` : '未找到匹配首选'];
  if (q.model) parts.push(`模型 ${q.model}`);
  if (q.tool) parts.push(`工具 ${q.tool}`);
  if (q.protocol) parts.push(`协议 ${q.protocol}`);
  if (q.currency) parts.push(`币种 ${q.currency}`);
  if (q.maxMonthlyPrice) parts.push(`预算 ${q.maxMonthlyPrice}`);
  parts.push('Model Radar · Coding Plan');
  return parts.join(' · ');
}

/** 渲染完整文档（带 doctype；组件无异步 → await 同步取串）。 */
async function renderDocument(title: string, body: Child): Promise<string> {
  const doc = await (<PageShell title={title}>{body}</PageShell>);
  return '<!DOCTYPE html>' + doc;
}

/**
 * llm 解释路径的成本边界依赖（缓存读/写 + daily-cap 检查），默认走真实模块（组 C `explain-cache` + 组 A
 * `daily-cap`）；测试按本文件既有 `getSnapshot`/`explainerFactory` 注入款式注入内存桩/canned 结果/reject 桩，
 * 使缓存命中/未命中、cap 触顶/两态 reason、单飞、顶层兜底 fail-open 全可确定性驱动而不触真 Redis。
 * `checkCap` 返回完整 `DailyCapResult`（reason 两态日志的落点在调用点的 `beforeLlmCall` 回调体内、非此桩内）。
 */
export interface ModelRadarWebDeps {
  getCached?: (version: string, setupHash: string) => Promise<string | null>;
  setCached?: (version: string, setupHash: string, explanation: string) => Promise<void>;
  checkCap?: () => Promise<DailyCapResult>;
}

/**
 * 构造挂载了 Model Radar 比价 Web 页的 Hono app。
 * @param getSnapshot 快照提供者（默认组 D 缓存；测试注入合成快照）。
 * @param explainerFactory 解释层工厂（默认读主 env：llm 模式构造 v2 explainer、否则 undefined；测试注入驱动 llm 路径/构造抛错）。
 * @param deps llm 成本边界依赖（缓存读写 + daily-cap；默认真实模块，测试注入内存/reject 桩）。
 */
export function createModelRadarWebApp(
  getSnapshot: SnapshotProvider = defaultProvider,
  explainerFactory: ExplainerFactory = defaultExplainerFactory,
  deps: ModelRadarWebDeps = {},
): Hono {
  // 默认绑真实模块（无第三参 deps ⇒ 走默认 Redis）；测试注入桩以确定性驱动缓存/cap/单飞/兜底路径。
  const getCached = deps.getCached ?? getCachedExplanation;
  const setCached = deps.setCached ?? setCachedExplanation;
  const checkCap =
    deps.checkCap ?? (() => checkAndBumpDailyCap({ namespace: 'mr', cap: env.MR_EXPLAIN_DAILY_LLM_CAP }));
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
    const webQuery = readWebQuery(raw); // 抽屉表内排序链接的参数保留（不参与快照过滤）。
    const sort: FreshnessSort | undefined = webQuery.sort as FreshnessSort | undefined;

    // ── setup 校验/适配边界（task 1.4，MUST 在 recommend() 之前，防公开页 fail-open 抛 500/崩）──
    // ① 只把 schema 子集喂 strict schema（剔 web-only usageProfile；去空值防 `?model=` 触 400）；ZodError → 400。
    //    直接 `.parse()`（该 schema 已 strict + superRefine、是 ZodEffects、无 `.strict()` 方法）。
    const schemaInput: Record<string, string> = {};
    for (const k of API_QUERY_KEYS) {
      const v = raw[k];
      if (v != null && v.trim() !== '') schemaInput[k] = v;
    }
    const parsed = modelRadarQueryParamsSchema.safeParse(schemaInput);
    if (!parsed.success) {
      const html = await renderDocument(
        'setup 参数无效 · Model Radar',
        (
          <p>
            配置参数无效（如模型须 <code>family:version</code>、预算须「数额 币种」如 <code>100 CNY</code>、
            currency 与预算币种须一致）。 <a href="/model-radar">返回 Model Radar</a>
          </p>
        ),
      );
      return c.html(html, 400);
    }
    // ② 预算 wire → 数值 amount + 币种优先级（显式 currency ?? 预算串币种 ?? 引擎默认）。冲突已由 schema superRefine →400。
    const budget = parsed.data.maxMonthlyPrice;
    const currency = parsed.data.currency ?? budget?.currency;
    // ③ usageProfile（web-only、不在 schema）单独校枚举；非法/缺省 → clamp（undefined 交引擎默认，不崩不 400）。
    const usage = usageProfileSchema.safeParse(raw.usageProfile);
    const usageProfile = usage.success ? usage.data : undefined;

    // 组 RecommendInput：model/tool/protocol 传**原始串**（recall 内部再 parse）；web-only 参数不喂引擎。
    const input: RecommendInput = {
      ...(raw.model && raw.model.trim() !== '' ? { model: raw.model } : {}),
      ...(raw.tool && raw.tool.trim() !== '' ? { tool: raw.tool } : {}),
      ...(raw.protocol && raw.protocol.trim() !== '' ? { protocol: raw.protocol } : {}),
      ...(currency ? { currency } : {}),
      ...(budget ? { maxMonthlyPrice: budget.amount } : {}),
      ...(usageProfile ? { usageProfile } : {}),
    };

    let cached: CachedSnapshot;
    try {
      cached = await getSnapshot();
    } catch (err) {
      // 冷启动首建失败：不渲坏快照，如实 503（沿用 5c fail-closed）。
      console.error('[model-radar-web] /model-radar 快照不可用（冷启动首建或重建失败）', err);
      return c.json({ error: 'snapshot unavailable' }, 503);
    }

    const snapshot = cached.snapshot;

    // ── llm 解释路径成本边界（组 D，spec「公开 web 页 llm 解释的成本边界」）：整条解释缓存 + 进程内单飞 +
    //    daily-cap permit-gate，整条链包在**顶层兜底 try/catch** 内——缓存读 / 单飞 / produce / 包裹 explainer 的
    //    recommend() 任一 reject ⇒ 记错 + 回落默认模板、页恒 200（不冒泡成 500）。template 默认模式（工厂返
    //    undefined）与 MCP 路径零变化（不触缓存/cap）。被缓存串 = explainer 返回的 narration（**不含 guidance
    //    前缀**——guidance 由 recommend() 命中时现拼、逐字节重导）；仅 renderedBy==='llm' 成功产物写缓存。
    let result: RecommendationResult;
    try {
      let renderedBy: RenderedBy | undefined;
      let narration: string | undefined;
      const explainer = explainerFactory({
        onRender: (rb) => {
          renderedBy = rb;
        },
        // permit-gate（证据非空、真发起 LLM 之前 await 一次）：读 daily-cap 完整结果、按 reason 两态分别记日志后返
        // .allowed。allowed=false（超限 quota-exceeded 或 Redis 故障 infra-error，皆 false）⇒ explainer 跳过 LLM
        // 回落模板（fail-open，页恒可用）。空证据在 explainer 内早返、gate 之前 ⇒ 此回调不触发、不占配额。
        beforeLlmCall: async () => {
          const capRes = await checkCap();
          if (!capRes.allowed) {
            safeLog(
              (m, d) => console.warn(m, d),
              `[model-radar-explain] daily-cap 拒绝（reason=${capRes.reason ?? 'unknown'}）⇒ 回落模板`,
              { reason: capRes.reason },
            );
          }
          return capRes.allowed;
        },
      });
      if (!explainer) {
        // template 默认模式：无第三参 ⇒ 零缓存 / 零 cap / 零装配，与本变更前逐字节一致。
        result = await recommend(snapshot, input);
      } else {
        // setupHash/version 仅 llm 分支的 getCached/setCached/单飞 key 用；下沉至此使 template 默认模式零多余 sha256。
        const setupHash = computeSetupHash(input);
        const version = cached.version;
        const hit = await getCached(version, setupHash);
        if (hit !== null) {
          // 命中：注入 ()=>cached 作 explainer，recommend() 现拼 guidance；explainer 不跑 ⇒ 不装配、不调 LLM、
          // beforeLlmCall 不触发（不计 cap）。
          result = await recommend(snapshot, input, () => Promise.resolve(hit));
        } else {
          // 未命中：进程内单飞收敛并发首请求为至多 1 次装配+LLM；produce 内包裹 explainer 截获 narration，仅
          // renderedBy==='llm' 成功产物写缓存（narration 不含 guidance）。
          result = await withSingleFlight(`${version}:${setupHash}`, async () => {
            const wrapped: Explainer = async (inp) => {
              narration = await explainer(inp);
              return narration;
            };
            const r = await recommend(snapshot, input, wrapped);
            if (renderedBy === 'llm' && narration !== undefined) {
              await setCached(version, setupHash, narration);
            }
            return r;
          });
        }
      }
    } catch (err) {
      // 顶层兜底 fail-open：缓存读 / 单飞 / produce / 包裹 explainer 的 recommend() 任一 reject ⇒ 记错 + 回落默认
      // 模板、页恒 200（不 500）。best-effort stderr（safeLog 吞 sink 抛错如 EPIPE）。
      safeLog((m, d) => console.error(m, d), '[model-radar-web] llm 解释路径异常，回落默认模板（页恒 200）', err);
      result = await recommend(snapshot, input);
    }
    // ponytail: result 可能是单飞共享引用（并发 awaiter 共享 winner 的同一对象）；下游仅 find/filter/JSX 只读，勿 mutate result.candidates（会串扰其它 awaiter）。
    const primary = result.candidates.find((c2) => c2.verdict === 'primary');
    const alternatives = result.candidates.filter((c2) => c2.verdict === 'alternative');

    // 证据抽屉：**只按召回维度**查（category + model/tool/protocol；MUST NOT 传 currency/maxMonthlyPrice），
    // 使超预算/他币种落选候选仍在证据可见（与 recommend 的 recall 同维度）。参数已在①校验过，此 parse 不会抛。
    const evidenceRaw: Record<string, string> = { category: GATE_CATEGORY };
    if (input.model) evidenceRaw.model = input.model;
    if (input.tool) evidenceRaw.tool = input.tool;
    if (input.protocol) evidenceRaw.protocol = input.protocol;
    const evidence = queryModelRadarSnapshot(snapshot, modelRadarQueryParamsSchema.parse(evidenceRaw));
    // 「另有 N 未核未参与」的 N：跨引该 category 的 currency=null 组 unknownCount（已核组上恒 0，design D4）。
    const unknownGroup = evidence.groups.find((g) => g.sortScope.currency === null);
    const unknownInCategory = unknownGroup ? unknownGroup.unknownCount : 0;

    // 「描述你的配置」回显串（含 clamp 后的 usageProfile）；下拉选项取桶2 全集。
    const setupQuery: SetupQuery = {
      ...(raw.model && raw.model.trim() !== '' ? { model: raw.model } : {}),
      ...(raw.tool && raw.tool.trim() !== '' ? { tool: raw.tool } : {}),
      ...(raw.protocol && raw.protocol.trim() !== '' ? { protocol: raw.protocol } : {}),
      // 回显**生效**币种（显式 ?? 预算串币种）：预算 "100 USD" 无显式 currency 时下拉如实显 USD，而非误导的「默认币种」。
      ...(currency ? { currency } : {}),
      ...(raw.maxMonthlyPrice && raw.maxMonthlyPrice.trim() !== '' ? { maxMonthlyPrice: raw.maxMonthlyPrice } : {}),
      // 缺省/非法用量档回显引擎默认 medium（recommend.ts DEFAULT_USAGE）：否则下拉无选中项 → 浏览器默认首项 light，
      // 与实际按 medium 计算的答案自相矛盾、且提交未改表单会静默降档。
      usageProfile: usageProfile ?? 'medium',
    };
    const options = facetOptions(snapshot.plans.filter((p) => p.category === GATE_CATEGORY));

    const now = new Date(); // live render_now：相对 age 每请求重算（不挂 version-304）。
    const tokensPerRound = resolveTokensPerRound(raw.tokensPerRound); // web-only 估算旋钮（不喂 schema/引擎）。
    const body = (
      <>
        {primary ? <AnswerCard candidate={primary} now={now} /> : null}
        {/* 备选（轻量账本）紧随答案卡 → 强→轻→中 的节奏；密集的「推荐说明」大表降为下方的支撑证据。 */}
        <AlternativeCards candidates={alternatives} />
        <ExplanationNote candidates={result.candidates} explanation={result.explanation} hasPrimary={!!primary} />
        <SetupForm options={options} query={setupQuery} />
        <EvidenceDrawer
          groups={evidence.groups}
          unknownInCategory={unknownInCategory}
          query={webQuery}
          now={now}
          tokensPerRound={tokensPerRound}
          {...(sort ? { sort } : {})}
        />
      </>
    );
    return c.html(await renderDocument(pageTitle(setupQuery, primary?.name ?? null), body));
  });

  return app;
}
