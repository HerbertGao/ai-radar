/**
 * recommend_coding_subscription handler 单测（add-model-radar-recommender 组 C，task 4.7/4.8，**无 DB**）。
 *
 * `vi.mock('../../../mr/snapshot/build.js')` 让 `buildModelRadarSnapshot` 返合成快照（或抛错），不触真 DB/Redis/
 * 飞书/Telegram。验：
 * - 4.7 ① 正常：handler 返 structuredContent（经 outputSchema 形状）+ content[].text 含首选/stale；
 *        ② annotations.readOnlyHint:true；③ build 抛错 → fail-closed isError（不编推荐）。
 * - 4.8 退出标准用例：合成 GLM Coding Plan Lite（glm:4.6 + claude-code + ¥49 + 限额 value:null）与 GLM Pro（¥149）
 *        → 重度用 → 首选 GLM Lite、monthlyCost=49、fitsWindow='unknown'（现数据口径未知如实标），话术含月成本/依据/撞窗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { setContext } from '../../context.js';
import { recommendCodingTool } from '../recommend-coding.js';
import { recommendationResultSchema } from '../../../mr/recommend/schema.js';
import type { McpDb } from '../../db.js';
import type { McpEnv } from '../../env.js';
import type { ModelRadarSnapshot, SnapshotLimit, SnapshotPlan } from '../../../mr/snapshot/dto.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// 动态 import 目标 env-clean build.ts —— mock 让 handler 现 build 取到合成快照（不触 DB）。
vi.mock('../../../mr/snapshot/build.js');
import { buildModelRadarSnapshot } from '../../../mr/snapshot/build.js';

// 5e 解释层：mock explain-llm.js 的 buildExplainer——handler 在 llm 模式（四 key 齐）动态 import 它。默认返回 stub
// explainer（直返固定叙述，证注入 recommend 第三参）；构造抛错测用 mockImplementationOnce 令其 throw。template 模式
// 的既有测试恒不进 llm 分支 → 本 mock 对其惰性。
vi.mock('../../../mr/recommend/explain-llm.js', () => ({
  buildExplainer: vi.fn(() => async () => 'MOCK_NARRATIVE'),
}));
import { buildExplainer } from '../../../mr/recommend/explain-llm.js';

// 组 D（add-model-radar-assembly-deadline-cancel / task 4.2）：mock embed-clean.js 以监视 MCP 装配 embed lambda
// 的 signal 转发（缺省 undefined ⇒ 无 abortSignal 逐字节不变；传入 ⇒ 转发第三参 { signal }）。真实 embed 从不被
// 调用（buildExplainer 被 mock、注入的 lambda 仅被捕获显式驱动）；缺 key 分支即便动态 import 它也不触调用。
vi.mock('../../../kb/embed-clean.js', () => ({
  embedTextsClean: vi.fn(async () => [[1]]),
}));
import { embedTextsClean } from '../../../kb/embed-clean.js';

const PROV = {
  sourceUrl: 'https://open.bigmodel.cn/pricing',
  sourceConfidence: 'official_pricing' as const,
  lastCheckedDate: '2026-06-20',
};

function mkLimit(limitType: SnapshotLimit['limitType'], value: string | null, window = 'monthly'): SnapshotLimit {
  return { limitType, value, window, provenance: PROV };
}

/** GLM Coding Plan 行（glm:4.6 + claude-code），价/限额可覆盖。 */
function mkGlmPlan(id: string, price: string, limits: SnapshotLimit[]): SnapshotPlan {
  return {
    id,
    vendorId: `vendor-${id}`,
    vendorName: '智谱 GLM',
    name: id,
    category: 'coding_plan',
    availability: 'unknown',
    currentPrice: price,
    currency: 'CNY',
    priceStatus: 'known',
    provenance: PROV,
    freshness: { stale: false },
    reviewStatus: { pending: false },
    periodPrices: [],
    models: [{ modelId: `m-${id}`, family: 'glm', version: '4.6', provenance: PROV }],
    clients: [{ clientType: 'tool', clientId: 'claude-code', provenance: PROV }],
    limits,
    sources: [],
  };
}

function snap(...plans: SnapshotPlan[]): ModelRadarSnapshot {
  return { plans };
}

// 现数据桶2 限额全 rolling_5h_requests/credit/fast_pass 且 value:NULL → 撞窗恒 unknown。
const BUCKET2_LIMITS = [
  mkLimit('rolling_5h_requests', null, 'rolling_5h'),
  mkLimit('credit', null),
  mkLimit('fast_pass', null),
];

/** 退出标准合成快照：GLM Lite ¥49 + GLM Pro ¥149（同 glm:4.6 / claude-code）。 */
const exitSnapshot = snap(
  mkGlmPlan('GLM Coding Plan Lite', '49', BUCKET2_LIMITS),
  mkGlmPlan('GLM Coding Plan Pro', '149', BUCKET2_LIMITS),
);

const env: McpEnv = {
  DATABASE_URL: 'postgres://x:x@localhost:5432/x',
  PUSH_TIMEZONE: 'Asia/Shanghai',
  MR_STALENESS_THRESHOLD_DAYS: 30,
};
// handler 只把 db 透传给（被 mock 的）build；mock 忽略它，故空对象桩足矣（不触 DB）。
const db = {} as unknown as McpDb;

const mockedBuild = vi.mocked(buildModelRadarSnapshot);
const mockedBuildExplainer = vi.mocked(buildExplainer);
const mockedEmbedClean = vi.mocked(embedTextsClean);

/** llm 模式 + 四 key 齐（chat=LLM_MODEL、embed=EMBEDDING_MODEL）。 */
const llmEnvFull: McpEnv = {
  ...env,
  MR_RECOMMEND_EXPLAIN: 'llm',
  LLM_API_KEY: 'k',
  LLM_BASE_URL: 'https://ex.com/v1',
  LLM_MODEL: 'chat-m',
  EMBEDDING_MODEL: 'embed-m',
};
/** llm 模式但四 key 全缺。 */
const llmEnvMissing: McpEnv = { ...env, MR_RECOMMEND_EXPLAIN: 'llm' };

beforeEach(() => {
  setContext({ env, db });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('4.7 recommend_coding_subscription handler（注入合成快照、不触 DB）', () => {
  it('正常：返 structuredContent（经 outputSchema 形状）+ content[].text 含首选/stale', async () => {
    const stalePlan = mkGlmPlan('GLM Coding Plan Lite', '49', BUCKET2_LIMITS);
    stalePlan.freshness = { stale: true };
    mockedBuild.mockResolvedValue(snap(stalePlan));

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code', currency: 'CNY', usageProfile: 'heavy' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    // structuredContent 经组 B 输出 schema（与 outputSchema 形状一致）。
    expect(recommendationResultSchema.safeParse(res.structuredContent).success).toBe(true);
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('首选');
    expect(text).toContain('数据陈旧'); // stale 标暴露
    // 现 build：每次调用都构建（不缓存）。
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    expect(mockedBuild).toHaveBeenCalledWith(db, expect.any(Date), 30); // 显式 thresholdDays 取自 mcpEnv
  });

  it('annotations.readOnlyHint 为 true（只读、不写库）', () => {
    expect(recommendCodingTool.annotations.readOnlyHint).toBe(true);
  });

  it('快照不可用（build 抛错）→ fail-closed isError CallToolResult（不编推荐）', async () => {
    mockedBuild.mockRejectedValue(new Error('parseEnv boom'));

    const res = (await recommendCodingTool.handler(
      { tool: 'claude-code' },
      {},
    )) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined(); // 绝不返编造推荐
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('snapshot unavailable');
  });

  it('快照可用但 recommend 抛错（非法 model 无冒号）→ 标「推荐生成失败」而非 snapshot unavailable', async () => {
    // 直调 handler 绕过 SDK inputSchema 校验，让 recommend() 见到坏 model → 内部 query.parse 抛。
    // build mock 返合法快照 → 故错误必归因到推荐阶段、不可误标快照不可用。
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm' }, // 无冒号、过不了 modelRadarQueryParamsSchema
      {},
    )) as CallToolResult;

    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('推荐生成失败');
    expect(text).not.toContain('snapshot unavailable');
  });
});

describe('4.8 退出标准用例：重度用 Claude Code + GLM-4.6 最便宜可用', () => {
  it('首选 GLM Lite、monthlyCost=49、fitsWindow=unknown（口径未知如实标），话术含月成本/依据/撞窗', async () => {
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code', usageProfile: 'heavy' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    const result = recommendationResultSchema.parse(res.structuredContent);

    const primary = result.candidates.find((c) => c.verdict === 'primary');
    expect(primary?.name).toBe('GLM Coding Plan Lite'); // 同 model/tool 内最便宜可用
    expect(primary?.monthlyCost).toBe(49);
    expect(primary?.fitsWindow).toBe('unknown'); // 现数据 value:NULL → 口径未知、不假装 fits/exceeds

    // GLM Pro（¥149）为更贵 eligible → alternative（unknown 属 eligible）。
    const pro = result.candidates.find((c) => c.name === 'GLM Coding Plan Pro');
    expect(pro?.verdict).toBe('alternative');

    // 话术含月成本 / 依据(provenance) / 撞窗结论。
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('49');
    expect(text).toContain('https://open.bigmodel.cn/pricing'); // per-fact 可溯源依据
    expect(text).toContain('额度口径未知'); // 撞窗结论（⚠ 估算）
  });
});

describe('3.1 inputSchema 边界校验（SDK 自动校验、handler 前拦非法入参）', () => {
  // 直接验 inputSchema raw shape——SDK 据此自校验，故 family:version 冒号/非空在 handler 前即拦下。
  const schema = z.object(recommendCodingTool.inputSchema);

  it('model 须 family:version：拒绝无冒号/空串/空 family/空 version、接受 glm:4.6、允许省略（FIX 2a 边界）', () => {
    expect(schema.safeParse({ model: 'glm' }).success).toBe(false); // 无冒号 → SDK 拒（不再下沉误标 snapshot unavailable）
    expect(schema.safeParse({ model: '' }).success).toBe(false); // 空串 → 拒
    expect(schema.safeParse({ model: ':4.6' }).success).toBe(false); // 空 family → 拒
    expect(schema.safeParse({ model: 'glm:' }).success).toBe(false); // 空 version → 拒
    expect(schema.safeParse({ model: 'glm:4.6' }).success).toBe(true); // 合法
    expect(schema.safeParse({ model: 'glm:4.6:beta' }).success).toBe(true); // version 可含冒号（首冒号后非空即可）
    expect(schema.safeParse({}).success).toBe(true); // 省略 → optional 短路、合法
  });

  it('tool/protocol 非空（.min(1)）：拒绝空串', () => {
    expect(schema.safeParse({ tool: '' }).success).toBe(false);
    expect(schema.safeParse({ protocol: '' }).success).toBe(false);
    expect(schema.safeParse({ tool: 'claude-code' }).success).toBe(true);
  });
});

describe('4.2/4.4 解释层装配（env-clean、四 key 判定、fail-open、模板回落）', () => {
  it('MR_RECOMMEND_EXPLAIN=llm 但四 key 缺 → 模板回落 + stderr 列缺失变量名、不构造 explainer', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setContext({ env: llmEnvMissing, db });
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    expect(recommendationResultSchema.safeParse(res.structuredContent).success).toBe(true);
    expect(mockedBuildExplainer).not.toHaveBeenCalled(); // 缺 key ⇒ 不构造
    // stderr 一行列出全部缺失变量名（诊断「配了 llm 却永远模板」）。
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    for (const v of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'EMBEDDING_MODEL']) expect(msg).toContain(v);
    errSpy.mockRestore();
  });

  it('MR_RECOMMEND_EXPLAIN=llm + 四 key 齐 → 构造 explainer（chat 凭据=LLM_MODEL、dbh=db）并注入 recommend 第三参', async () => {
    setContext({ env: llmEnvFull, db });
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    expect(mockedBuildExplainer).toHaveBeenCalledTimes(1);
    const opts = mockedBuildExplainer.mock.calls[0]![0];
    expect(opts.credentials).toEqual({ apiKey: 'k', baseUrl: 'https://ex.com/v1', model: 'chat-m' });
    expect(opts.dbh).toBe(db);
    // stub explainer 返 'MOCK_NARRATIVE' → recommend 拼进 explanation（证注入第三参、非默认模板）。
    const result = recommendationResultSchema.parse(res.structuredContent);
    expect(result.explanation).toContain('MOCK_NARRATIVE');
  });

  it('MR_RECOMMEND_EXPLAIN=llm + 四 key 齐但构造抛错 → fail-open 模板层 + stderr 记错（不使工具失败）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedBuildExplainer.mockImplementationOnce(() => {
      throw new Error('construct boom');
    });
    setContext({ env: llmEnvFull, db });
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    const result = recommendationResultSchema.parse(res.structuredContent);
    expect(result.explanation).not.toContain('MOCK_NARRATIVE'); // 回落模板、无 stub 叙述
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('解释层构造失败');
    errSpy.mockRestore();
  });

  it('未配置 llm（默认 template）→ 不构造 explainer、不刷 stderr（recommend 走默认模板）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setContext({ env, db }); // base env 无 MR_RECOMMEND_EXPLAIN
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler({ tool: 'claude-code' }, {})) as CallToolResult;

    expect(res.isError).not.toBe(true);
    expect(mockedBuildExplainer).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled(); // 未配 llm 不刷 stderr
    errSpy.mockRestore();
  });
});

describe('4.2 MCP 装配 embed lambda：signal 转发（缺省 undefined ⇒ 无 abortSignal 逐字节不变、传入 ⇒ 转发 { signal }）', () => {
  it('捕获注入 buildExplainer 的 embed lambda：缺省 signal=undefined ⇒ embedTextsClean 收 { signal: undefined }；传入 signal ⇒ 转发', async () => {
    setContext({ env: llmEnvFull, db });
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code' },
      {},
    )) as CallToolResult;
    expect(res.isError).not.toBe(true);
    expect(mockedBuildExplainer).toHaveBeenCalledTimes(1);

    // 注入的 embed lambda（KbEmbed：(texts, signal?)）——buildExplainer 被 mock、该 lambda 在业务路径未被调用，
    // 此处显式驱动只验 signal 透传形状（embed 凭据 model=EMBEDDING_MODEL='embed-m'，同 handler 分工）。
    const embed = mockedBuildExplainer.mock.calls[0]![0].embed;
    const creds = { apiKey: 'k', baseURL: 'https://ex.com/v1', model: 'embed-m' };

    // 缺省路径：searchKbCore 不传 signal ⇒ lambda 收 undefined ⇒ 条件展开省去 signal 键 ⇒ embedTextsClean 收 {}
    // （同原 `embedTextsClean(texts, creds)` 的默认 options={}）⇒ 底层 abortSignal 不出现 ⇒ 逐字节等价现状。
    await embed(['t'], undefined);
    expect(mockedEmbedClean).toHaveBeenCalledWith(['t'], creds, {});

    // 真取消路径：传入 signal ⇒ 原样转发（装配超时 ac.abort() 经此中止 MCP embed）。
    const ac = new AbortController();
    await embed(['t2'], ac.signal);
    expect(mockedEmbedClean).toHaveBeenLastCalledWith(['t2'], creds, { signal: ac.signal });
  });
});
