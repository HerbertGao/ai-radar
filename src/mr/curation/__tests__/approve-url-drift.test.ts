/**
 * `applyUrlDriftReview` 单测（task 9.3）——**mock 依赖，无真实 DB / Redis / 不触网**（遵守测试守卫）。
 *
 * mock 边界：`claimUrlDriftReview`/`markUrlDriftApplyFailed`（store）、`setSourceUrl`（authorized setter；
 * `StaleUrlError` 保真——importActual 只替 setSourceUrl）、`vendorOf`/`vendorDomainSet`（vendor-scope）、
 * `publishSnapshotInvalidation`（快照失效）。`SsrfBlockedError` 用真类（不 mock ssrf-guard、instanceof 才成立）。
 * 注入的 db 桩只提供 `transaction`（回调抛出即 reject，仿真回滚 + 上抛）。
 *
 * 覆盖 catch 5-branch 分流（design D2）：
 * - 合法候选 → applied（setSourceUrl 被调 + {sourceId, oldUrl, newUrl}）；
 * - vendor-scope 越界 → CrossDomainDriftError → cross-domain-drift（setSourceUrl 未调 + apply_failed）；
 * - SsrfBlockedError host-not-allowlisted → cross-domain-drift；其余 5 reason → failed{reason}；
 * - StaleUrlError → failed{'stale-url'}；unique-violation(23505，含 cause 链) → failed{'url-conflict'}；
 * - 其它 post-claim 抛错 → failed{message}（M6 恒带 reason）；
 * - 双击/过期 → claim null → noop；快照失效抛错 → 仍 applied；markUrlDriftApplyFailed 0-row → warn 日志、kind 不变。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const mocks = vi.hoisted(() => ({
  claimUrlDriftReview: vi.fn(),
  markUrlDriftApplyFailed: vi.fn(),
  setSourceUrl: vi.fn(),
  vendorOf: vi.fn(),
  vendorDomainSet: vi.fn(),
  publishSnapshotInvalidation: vi.fn(),
}));

vi.mock('../url-drift-store.js', () => ({
  claimUrlDriftReview: mocks.claimUrlDriftReview,
  markUrlDriftApplyFailed: mocks.markUrlDriftApplyFailed,
}));
// StaleUrlError 保真（instanceof 分流）——只替 setSourceUrl。
vi.mock('../../ingest/set-source-url.js', async (importActual) => {
  const actual = await importActual<typeof import('../../ingest/set-source-url.js')>();
  return { ...actual, setSourceUrl: mocks.setSourceUrl };
});
vi.mock('../../scrape/vendor-domains.js', () => ({
  vendorOf: mocks.vendorOf,
  vendorDomainSet: mocks.vendorDomainSet,
}));
vi.mock('../../snapshot/invalidation.js', () => ({
  publishSnapshotInvalidation: mocks.publishSnapshotInvalidation,
}));

const { applyUrlDriftReview, answerUrlDriftText } = await import('../approve.js');
const { StaleUrlError } = await import('../../ingest/set-source-url.js');
const { SsrfBlockedError } = await import('../../scrape/ssrf-guard.js');

/** 认领返回的冻结行（候选 URL / oldUrl / flag generation token 唯一来源）。 */
const CLAIMED = {
  id: 'ur-1',
  sourceId: 'src-1',
  oldUrl: 'https://www.kimi.com/membership/pricing',
  candidateUrl: 'https://kimi.com/membership',
  flagOpenedAt: '2026-07-20 00:00:00+00',
};

/** db 桩：transaction 传空 tx 桩给回调（回调抛出即 reject，仿真回滚 + 上抛）；子函数全 mock 故 tx 无需能力。 */
function makeDb() {
  const tx = {};
  return {
    async transaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
      return cb(tx);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：认领命中冻结行、vendor-scope 通过（候选 kimi.com ∈ {kimi.com}）、setSourceUrl 成功、mark 命中 1 行、快照失效成功。
  mocks.claimUrlDriftReview.mockResolvedValue(CLAIMED);
  mocks.vendorOf.mockResolvedValue('vendor-1');
  mocks.vendorDomainSet.mockResolvedValue(['kimi.com']);
  mocks.setSourceUrl.mockResolvedValue(undefined);
  mocks.markUrlDriftApplyFailed.mockResolvedValue(1);
  mocks.publishSnapshotInvalidation.mockResolvedValue(undefined);
});

describe('applyUrlDriftReview 成功路径', () => {
  it('合法候选 → applied：setSourceUrl 被调（冻结值）+ {sourceId, oldUrl, newUrl} + 提交后触发快照失效', async () => {
    const db = makeDb();

    const out = await applyUrlDriftReview('tok-live', 'approver-1', db as never);

    expect(out).toEqual({
      kind: 'applied',
      reviewId: 'ur-1',
      sourceId: 'src-1',
      oldUrl: 'https://www.kimi.com/membership/pricing',
      newUrl: 'https://kimi.com/membership',
    });
    // setSourceUrl 收到的是**冻结**候选/oldUrl/flagOpenedAt（入参只有 token+decidedBy，无入站 URL）。
    expect(mocks.setSourceUrl).toHaveBeenCalledTimes(1);
    const [sourceId, newUrl, oldUrl, decidedBy, , expectedOpenedAt] =
      mocks.setSourceUrl.mock.calls[0]!;
    expect(sourceId).toBe('src-1');
    expect(newUrl).toBe('https://kimi.com/membership');
    expect(oldUrl).toBe('https://www.kimi.com/membership/pricing');
    expect(decidedBy).toBe('approver-1');
    expect(expectedOpenedAt).toBe('2026-07-20 00:00:00+00');
    expect(mocks.publishSnapshotInvalidation).toHaveBeenCalledTimes(1);
    expect(mocks.markUrlDriftApplyFailed).not.toHaveBeenCalled();
  });

  it('setSourceUrl 返 void → applyUrlDriftReview 视为 applied（外层契约）', async () => {
    // 注：generation-mismatch 容忍（resolveFlag 0 行）发生在 setSourceUrl **内部**——本单测 mock 掉 setSourceUrl，
    // 无法触及该逻辑（曾误标为「测 generation mismatch」，实与 happy path 同形）。真行为由
    // set-source-url.integration.test.ts 覆盖（URL 落库、flag 保持 pending）。此处仅固定「void → applied」的外层契约。
    mocks.setSourceUrl.mockResolvedValue(undefined);
    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);
    expect(out.kind).toBe('applied');
  });

  it('快照失效抛错（如 Redis 不可达）→ 批准仍成功、不回退', async () => {
    mocks.publishSnapshotInvalidation.mockRejectedValue(new Error('redis down'));

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out.kind).toBe('applied');
    expect(mocks.markUrlDriftApplyFailed).not.toHaveBeenCalled();
  });
});

describe('applyUrlDriftReview 幂等（CAS）', () => {
  it('双击/重投 → 仅第一次认领落库一次，重投 claim null → noop、不再调 setSourceUrl', async () => {
    mocks.claimUrlDriftReview.mockResolvedValueOnce(CLAIMED).mockResolvedValueOnce(null);
    const db = makeDb();

    const first = await applyUrlDriftReview('tok-live', 'approver-1', db as never);
    const second = await applyUrlDriftReview('tok-live', 'approver-1', db as never);

    expect(first.kind).toBe('applied');
    expect(second).toEqual({ kind: 'noop' });
    expect(mocks.setSourceUrl).toHaveBeenCalledTimes(1);
    expect(mocks.publishSnapshotInvalidation).toHaveBeenCalledTimes(1);
  });

  it('claim null（过期/已决/superseded）→ noop、不落库、不触发快照失效', async () => {
    mocks.claimUrlDriftReview.mockResolvedValue(null);

    const out = await applyUrlDriftReview('dead-tok', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'noop' });
    expect(mocks.setSourceUrl).not.toHaveBeenCalled();
    expect(mocks.publishSnapshotInvalidation).not.toHaveBeenCalled();
  });
});

describe('applyUrlDriftReview vendor-scope 再校验（step ②，design D-M5）', () => {
  it('候选越界（host 不在 vendorDomainSet 内）→ CrossDomainDriftError → cross-domain-drift + setSourceUrl 未调 + apply_failed', async () => {
    mocks.vendorDomainSet.mockResolvedValue(['bigmodel.cn']); // 候选 kimi.com 不在集内

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'cross-domain-drift', reviewId: 'ur-1' });
    expect(mocks.setSourceUrl).not.toHaveBeenCalled(); // step ② 在 setSourceUrl 前拦截
    expect(mocks.markUrlDriftApplyFailed).toHaveBeenCalledWith('ur-1', 'approver-1', expect.anything());
    expect(mocks.publishSnapshotInvalidation).not.toHaveBeenCalled();
  });

  it('vendorOf 缺（source 不存在）→ 空集 → cross-domain-drift（fail-closed）', async () => {
    mocks.vendorOf.mockResolvedValue(null);

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out.kind).toBe('cross-domain-drift');
    expect(mocks.vendorDomainSet).not.toHaveBeenCalled(); // vid 缺 → 短路不查
    expect(mocks.setSourceUrl).not.toHaveBeenCalled();
  });
});

describe('applyUrlDriftReview SSRF reason 分流（design D-M2）', () => {
  it("SsrfBlockedError('host-not-allowlisted') → cross-domain-drift（不误标 failed）", async () => {
    mocks.setSourceUrl.mockRejectedValue(new SsrfBlockedError('host-not-allowlisted'));

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'cross-domain-drift', reviewId: 'ur-1' });
    expect(mocks.markUrlDriftApplyFailed).toHaveBeenCalledWith('ur-1', 'approver-1', expect.anything());
  });

  it.each([
    'scheme-not-allowed',
    'url-has-userinfo',
    'private-address',
    'dns-resolution-failed',
    'too-many-redirects',
  ] as const)('SsrfBlockedError(%s) → failed{reason}（原样 ssrf 反馈、不误标 cross-domain）', async (reason) => {
    mocks.setSourceUrl.mockRejectedValue(new SsrfBlockedError(reason));

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'failed', reviewId: 'ur-1', reason });
    expect(mocks.markUrlDriftApplyFailed).toHaveBeenCalledWith('ur-1', 'approver-1', expect.anything());
  });
});

describe('applyUrlDriftReview setSourceUrl 其它抛错分流', () => {
  it('StaleUrlError（old-URL CAS 0 行）→ failed{stale-url} + source 不改（setSourceUrl 抛、未落库）', async () => {
    mocks.setSourceUrl.mockRejectedValue(new StaleUrlError());

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'failed', reviewId: 'ur-1', reason: 'stale-url' });
    expect(mocks.markUrlDriftApplyFailed).toHaveBeenCalledWith('ur-1', 'approver-1', expect.anything());
    expect(mocks.publishSnapshotInvalidation).not.toHaveBeenCalled();
  });

  it('URL 唯一冲突（pg 23505 直挂）→ failed{url-conflict}', async () => {
    mocks.setSourceUrl.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'failed', reviewId: 'ur-1', reason: 'url-conflict' });
  });

  it('URL 唯一冲突（drizzle 包裹、23505 住 .cause）→ failed{url-conflict}', async () => {
    const wrapped = Object.assign(new Error('Failed query: update mr_source ...'), {
      cause: Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint: 'mr_source_vendor_id_source_url_key',
      }),
    });
    mocks.setSourceUrl.mockRejectedValue(wrapped);

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'failed', reviewId: 'ur-1', reason: 'url-conflict' });
  });

  it('其它 post-claim 抛错 → failed{message}（M6 恒带 reason）', async () => {
    mocks.setSourceUrl.mockRejectedValue(new Error('boom-db-down'));

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'failed', reviewId: 'ur-1', reason: 'boom-db-down' });
    expect(mocks.markUrlDriftApplyFailed).toHaveBeenCalledWith('ur-1', 'approver-1', expect.anything());
  });

  it('非 Error 抛出（空信息）→ failed 仍带非空 reason（|| other 兜底、M6）', async () => {
    mocks.setSourceUrl.mockRejectedValue('');

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out.kind).toBe('failed');
    expect((out as { reason: string }).reason).toBe('other');
  });
});

describe('applyUrlDriftReview 并发处置 markUrlDriftApplyFailed 0-row', () => {
  it('0 行 → warn 日志含 id + 「行已非 pending、跳过」、result kind 不变、不抛不阻塞', async () => {
    mocks.setSourceUrl.mockRejectedValue(new StaleUrlError());
    mocks.markUrlDriftApplyFailed.mockResolvedValue(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await applyUrlDriftReview('tok-live', 'approver-1', makeDb() as never);

    expect(out).toEqual({ kind: 'failed', reviewId: 'ur-1', reason: 'stale-url' }); // kind 不变
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]!.join(' ');
    expect(msg).toContain('ur-1');
    expect(msg).toContain('行已非 pending、跳过');
    warn.mockRestore();
  });
});

describe('answerUrlDriftText 4-case 反馈文案（task 9.2）', () => {
  it.each([
    [{ kind: 'applied', reviewId: 'r', sourceId: 's', oldUrl: 'o', newUrl: 'n' }, '✅ URL 已更新'],
    [{ kind: 'noop' }, '已处理/已过期，请等新卡'],
    [{ kind: 'cross-domain-drift', reviewId: 'r' }, '候选越界，已升级 PR 流程'],
    [{ kind: 'failed', reviewId: 'r', reason: 'stale-url' }, '应用失败，将重新浮现'],
  ] as const)('%o → %s', (result, text) => {
    expect(answerUrlDriftText(result as never)).toBe(text);
  });
});
