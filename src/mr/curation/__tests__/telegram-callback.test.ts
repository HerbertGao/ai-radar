/**
 * Telegram 一键批准入站 handler 单测（task 7.2 + 7.5）——**mock ctx / 注入 applyReview 桩，不建真 bot、不触网**。
 *
 * 覆盖 money-path 红线（design D5）：
 * - 处理顺序：解析校验 token/op → 鉴权 from.id → 才 applyReview（鉴权在任何 DB 往返前）；
 * - 拒未知 op / 非法 token / 缺 from / 非白名单 → 不调 applyReview；
 * - kind → answerCallbackQuery 文案；applied 另 editMessageText 去按钮；过期/已决/superseded 亦反馈（不静默）；
 * - **7.5 篡改**：`callback_data` 塞金额的任何变体被拒；合法卡只把 token 传给 applyReview（不带钱），
 *   落库值只来自 applyReview 返回的服务端冻结行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { parseCallbackByPrefix, handleApprovalCallback } =
  await import('../telegram-callback.js');
const { answerUrlDriftText } = await import('../approve.js');
type ApprovalCtx = Parameters<typeof handleApprovalCallback>[0];
type Deps = Parameters<typeof handleApprovalCallback>[1];

/** 合法 token：32 位小写十六进制（randomBytes(16).toString('hex')）。 */
const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const APPROVERS = [111, 222] as const;
/** 目标 chat id（通道绑定校验）——默认卡即来自此 chat。 */
const CHAT_ID = 424242;

/** mock ctx：记录 answer/edit 调用。chatId 默认目标 chat（可覆写以测非目标 chat 拒绝）。 */
function makeCtx(
  data: string | undefined,
  fromId: number | undefined,
  chatId: number | null = CHAT_ID,
) {
  const answerCallbackQuery = vi.fn(async (_o?: { text?: string }) => true);
  const editMessageText = vi.fn(async (_t: string) => true);
  const ctx = {
    callbackQuery: {
      ...(data !== undefined ? { data } : {}),
      ...(fromId !== undefined ? { from: { id: fromId } } : {}),
    },
    ...(chatId !== null ? { chat: { id: chatId } } : {}),
    answerCallbackQuery,
    editMessageText,
  } as unknown as ApprovalCtx & {
    answerCallbackQuery: typeof answerCallbackQuery;
    editMessageText: typeof editMessageText;
  };
  return { ctx, answerCallbackQuery, editMessageText };
}

/** applyReview 桩：默认 applied，money 值来自「服务端冻结行」（此处即桩返回值，绝非入站）。 */
function makeApplyReview(
  result: unknown = {
    kind: 'applied',
    reviewId: 'r-1',
    planId: 'plan-1',
    oldValue: '40.00',
    newValue: '45.00',
  },
) {
  return vi.fn(async (_token: string, _decidedBy: string) => result);
}

/** applyUrlDriftReview 桩：默认 applied（URL drift result union，字段 sourceId/oldUrl/newUrl）。 */
function makeApplyUrlDrift(
  result: unknown = {
    kind: 'applied',
    reviewId: 'r-u1',
    sourceId: 'src-1',
    oldUrl: 'https://old.example.com/p',
    newUrl: 'https://new.example.com/p',
  },
) {
  return vi.fn(async (_token: string, _decidedBy: string) => result);
}

/**
 * 装配 deps（apply* 桩类型宽松，此处收窄到 handler 期望的签名）。
 * `applyUrlDriftReview` 为必填 dep，mrpr 路径测试传默认桩（不会被调用）。
 */
function deps(
  applyReview: ReturnType<typeof makeApplyReview>,
  applyUrlDriftReview: ReturnType<typeof makeApplyUrlDrift> = makeApplyUrlDrift(),
): Deps {
  return {
    applyReview: applyReview as unknown as Deps['applyReview'],
    applyUrlDriftReview:
      applyUrlDriftReview as unknown as Deps['applyUrlDriftReview'],
    approverIds: APPROVERS,
    chatId: CHAT_ID,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('parseCallbackByPrefix（mrpr 前缀：受理 + op/token/分段各拒）', () => {
  it('合法 mrpr:<token>:approve → 返回 token', () => {
    expect(parseCallbackByPrefix(`mrpr:${TOKEN}:approve`, 'mrpr')).toBe(TOKEN);
  });
  it('未知 op（reject / 其他）→ null', () => {
    expect(parseCallbackByPrefix(`mrpr:${TOKEN}:reject`, 'mrpr')).toBeNull();
    expect(parseCallbackByPrefix(`mrpr:${TOKEN}:delete`, 'mrpr')).toBeNull();
  });
  it('错前缀 → null', () => {
    expect(parseCallbackByPrefix(`xxxx:${TOKEN}:approve`, 'mrpr')).toBeNull();
  });
  it('非法 token 字符集/长度 → null', () => {
    expect(parseCallbackByPrefix('mrpr:SHORT:approve', 'mrpr')).toBeNull();
    expect(parseCallbackByPrefix('mrpr:A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6:approve', 'mrpr')).toBeNull(); // 大写
    expect(parseCallbackByPrefix(`mrpr:${TOKEN}z:approve`, 'mrpr')).toBeNull(); // 33 位
  });
  it('多余分段（塞金额）→ null', () => {
    expect(parseCallbackByPrefix(`mrpr:${TOKEN}:approve:9999`, 'mrpr')).toBeNull();
  });
});

describe('handleApprovalCallback 授权 + 反馈', () => {
  it('合法 + 白名单 → applyReview(token, String(id)) → ✅ 已应用 + 去按钮', async () => {
    const applyReview = makeApplyReview();
    const { ctx, answerCallbackQuery, editMessageText } = makeCtx(
      `mrpr:${TOKEN}:approve`,
      111,
    );

    await handleApprovalCallback(ctx, deps(applyReview));

    expect(applyReview).toHaveBeenCalledTimes(1);
    expect(applyReview).toHaveBeenCalledWith(TOKEN, '111');
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ 已应用' });
    expect(editMessageText).toHaveBeenCalledTimes(1); // 去按钮
  });

  it('非白名单 from.id → 不调 applyReview（鉴权在 DB 往返前）', async () => {
    const applyReview = makeApplyReview();
    const { ctx, answerCallbackQuery } = makeCtx(`mrpr:${TOKEN}:approve`, 999);

    await handleApprovalCallback(ctx, deps(applyReview));

    expect(applyReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '无批准权限' });
  });

  it('价格 lane 已停用（priceApprovalReady=false）→ 拒 mrpr 残留卡、不调 applyReview', async () => {
    const applyReview = makeApplyReview();
    const { ctx, answerCallbackQuery } = makeCtx(`mrpr:${TOKEN}:approve`, 111);

    await handleApprovalCallback(ctx, { ...deps(applyReview), priceApprovalReady: false });

    expect(applyReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '价格批准通道未启用' });
  });

  it('URL-drift lane 已停用（urlDriftApprovalReady=false）→ 拒 mrud 残留卡、不调 applyUrlDriftReview', async () => {
    const applyReview = makeApplyReview();
    const applyUrlDrift = makeApplyUrlDrift();
    const { ctx, answerCallbackQuery } = makeCtx(`mrud:${TOKEN}:approve`, 111);

    await handleApprovalCallback(ctx, {
      ...deps(applyReview, applyUrlDrift),
      urlDriftApprovalReady: false,
    });

    expect(applyUrlDrift).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'URL 批准通道未启用' });
  });

  it('缺 from → 拒、不调 applyReview', async () => {
    const applyReview = makeApplyReview();
    const { ctx } = makeCtx(`mrpr:${TOKEN}:approve`, undefined);

    await handleApprovalCallback(ctx, deps(applyReview));

    expect(applyReview).not.toHaveBeenCalled();
  });

  it('非目标 chat → 拒、不调 applyReview（通道绑定，DB 往返前）', async () => {
    const applyReview = makeApplyReview();
    // 白名单内 from.id（111），但 chat 非目标（999999）→ 通道绑定拒。
    const { ctx, answerCallbackQuery } = makeCtx(`mrpr:${TOKEN}:approve`, 111, 999999);

    await handleApprovalCallback(ctx, deps(applyReview));

    expect(applyReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '无权限' });
  });

  it('缺 chat → 拒、不调 applyReview（通道绑定）', async () => {
    const applyReview = makeApplyReview();
    const { ctx } = makeCtx(`mrpr:${TOKEN}:approve`, 111, null);

    await handleApprovalCallback(ctx, deps(applyReview));

    expect(applyReview).not.toHaveBeenCalled();
  });

  it('未知 op → 拒、不调 applyReview（解析在鉴权/DB 之前）', async () => {
    const applyReview = makeApplyReview();
    const { ctx, answerCallbackQuery } = makeCtx(`mrpr:${TOKEN}:reject`, 111);

    await handleApprovalCallback(ctx, deps(applyReview));

    expect(applyReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '无法识别的操作' });
  });

  it('缺 data → 直接返回、不反馈不调用', async () => {
    const applyReview = makeApplyReview();
    const { ctx, answerCallbackQuery } = makeCtx(undefined, 111);

    await handleApprovalCallback(ctx, deps(applyReview));

    expect(applyReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('kind 映射：noop/baseline-drift/failed → 各自反馈、非 applied 不去按钮', async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: 'noop' }, '已处理/已过期，请等新卡'],
      [{ kind: 'baseline-drift', reviewId: 'r-1' }, '价已变，请复核'],
      [{ kind: 'failed', reviewId: 'r-1', reason: 'x' }, '应用失败，将重新浮现'],
    ];
    for (const [result, text] of cases) {
      const applyReview = makeApplyReview(result);
      const { ctx, answerCallbackQuery, editMessageText } = makeCtx(
        `mrpr:${TOKEN}:approve`,
        222,
      );
      await handleApprovalCallback(ctx, deps(applyReview));
      expect(answerCallbackQuery).toHaveBeenCalledWith({ text });
      expect(editMessageText).not.toHaveBeenCalled();
    }
  });

  it('editMessageText 抛错 → 批准仍成功、handler 不抛', async () => {
    const applyReview = makeApplyReview();
    const { ctx, answerCallbackQuery } = makeCtx(`mrpr:${TOKEN}:approve`, 111);
    ctx.editMessageText = vi.fn(async () => {
      throw new Error('message not modified');
    });

    await expect(
      handleApprovalCallback(ctx, deps(applyReview)),
    ).resolves.toBeUndefined();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ 已应用' });
  });
});

describe('7.5 money 值只从服务端行读（callback_data 篡改无效）', () => {
  it('合法卡：只把 token 传给 applyReview（不带金额）；落库值来自服务端冻结行', async () => {
    // applyReview 桩返回服务端冻结的 newValue=45.00；入站 callback_data 无金额位可注入。
    const applyReview = makeApplyReview({
      kind: 'applied',
      reviewId: 'r-9',
      planId: 'plan-9',
      oldValue: '40.00',
      newValue: '45.00', // ← 服务端冻结值，唯一真相
    });
    const { ctx } = makeCtx(`mrpr:${TOKEN}:approve`, 111);

    await handleApprovalCallback(ctx, deps(applyReview));

    // applyReview 只收 (token, decidedBy)——**无金额参数**，无从被入站篡改影响。
    expect(applyReview).toHaveBeenCalledWith(TOKEN, '111');
    const [, ...rest] = applyReview.mock.calls[0]!;
    expect(rest).toEqual(['111']); // 除 token 外只有 decidedBy，绝无金额/币种。
  });

  it('篡改：callback_data 塞金额（多段 / token 位放数字）→ 被拒、不调 applyReview', async () => {
    const applyReview = makeApplyReview();

    // 变体 1：多段塞金额。
    const c1 = makeCtx(`mrpr:${TOKEN}:approve:99999`, 111);
    await handleApprovalCallback(c1.ctx, deps(applyReview));
    // 变体 2：token 位放金额。
    const c2 = makeCtx('mrpr:0.01:approve', 111);
    await handleApprovalCallback(c2.ctx, deps(applyReview));

    expect(applyReview).not.toHaveBeenCalled();
    expect(c1.answerCallbackQuery).toHaveBeenCalledWith({ text: '无法识别的操作' });
    expect(c2.answerCallbackQuery).toHaveBeenCalledWith({ text: '无法识别的操作' });
  });
});

describe('parseCallbackByPrefix（mrpr / mrud 两前缀）', () => {
  it('mrud:<token>:approve + prefix=mrud → 返回 token', () => {
    expect(parseCallbackByPrefix(`mrud:${TOKEN}:approve`, 'mrud')).toBe(TOKEN);
  });
  it('mrpr:<token>:approve + prefix=mrpr → 返回 token', () => {
    expect(parseCallbackByPrefix(`mrpr:${TOKEN}:approve`, 'mrpr')).toBe(TOKEN);
  });
  it('prefix 与 data 首段不符 → null', () => {
    expect(parseCallbackByPrefix(`mrpr:${TOKEN}:approve`, 'mrud')).toBeNull();
    expect(parseCallbackByPrefix(`mrud:${TOKEN}:approve`, 'mrpr')).toBeNull();
  });
  it('mrud 未知 op / 非法 token / 多余分段 → null', () => {
    expect(parseCallbackByPrefix(`mrud:${TOKEN}:reject`, 'mrud')).toBeNull();
    expect(parseCallbackByPrefix('mrud:SHORT:approve', 'mrud')).toBeNull();
    expect(parseCallbackByPrefix(`mrud:${TOKEN}:approve:9999`, 'mrud')).toBeNull();
  });
});

describe('handleApprovalCallback 前缀分流（mrud → applyUrlDriftReview）', () => {
  it('mrpr 路径仍走 applyReview、不碰 applyUrlDriftReview（回归）', async () => {
    const applyReview = makeApplyReview();
    const applyUrlDriftReview = makeApplyUrlDrift();
    const { ctx, answerCallbackQuery, editMessageText } = makeCtx(
      `mrpr:${TOKEN}:approve`,
      111,
    );

    await handleApprovalCallback(ctx, deps(applyReview, applyUrlDriftReview));

    expect(applyReview).toHaveBeenCalledWith(TOKEN, '111');
    expect(applyUrlDriftReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ 已应用' });
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it('mrud 路径走 applyUrlDriftReview(token, id) → ✅ URL 已更新 + 去按钮、不碰 applyReview', async () => {
    const applyReview = makeApplyReview();
    const applyUrlDriftReview = makeApplyUrlDrift();
    const { ctx, answerCallbackQuery, editMessageText } = makeCtx(
      `mrud:${TOKEN}:approve`,
      222,
    );

    await handleApprovalCallback(ctx, deps(applyReview, applyUrlDriftReview));

    expect(applyUrlDriftReview).toHaveBeenCalledTimes(1);
    expect(applyUrlDriftReview).toHaveBeenCalledWith(TOKEN, '222');
    expect(applyReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ URL 已更新' });
    expect(editMessageText).toHaveBeenCalledTimes(1); // applied 去按钮
  });

  it('mrud kind 映射：noop/cross-domain-drift/failed → 各自反馈、非 applied 不去按钮', async () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: 'noop' }, '已处理/已过期，请等新卡'],
      [{ kind: 'cross-domain-drift', reviewId: 'r-u2' }, '候选越界，已升级 PR 流程'],
      [{ kind: 'failed', reviewId: 'r-u3', reason: 'stale-url' }, '应用失败，将重新浮现'],
    ];
    for (const [result, text] of cases) {
      const applyUrlDriftReview = makeApplyUrlDrift(result);
      const { ctx, answerCallbackQuery, editMessageText } = makeCtx(
        `mrud:${TOKEN}:approve`,
        111,
      );
      await handleApprovalCallback(
        ctx,
        deps(makeApplyReview(), applyUrlDriftReview),
      );
      expect(answerCallbackQuery).toHaveBeenCalledWith({ text });
      expect(editMessageText).not.toHaveBeenCalled();
    }
  });

  // 注：mrud 的鉴权(非白名单 from.id)与通道绑定(非目标 chat)在 prefix 分流**之前**跑、与前缀无关，
  // 已由上方 handleApprovalCallback 的 mrpr 版用例覆盖，不再按前缀各测一遍。

  it('mrud 非法 token → 拒、不调任一 apply（解析在鉴权/DB 之前）', async () => {
    const applyReview = makeApplyReview();
    const applyUrlDriftReview = makeApplyUrlDrift();
    const { ctx, answerCallbackQuery } = makeCtx('mrud:SHORT:approve', 111);

    await handleApprovalCallback(ctx, deps(applyReview, applyUrlDriftReview));

    expect(applyReview).not.toHaveBeenCalled();
    expect(applyUrlDriftReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '无法识别的操作' });
  });

  it('未知前缀（非 mrpr/mrud）→ 拒、不调任一 apply（前缀 gate 在鉴权/DB 之前）', async () => {
    const applyReview = makeApplyReview();
    const applyUrlDriftReview = makeApplyUrlDrift();
    // 结构合法（3 段 + approve + 32-hex token）但前缀未知——须被前缀 gate 拒。
    const { ctx, answerCallbackQuery } = makeCtx(`mrxx:${TOKEN}:approve`, 111);

    await handleApprovalCallback(ctx, deps(applyReview, applyUrlDriftReview));

    expect(applyReview).not.toHaveBeenCalled();
    expect(applyUrlDriftReview).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: '无法识别的操作' });
  });
});

describe('answerUrlDriftText（4-case exhaustive）', () => {
  it('4 种 kind → 对应文案', () => {
    expect(answerUrlDriftText({ kind: 'applied', reviewId: 'r', sourceId: 's', oldUrl: 'a', newUrl: 'b' })).toBe('✅ URL 已更新');
    expect(answerUrlDriftText({ kind: 'noop' })).toBe('已处理/已过期，请等新卡');
    expect(answerUrlDriftText({ kind: 'cross-domain-drift', reviewId: 'r' })).toBe('候选越界，已升级 PR 流程');
    expect(answerUrlDriftText({ kind: 'failed', reviewId: 'r', reason: 'x' })).toBe('应用失败，将重新浮现');
  });
});
