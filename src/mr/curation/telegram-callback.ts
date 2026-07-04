/**
 * Model Radar 价格 curation 入站接收——Telegram 长轮询一键批准（add-model-radar-price-curation-approval，
 * design D4/D5，task 7.2/7.4）。
 *
 * **仅 web 镜像**跑 `bot.start()` 长轮询（Telegram 单 getUpdates 消费者；web 单副本约束——多副本/多消费者
 * 会 409 flap）。worker 镜像只 `api.sendMessage` 发卡、**绝不** `bot.start()`。见 index.ts 接线注释。
 * // ponytail: 长轮询单副本，web 横扩再切 webhook（+ secret_token 常量时间校验）。
 *
 * money-path 红线（design D5，处理顺序不可乱）：
 * ① 先解析 + 校验 `callback_data`：token 定长/字符集，op 必须是 `approve`（拒未知 op）——在**任何 DB 往返之前**；
 * ② 再按 `callback_query.from.id`（**数值化**）鉴权：缺 `from` 或不在 `TELEGRAM_APPROVER_IDS` → 拒、不打 DB；
 * ③ 通过后才 `applyReview(token, String(from.id))`——money 值/币种/provenance 由服务端按 token 读行上冻结值，
 *    `callback_data` **只带引用**（`mrpr:<token>:approve`）、绝不带钱。
 * 结果 kind → `answerCallbackQuery` 反馈文案；applied 另 `editMessageText` 去按钮。过期/已决/superseded 亦必反馈（不静默）。
 *
 * 轮询/出站 Bot API 调用**有重试退避 + 错误日志**（仓库不变量）；`callback_data`/token **从日志脱敏**——只记
 * review `id` / `plan_id`，日志 sink 只落 `err.message`（不落含 payload 的 error 对象，防 token 随 update 入日志）。
 */
import { Bot } from 'grammy';
import { env } from '../../config/env.js';
import { withRetry } from '../../collectors/types.js';
import { applyReview as defaultApplyReview, type ApplyReviewResult } from './approve.js';
import { CALLBACK_APPROVE_OP, CALLBACK_PREFIX } from './card.js';

/** token = `randomBytes(16).toString('hex')` = 恰 32 位小写十六进制（定长 + 字符集闸）。 */
const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * 解析 + 校验 `callback_data`（design D3）：仅接受 `mrpr:<token>:approve`，token 须过定长/字符集。
 * 拒未知 op、拒多余分段、拒非法 token。返回 token（合法）或 `null`（拒绝，调用方不打 DB）。
 *
 * 篡改金额无从注入：结构上只有 3 段、op 白名单、token 为 32-hex——任何塞进金额的变体（多段 / token 位放数字）
 * 都被拒，money 值只可能来自服务端冻结行。
 */
export function parseApprovalCallback(data: string): string | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  const [prefix, token, op] = parts;
  if (prefix !== CALLBACK_PREFIX) return null;
  if (op !== CALLBACK_APPROVE_OP) return null; // 拒未知 op（本期只 approve，忽略 reject）。
  if (!token || !TOKEN_RE.test(token)) return null;
  return token;
}

/** kind → 用户可见反馈文案（applied 另去按钮）。 */
function answerText(result: ApplyReviewResult): string {
  switch (result.kind) {
    case 'applied':
      return '✅ 已应用';
    case 'noop':
      return '已处理/已过期，请等新卡';
    case 'baseline-drift':
      return '价已变，请复核';
    case 'failed':
      return '应用失败，将重新浮现';
  }
}

/** 日志 sink：**只落 err.message**（不落含 payload 的 error 对象，token/callback_data 已随 update 脱敏）。 */
function logRedacted(msg: string, err: unknown): void {
  console.error(
    `${msg}（token/callback_data 已脱敏）: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** grammY Context 的最小能力面（便于单测注入 mock ctx，不建真 bot）。 */
export interface ApprovalCtx {
  callbackQuery?: {
    data?: string;
    from?: { id?: number };
  };
  /** grammY shortcut：回调所在 chat（= callback_query.message.chat）——用于通道绑定校验。 */
  chat?: { id?: number };
  answerCallbackQuery(other?: { text?: string }): Promise<unknown>;
  editMessageText(text: string): Promise<unknown>;
}

/** handler 依赖（注入便于单测）。 */
export interface ApprovalHandlerDeps {
  applyReview: typeof defaultApplyReview;
  approverIds: readonly number[];
  /** 目标 chat id（数值化 TELEGRAM_CHAT_ID）——回调须来自此 chat，能力绑定通道。 */
  chatId: number;
}

/** 出站重试参数（answerCallbackQuery / editMessageText）：小步退避，日志脱敏。 */
const OUTBOUND_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  logError: logRedacted,
} as const;

async function answer(ctx: ApprovalCtx, text: string): Promise<void> {
  await withRetry(() => ctx.answerCallbackQuery({ text }), {
    ...OUTBOUND_RETRY,
    label: 'mr-curation-answerCallback',
  });
}

/**
 * 处理一次 `callback_query:data`（design D5，顺序不可乱：解析校验 → 鉴权 → DB）。
 * 本函数**不抛**（内部兜底记日志 + 尽力反馈）——由 `bot.on('callback_query:data')` 直接挂。
 */
export async function handleApprovalCallback(
  ctx: ApprovalCtx,
  deps: ApprovalHandlerDeps,
): Promise<void> {
  try {
    const data = ctx.callbackQuery?.data;
    if (!data) return; // 非数据回调（非本 bot 关切）——不处理。

    // ① 解析 + 校验 token/op（任何 DB 往返之前）。拒 → 反馈通用文案、绝不打 DB。
    const token = parseApprovalCallback(data);
    if (!token) {
      await answer(ctx, '无法识别的操作');
      return;
    }

    // ② 鉴权：from.id 数值化 ∈ 白名单（缺 from → 拒；非清单 → 拒）——仍在任何 DB 往返之前。
    const fromId = ctx.callbackQuery?.from?.id;
    if (typeof fromId !== 'number' || !deps.approverIds.includes(fromId)) {
      // 只记数值 id（不记 token/callback_data）；缺 from 记 -1。
      console.error(
        `[mr-curation] 拒绝越权批准点按 user=${typeof fromId === 'number' ? fromId : -1}`,
      );
      await answer(ctx, '无批准权限');
      return;
    }

    // ②' 通道绑定：回调须来自目标 chat（能力绑定通道 + 点按人，纵深防御）——仍在任何 DB 往返之前。
    if (ctx.chat?.id !== deps.chatId) {
      console.error(
        `[mr-curation] 拒绝非目标 chat 的批准点按 chat=${typeof ctx.chat?.id === 'number' ? ctx.chat.id : -1}`,
      );
      await answer(ctx, '无权限');
      return;
    }

    // ③ 通过 → 落库（money 值/币种/provenance 由 applyReview 服务端按 token 读冻结行；入站只给 token+id）。
    const result = await deps.applyReview(token, String(fromId));
    await answer(ctx, answerText(result));

    if (result.kind === 'applied') {
      // editMessageText 去按钮（不传 reply_markup → 移除 inline keyboard）。best-effort：失败不回退已成功的批准。
      try {
        await withRetry(
          () => ctx.editMessageText('✅ 已应用（Model Radar 价格已更新，落库用冻结值）'),
          { ...OUTBOUND_RETRY, label: 'mr-curation-editMessage' },
        );
      } catch (err) {
        logRedacted('[mr-curation] editMessageText 去按钮失败（批准仍成功）', err);
      }
      console.error(
        `[mr-curation] 批准已应用 review=${result.reviewId} plan=${result.planId}`,
      );
    } else if (result.kind !== 'noop') {
      console.error(`[mr-curation] 批准未落库 review=${result.reviewId} kind=${result.kind}`);
    }
  } catch (err) {
    // applyReview 基础设施抛错（认领前）等：记脱敏日志 + 尽力反馈，绝不把含 token 的 update 冒泡给 bot.catch。
    logRedacted('[mr-curation] 批准处理异常', err);
    try {
      await answer(ctx, '处理失败，请重试');
    } catch (answerErr) {
      logRedacted('[mr-curation] 批准处理异常后反馈也失败', answerErr);
    }
  }
}

/** 已启动的批准 bot 句柄（供优雅关闭）。 */
export interface ApprovalBotHandle {
  /** 停止长轮询（web 优雅关闭时随快照 bg 一并调用）。 */
  stop(): Promise<void>;
}

export interface StartApprovalBotOptions {
  /** 注入 grammY bot（测试/复用）；缺省按 env.TELEGRAM_BOT_TOKEN 新建。 */
  bot?: Bot;
  /** 覆盖依赖（测试注入 applyReview 桩 / 白名单）；缺省用真实 applyReview + env 白名单。 */
  deps?: Partial<ApprovalHandlerDeps>;
}

/**
 * 启动批准接收 bot（**仅 web 镜像调用**，design D4）。注册 `callback_query:data` handler + 长轮询。
 * grammY 内建 getUpdates 网络错误重试/退避满足「轮询有重试」；`bot.catch` 兜底记脱敏日志。
 *
 * 调用方须已确认 `env.TELEGRAM_APPROVER_IDS` 非空（缺白名单不 start bot，见 index.ts 门控）。
 */
export function startApprovalBot(
  options: StartApprovalBotOptions = {},
): ApprovalBotHandle {
  // 测试安全守卫：VITEST 下若未注入 bot（即将用真实 token 连生产 Telegram 长轮询）直接抛错。
  // 测试请直接测 handleApprovalCallback / parseApprovalCallback，不建真 bot。
  if (process.env.VITEST && !options.bot) {
    throw new Error(
      'startApprovalBot: 测试环境（VITEST）禁止构造真实批准 bot——会连生产 Telegram 长轮询。' +
        '请直接测 handleApprovalCallback / parseApprovalCallback。',
    );
  }
  const bot = options.bot ?? new Bot(env.TELEGRAM_BOT_TOKEN);
  const chatId = options.deps?.chatId ?? Number(env.TELEGRAM_CHAT_ID);
  // 频道绑定要求数值 chat id；TELEGRAM_CHAT_ID 是 string（发送侧接受 @username），非数值 → NaN，
  // 而 `ctx.chat.id !== NaN` 恒真会静默拒绝所有批准（fail-closed 但无告警）。显式告警把「静默禁用」变「可见禁用」。
  if (Number.isNaN(chatId)) {
    console.error(
      '[mr-curation] 批准 bot 未启动：TELEGRAM_CHAT_ID 非数值（批准频道绑定要求数值 chat id，' +
        '否则所有批准被拒）。请将 TELEGRAM_CHAT_ID 设为数值 chat id。',
    );
    return { stop: () => Promise.resolve() };
  }
  const deps: ApprovalHandlerDeps = {
    applyReview: options.deps?.applyReview ?? defaultApplyReview,
    approverIds: options.deps?.approverIds ?? env.TELEGRAM_APPROVER_IDS,
    chatId,
  };

  bot.on('callback_query:data', (ctx) =>
    handleApprovalCallback(ctx as unknown as ApprovalCtx, deps),
  );
  // bot.catch：轮询/处理未捕获错误的兜底记日志——**只落 err.message**（不落含 update 的 error 对象，token 脱敏）。
  bot.catch((err) => logRedacted('[mr-curation] 批准 bot 轮询/处理错误', err.error ?? err));

  // 不 await start()（长轮询常驻，promise 直到 stop() 才 resolve，design D4）。
  void bot.start({
    onStart: () =>
      console.error('[mr-curation] 批准 bot 长轮询已启动（web 单副本，单 getUpdates 消费者）'),
  });

  return { stop: () => bot.stop() };
}
