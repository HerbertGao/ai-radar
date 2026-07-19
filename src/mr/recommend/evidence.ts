/**
 * 推荐器 v2 证据装配层（add-model-radar-recommender-rag-explanation 组 B，design D3 / spec「证据装配」段）。
 *
 * **纯读、注入式、绝不阻塞也绝不挂起**：三子源（KB 命中 / 价格变更 / 待复核）各自 fail-open（抛错 ⇒ 空数组 + 日志），
 * 整体以 `EVIDENCE_ASSEMBLY_TIMEOUT_MS` deadline 兜住挂起（统一 deadlineAt / AbortController）：
 * **装配返回时（超时或某子源早失败致早结束）经 finally 恒 abort、取消仍在飞的 embed**（AbortSignal 中止在途 HTTP）；
 * **DB 在途查询由其单连事务内 `set_config('statement_timeout',…)` 剩余预算独立约束**（不认 signal，≈ deadline 自终结、
 * 异常自动 ROLLBACK 快还连接，design D1/D4），仍按全失败三空处理。**残余**（诚实登记于 design Risks，权威、全表在彼）：
 * `statement_timeout` 只掐**在飞业务查询**、abort 只掐 embed——连接池获取等待、事务外壳语句(`BEGIN`/`ROLLBACK`)/连接黑洞、
 * 及早结束路径的在飞 DB 查询（只掐到**原 deadline**）等的即时释放/取消均非本层保证。**连接释放非绝对**。
 *
 * env-clean（design D4 / 组 D 钉子测试）：**绝不值 import** `config/env`、`agents/llm-client`、`db/index`——
 * `dbh`/`embed`/`log` 全经 `deps` 注入，db 句柄类型经 `import type` 从 `searchKbCore` 参数取（运行期擦除）。
 * 只调用检索核心 `searchKbCore`、不改其语义/参数/签名。
 */
import { and, gte, inArray, sql } from 'drizzle-orm';
import { mrPriceHistory } from '../../db/schema.js';
import { searchKbCore, type KbEmbed, type SearchKbCoreParams } from '../../kb/retrieval-core.js';
import type { RankedCandidate, RecommendEvidence } from './schema.js';

/** db 句柄类型：从 `searchKbCore` 参数取（= `typeof db`），零值 import `db/index`（env-clean）；既喂 searchKbCore 又跑价格 SQL。 */
type DbLike = SearchKbCoreParams['dbh'];

/** 结构化日志 sink（best-effort；抛错绝不影响装配返回值，design D6）。与 `searchKbCore` 的 `logError` 同形。 */
export type EvidenceLog = (message: string, detail?: unknown) => void;

export interface AssembleEvidenceDeps {
  dbh: DbLike;
  embed: KbEmbed;
  log: EvidenceLog;
}

/** 余弦地板（模块常量）：searchKbCore 无阈值恒 top-k，无地板则低相关命中混进 prompt（design D3；待抽样窗校准）。 */
const EVIDENCE_COSINE_FLOOR = 0.6;
/** KB 查询候选数（排序后前 N 条候选取 KB 证据）。 */
const EVIDENCE_KB_CANDIDATE_LIMIT = 3;
/** 每候选 KB top-k。 */
const EVIDENCE_KB_TOP_K = 3;
/** 价格变更回看窗（模块常量、非 env）。解释层（explain-llm）复用同一 SOT（白名单框架数值 + prompt 段）。 */
export const PRICE_CHANGE_WINDOW_DAYS = 30;
/** 装配整体 deadline（模块常量）：经 deadlineAt 单一时钟传播——embed 侧 AbortSignal + DB 侧 statement_timeout 真取消（design D1/D4）。 */
const EVIDENCE_ASSEMBLY_TIMEOUT_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** best-effort 日志：sink 自身抛错绝不影响装配返回值（design D6）。解释层（explain-llm）复用同一实现。 */
export function safeLog(log: EvidenceLog, message: string, detail?: unknown): void {
  try {
    log(message, detail);
  } catch {
    /* 绝不传播优先于必须记录 */
  }
}

/**
 * 预期取消判定（design D1，防增噪）：装配 deadline 触发的取消 **不记为子源失败**。两条来源都认——
 * embed 侧 `ac.abort()` ⇒ `signal.aborted`（同步置位）或底层抛 `AbortError`；DB 侧服务端 `statement_timeout`
 * fire ⇒ PG 查询取消错（SQLSTATE `57014` query_canceled）。**须两者并检**：纯靠 `signal.aborted` 在「本地 abort
 * 定时器 vs 网络送回 DB 取消错」的罕见交错下会漏 DB 取消错、把有意取消记成失败噪声。其它 SQLSTATE/非取消错仍算真失败。
 *
 * **MUST 沿 `.cause` 链查**（仿 `pipeline/ops-alert-sink.ts` 同款教训）：Drizzle 把 pg 错误包成外层 `Error`——
 * 外层 `.message` 是 `Failed query: …`、外层 `.code` 空，真正的 `57014`/取消文案住在 `.cause`。只查顶层 ⇒ DB
 * 取消错逐条漏检、退化成「纯靠 signal.aborted」（正是 D1 声明不足的那条），把有意取消记成 `…failed` 噪声。
 *
 * `signal.aborted` 门闩与错误形态无关地兜底各式 abort 现身（未必都带 `name==='AbortError'`）。其**过宽**代价——finally
 * 置位后（返回后弃置分支）子源 catch 的首个真故障（`ECONNREFUSED` 等）会被标「取消」不进 failed——是 log-only 的
 * accepted-degraded 折衷，权衡与边界的单一权威见 design D4 Risks（此处不复述）。
 */
function isExpectedCancel(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  // 逐层（含 Drizzle 包裹的 .cause）查 AbortError 名 / PG 57014 / statement timeout 文案；深度封顶防环。
  for (let e: unknown = error, depth = 0; e != null && depth <= 3; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof Error && e.name === 'AbortError') return true;
    if ((e as { code?: unknown }).code === '57014') return true;
    if (e instanceof Error && /statement timeout/i.test(e.message)) return true;
  }
  return false;
}

/**
 * `sourceUrls` 首个合法 http(s) 项（同守卫③ URL 闸口径）：仅 http/https 放行、拒 userinfo（`@` 形态），
 * 通过后只返回解析后的 `href`（内嵌 CR/LF/tab 由 WHATWG 解析归一）；非字符串数组 ⇒ null。
 */
function firstValidHttpUrl(sourceUrls: unknown): string | null {
  if (!Array.isArray(sourceUrls)) return null;
  for (const item of sourceUrls) {
    if (typeof item !== 'string') continue;
    try {
      const u = new URL(item);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '') {
        return u.href;
      }
    } catch {
      /* 非合法 URL，跳过 */
    }
  }
  return null;
}

/** 待复核派生：从 `candidates[].reasons`（kind='pending_review'）取候选名，与 verdict 同源、零 SQL（spec）。 */
function derivePendingReview(candidates: RankedCandidate[]): string[] {
  return candidates
    .filter((c) => c.reasons.some((r) => r.kind === 'pending_review'))
    .map((c) => c.name);
}

/** 跨候选按 docId 去重、保最高 cosine（结果与处理顺序无关：只留每 docId 的最大 cosine）。 */
function dedupByDocId(hits: RecommendEvidence['kbHits']): RecommendEvidence['kbHits'] {
  const best = new Map<string, RecommendEvidence['kbHits'][number]>();
  for (const hit of hits) {
    const prev = best.get(hit.docId);
    if (!prev || hit.cosine > prev.cosine) best.set(hit.docId, hit);
  }
  return [...best.values()];
}

/** KB 子源（fail-open）：前 N 候选以「vendorName + name」查 searchKbCore、过地板、映射、跨候选 docId 去重。 */
async function assembleKbHits(
  candidates: RankedCandidate[],
  deps: AssembleEvidenceDeps,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<RecommendEvidence['kbHits']> {
  try {
    const top = candidates.slice(0, EVIDENCE_KB_CANDIDATE_LIMIT);
    const perCandidate = await Promise.all(
      top.map(async (c) => {
        // signal + deadlineAtMs 一并传：embed 走 AbortSignal、DB 查询走单连事务内 statement_timeout（design D1/D4）。
        const results = await searchKbCore({
          query: `${c.vendorName} ${c.name}`,
          topK: EVIDENCE_KB_TOP_K,
          dbh: deps.dbh,
          embed: deps.embed,
          signal,
          deadlineAtMs: deadlineAt,
        });
        return results
          .filter((r) => r.cosineSim >= EVIDENCE_COSINE_FLOOR)
          .map((r) => ({
            docId: r.id,
            planId: c.planId,
            title: r.kbTitle ?? '(无标题)',
            url: firstValidHttpUrl(r.sourceUrls),
            cosine: r.cosineSim,
          }));
      }),
    );
    return dedupByDocId(perCandidate.flat());
  } catch (error) {
    // 装配 deadline 触发的取消（embed abort / DB statement_timeout）降级、不记为失败（design D1，防增噪）。
    if (isExpectedCancel(error, signal)) {
      safeLog(deps.log, 'evidence.kbHits canceled', { reason: 'assembly deadline' });
      return [];
    }
    safeLog(deps.log, 'evidence.kbHits failed', { error: String(error) });
    return [];
  }
}

/** 价格变更子源（fail-open）：近窗内全部候选 plan 的 mr_price_history 行；vendorName/planName 取自对应 candidate。 */
async function assemblePriceChanges(
  candidates: RankedCandidate[],
  deps: AssembleEvidenceDeps,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<RecommendEvidence['priceChanges']> {
  try {
    if (candidates.length === 0) return [];
    const byPlan = new Map(candidates.map((c) => [c.planId, c]));
    const planIds = [...byPlan.keys()];
    const cutoff = new Date(Date.now() - PRICE_CHANGE_WINDOW_DAYS * DAY_MS);

    // 抽出价格查询（仿 retrieval-core 的 runKbQuery）：裸路径（executor=dbh）与事务路径（executor=tx）复用同一 SQL。
    const runPriceQuery = (executor: Pick<DbLike, 'select'>) =>
      executor
        .select({
          planId: mrPriceHistory.planId,
          oldValue: mrPriceHistory.oldValue,
          newValue: mrPriceHistory.newValue,
          currency: mrPriceHistory.currency,
          changedAt: mrPriceHistory.changedAt,
        })
        .from(mrPriceHistory)
        // SQL 推下窗口 + 候选集；JS 侧同 cutoff 复过一遍（窗口边界的确定性判据、单测经 mock dbh 可测）。
        .where(and(inArray(mrPriceHistory.planId, planIds), gte(mrPriceHistory.changedAt, cutoff)));

    // 价格查询进单连事务（Drizzle 异常自动 ROLLBACK、连接干净归还），事务回调内（拿到连接后）算剩余预算
    // remainingMs 设服务端 statement_timeout（design D4，同 retrieval-core KB 路径）——绝不在 transaction() 之前算：
    // 满池时连接获取等待可能跨过 deadline，事务前算的正预算已过期。remainingMs≤0 ⇒ 回调内不启动业务查询返 []。
    // 用 set_config(...,is_local=true)（值作绑定参、事务本地）而非裸 `SET LOCAL …=$1`（PG SET 不吃绑定参会语法错）。
    // （assembleEvidence 恒传 deadlineAt ⇒ 此处恒走事务；retrieval-core 的 deadlineAtMs 才 opt-in 有裸路径。）
    const rows = await deps.dbh.transaction(async (tx) => {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return [];
      await tx.execute(sql`select set_config('statement_timeout', ${String(remainingMs)}, true)`);
      return runPriceQuery(tx);
    });

    const cutoffMs = cutoff.getTime();
    return rows.flatMap((r) => {
      if (r.changedAt.getTime() < cutoffMs) return [];
      const c = byPlan.get(r.planId);
      if (!c) return [];
      return [
        {
          planId: r.planId,
          vendorName: c.vendorName,
          planName: c.name,
          from: r.oldValue,
          to: r.newValue,
          currency: r.currency,
          changedAt: r.changedAt.toISOString().slice(0, 10), // UTC 口径、只到日（spec）
        },
      ];
    });
  } catch (error) {
    // 装配 deadline 触发的取消（DB statement_timeout / abort）降级、不记为失败（design D1，防增噪）。
    if (isExpectedCancel(error, signal)) {
      safeLog(deps.log, 'evidence.priceChanges canceled', { reason: 'assembly deadline' });
      return [];
    }
    safeLog(deps.log, 'evidence.priceChanges failed', { error: String(error) });
    return [];
  }
}

/**
 * 证据装配：三子源各自 fail-open + 整体 deadline 兜挂起。返回三数组恒非 undefined（三空 = 装配过但无证据）。
 * @param candidates 推荐器输出序（已核升序、未核殿后）；KB 取前 N、价格/待复核取全部。
 * @param deps 注入的 `{ dbh, embed, log }`（env-clean：无 env 兜底、无全局 provider 构造）。
 */
export async function assembleEvidence(
  candidates: RankedCandidate[],
  deps: AssembleEvidenceDeps,
): Promise<RecommendEvidence> {
  const empty: RecommendEvidence = { kbHits: [], priceChanges: [], pendingReview: [] };

  // 恒建 deadlineAt + AbortController（design D1）：单一时钟——embed abort 与 DB statement_timeout 共用同一 deadline。
  const deadlineAt = Date.now() + EVIDENCE_ASSEMBLY_TIMEOUT_MS;
  const ac = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RecommendEvidence>((resolve) => {
    timer = setTimeout(() => {
      safeLog(deps.log, 'evidence assembly timeout', { timeoutMs: EVIDENCE_ASSEMBLY_TIMEOUT_MS });
      resolve(empty); // 超时按全失败三空处理（spec）：挂起的 embed/DB 不得拖住请求（真取消在 finally 恒发）。
    }, EVIDENCE_ASSEMBLY_TIMEOUT_MS);
  });

  const assembly = (async (): Promise<RecommendEvidence> => {
    const pendingReview = derivePendingReview(candidates); // 同步派生、不会失败。
    const [kbHits, priceChanges] = await Promise.all([
      assembleKbHits(candidates, deps, ac.signal, deadlineAt),
      assemblePriceChanges(candidates, deps, ac.signal, deadlineAt),
    ]);
    return { kbHits, priceChanges, pendingReview };
  })();

  try {
    return await Promise.race([assembly, timeout]);
  } finally {
    clearTimeout(timer); // race 落地即清理，未触发的 deadline 计时器不驻留（迟到的 assembly 结果自然丢弃）。
    // 恒 abort：装配返回即取消任何仍在飞的底层 embed——覆盖「超时」与「某子源早失败致 assembly 早于 deadline
    // resolve、遗留兄弟 embed 在飞」两种路径（仅在 timer 里 abort 会漏后者）。已完成调用上 abort 是 no-op；
    // DB 侧由事务内 statement_timeout 独立中止（node-postgres 不认 signal）。
    ac.abort();
  }
}
