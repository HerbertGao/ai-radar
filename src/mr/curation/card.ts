/**
 * Model Radar 价格 curation 待批卡片渲染（add-model-radar-price-curation-approval，design D3/D7，task 6.3）。
 *
 * 两张卡片、两种信任面：
 * - **Telegram 一键批准卡片**：inline-keyboard，`callback_data = "mrpr:<token>:approve"`。令牌是**群频道里的能力**，
 *   只允许走 Telegram `callback_data`（bot-token 认证通道 + `from.id` 白名单）。显 old→new diff + 源摘要。
 * - **飞书通知卡片**：飞书自定义机器人只出站、按钮为浏览器 GET 文字链（会被预览/扫描器零人工触发），故
 *   **禁止**承载任何 money-path 写——本卡片**无写按钮、无触发写的 URL、绝不携带 `token`**，只展示待复核价改
 *   + 引导人去 Telegram 批准（design D7）。
 *
 * 转义复用 `push/message.ts`（`escapeMarkdownV2`/`escapeMarkdownV2Url` for Telegram、
 * `escapeLarkMdText`/`escapeLarkMdUrl` for 飞书 lark_md），不另写转义。
 *
 * money-path 红线：本文件是**纯渲染**，不 import 任何事实 writer、不发 SQL、不发网络。
 */
import type { InlineKeyboardMarkup } from 'grammy/types';
import {
  escapeLarkMdText,
  escapeLarkMdUrl,
  escapeMarkdownV2,
  escapeMarkdownV2Url,
  type FeishuCard,
} from '../../push/message.js';
import type { MrCurrency } from './extract.js';

/** callback_data 前缀/后缀（telegram-callback 侧按 `mrpr:<token>:approve` 解析、忽略 reject）。 */
export const CALLBACK_PREFIX = 'mrpr';
export const CALLBACK_APPROVE_OP = 'approve';

/** 币种符号（展示用，非事实——落库仍用行上冻结值）。 */
const CURRENCY_SYMBOL: Record<MrCurrency, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
};

/** 卡片展示所需的待复核价改信息（**不含 token**——token 只进 Telegram callback_data）。 */
export interface PriceReviewCardInput {
  /** 套餐全名（展示）。 */
  planName: string;
  /** 开记录时冻结的现价快照（基线）。prefill 路径 gate 已保证非 NULL 且 >0。 */
  oldValue: number;
  /** 候选新价（异于现价）。 */
  newValue: number;
  currency: MrCurrency;
  /** 源页 URL（只读查看用）。 */
  sourceUrl: string;
  /** `|Δ|/current`（0..0.2 的小数，gate 产）。 */
  pctDelta: number;
}

/** Telegram 一键批准卡片渲染结果（挂 inline-keyboard）。 */
export interface TelegramReviewCard {
  text: string;
  parseMode: 'MarkdownV2';
  replyMarkup: InlineKeyboardMarkup;
}

/** `¥45.00` / `$45.00` / `€45.00`（展示串，未转义）。 */
function money(value: number, currency: MrCurrency): string {
  return `${CURRENCY_SYMBOL[currency]}${value.toFixed(2)}`;
}

/** old→new + 涨跌方向 + 百分比（展示串，未转义）。如 `¥40.00 → ¥45.00（涨 12.5%）`。 */
function diffLine(input: PriceReviewCardInput): string {
  const dir = input.newValue > input.oldValue ? '涨' : '降';
  const pct = (input.pctDelta * 100).toFixed(1);
  return `${money(input.oldValue, input.currency)} → ${money(input.newValue, input.currency)}（${dir} ${pct}%）`;
}

/**
 * Telegram 一键批准卡片。`callback_data = "mrpr:<token>:approve"`——token 是能力、只进 callback_data，
 * money 值/币种绝不进 callback_data（applyReview 服务端按 token 读行上冻结值）。
 */
export function buildPriceReviewTelegramCard(
  input: PriceReviewCardInput & { token: string },
): TelegramReviewCard {
  const lines = [
    `*${escapeMarkdownV2('Model Radar 价格待复核')}*`,
    `${escapeMarkdownV2('套餐：')}${escapeMarkdownV2(input.planName)}`,
    `${escapeMarkdownV2('价格：')}${escapeMarkdownV2(diffLine(input))}`,
    `[${escapeMarkdownV2('查看源页')}](${escapeMarkdownV2Url(input.sourceUrl)})`,
    escapeMarkdownV2('点下方按钮一键批准（仅授权人可批，落库用冻结值）。'),
  ];
  return {
    text: lines.join('\n'),
    parseMode: 'MarkdownV2',
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: '✅ 一键批准',
            callback_data: `${CALLBACK_PREFIX}:${input.token}:${CALLBACK_APPROVE_OP}`,
          },
        ],
      ],
    },
  };
}

/**
 * 飞书**通知**卡片（design D7）：**无写按钮、无触发写的 URL、不含 token**，只展示待复核价改 + 引导去
 * Telegram 批准。源链接仅为「只读查看」文字链（GET 只读，不触发任何 money-path 写）。
 */
export function buildPriceReviewFeishuCard(input: PriceReviewCardInput): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Model Radar 价格待复核' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**套餐**：${escapeLarkMdText(input.planName)}`,
            `**价格**：${escapeLarkMdText(diffLine(input))}`,
            `[查看源页](${escapeLarkMdUrl(input.sourceUrl)})`,
          ].join('\n'),
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          // 引导去 Telegram：飞书仅通知，批准唯一入口是 Telegram（无写按钮/无 token）。
          content: '⚠️ 批准请到 Telegram 群点「一键批准」（飞书仅通知，不承载批准写路径）。',
        },
      },
    ],
  };
}
