/**
 * 运维告警出口（platform-foundation「运维告警落真实通道并由 DB 唯一约束限频」）。
 *
 * 在此之前，本仓的「告警」终点是 `console.error('[pipeline][ALERT] …')`——`worker` 从不注入
 * 真 sink。规范里反复建立的「logError 不是告警出口 / classifySystemFailure 是」这个区分，在代码里
 * 是同一个 console.error、只差一个前缀。任何「让失败响起来」的护栏因此都是空的。
 *
 * **限频住在 DB 里，不在进程里**：告警经 `push_records` 的
 * `UNIQUE(target_type, target_id, channel, push_date)` 落地——`target_type='ops-alert'`、
 * `target_id=<dedupKey>`。限频的真实语义是「**今天该 dedupKey 该通道已有一条 `status='success'` 行**」
 * ——与 `hasAlertedToday()` 查的完全是同一个东西，两个口径合一。故认领用
 * `ON CONFLICT DO UPDATE ... WHERE status <> 'success'`：
 * - 已有 `success` 行 → setWhere 不满足 → 0 行 → 跳过（这才是真限频）；
 * - 有 `pending`（进程崩在发送前的残行）/ `failed`（上次发送失败）→ **重新认领 → 重试**；
 * - 无行 → INSERT → 发送。
 *
 * 若改用 `ON CONFLICT DO NOTHING`，**任何 status** 的残行都会挡住当天全部重试——一条崩溃遗留的
 * pending 就足以让该告警当天彻底哑火（消息从未发出），而 `hasAlertedToday()` 仍报 false：限频口径
 * 与可观测口径分裂，连「今天没告成」都看不出来。
 *
 * **当前接线**：只有日报链注入真 sink——`run-daily-workflow.ts` 5 处 `alert()` +
 * `product-digest.ts` 3 处。故重复告警的真实来源是 **BullMQ 对同一 daily job 的重试**（同日重跑撞
 * 唯一键即跳过），这是本 sink 的实际收益。
 * **待接**：高频链（`alert-scan.ts`）目前零 `alert()` 调用、无 AlertSink 注入口；单源采集失败的
 * 源级健康告警也尚无告警点（`classifySystemFailure` 只在「整体采集为 0」或「全部不可处理」时才响，
 * 单源 throw 而其余源正常时不告警）。两者接入前，不要在本文件预支它们的行为。
 *
 * **发送失败写 `failed`、不删行**（CLAUDE.md 推送不变量：先 `pending`、成功 `success`、失败 `failed`）。
 * `failed` 行满足 `status <> 'success'` → 下次同 dedupKey 可被重新认领重试；且 DB 里查得到「告警发送
 * 失败」这一事实（DELETE 会把它抹掉）。
 *
 * **DB 挂了时不哑火**：认领本身抛错 → 降级为**不去重直接发**，并在消息里标注「限频不可用（DB 异常）」。
 * `product-digest` 那条「待中文化产品查询失败（如 DB 断连）」的告警恰恰在 DB 断连时触发——若认领失败
 * 即放弃发送，最需要告警的那类故障上通道全哑。宁可重复一条，不可哑火。
 */
import { and, eq, sql } from 'drizzle-orm';

import { isFeishuEnabled } from '../config/env.js';
import { db as defaultDb } from '../db/index.js';
import { pushRecords } from '../db/schema.js';
import type { MessageSender } from '../push/dispatcher.js';
import { createFeishuSender } from '../push/feishu.js';
import { createTelegramSender } from '../push/telegram.js';
import {
  escapeLarkMdText,
  escapeMarkdownV2,
  MAX_MESSAGE_LENGTH,
  truncateByCodePoint,
  type FeishuCard,
} from '../push/message.js';
import { getPushDate } from '../push/push-date.js';
import { CHANNEL, TARGET_TYPE, type Channel } from '../push/targets.js';

/**
 * 告警明细。`dedupKey` **必填**——它是 `push_records.target_id`（`varchar(128) NOT NULL`），
 * 也是当日限频的键。必填让编译器逼出每一个告警调用方；写成可选时，忘传的调用方会在运行时
 * 违反 NOT NULL、被 sink 的 best-effort catch 吞掉 ⇒ 那条告警连 stderr 都不再有。
 *
 * 其余字段是**上下文**（kind / collectedCount / failed / staleSources / error …），会被摘要进消息体
 * ——运维在通道里收到的不能是一句没有上下文的裸话。
 */
export interface AlertDetail {
  /** 当日限频键（每 dedupKey 每通道每天至多一条成功告警）。形如 `degrade-abort:value-judge`。 */
  dedupKey: string;
  [key: string]: unknown;
}

/** 告警出口。可返回 Promise——真 sink 要做 DB 写入 + 网络发送，调用方 MUST await。 */
export type AlertSink = (message: string, detail: AlertDetail) => void | Promise<void>;

/** 兜底出口：未配置任何推送通道时用它。**不写 `push_records`**——否则「没通道」会被算成「今天已告过」。 */
export const consoleAlertSink: AlertSink = (message, detail) =>
  console.error(`[pipeline][ALERT] ${message}`, detail);

/** 告警卡片/消息标题。 */
const ALERT_TITLE = '⚠️ AI Radar 运维告警';

/** 单个 detail 字段值的展示上限（防超长 error stack / 大对象撑爆一条告警）。 */
const DETAIL_VALUE_MAX = 200;

/** Error 的 cause 链最多展开几层（防自引用/深链把消息撑爆）。 */
const CAUSE_CHAIN_MAX = 3;

/** 认领失败（DB 异常）时附在消息尾部的显式声明——收到的人必须知道这条没经过去重。 */
const RATE_LIMIT_UNAVAILABLE = '限频不可用（DB 异常）：本条未经 push_records 去重，同日可能重复。';

/**
 * 单条告警的发送超时。telegram 走 grammY（默认 timeoutSeconds=500）、feishu 走
 * `withRetry(3) × COLLECTOR_FETCH_TIMEOUT_MS`——不设上界时，一个挂起的通道能把熔断中止推迟数分钟。
 * ponytail: 只做「不再等」的超时，不取消底层请求（grammY 无 signal 缝）；到点即让本通道计为失败、
 * 写 `failed` 行、下次可重试。
 */
const SEND_TIMEOUT_MS = 10_000;

export interface OpsAlertSinkOptions {
  /** 已配置的通道 → sender。空对象 ⇒ 回落 `consoleAlertSink`。 */
  senders: Partial<Record<Channel, MessageSender>>;
  /** 可注入 db 或事务句柄（默认全局 db）。 */
  dbh?: typeof defaultDb;
  /** 可注入「现在」（默认 `new Date()`）——各链必须用同一口径算 push_date。 */
  now?: () => Date;
}

/** 到点即 reject 的超时包装（不取消底层请求；见 SEND_TIMEOUT_MS）。 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 发送超时（${ms}ms）`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Error 的展示串——**必须沿 `cause` 链走**，否则告警正文里不会出现真正的故障原因。
 *
 * drizzle 把查询错误包成 `DrizzleQueryError`，其 `.message` 是 `Failed query: <SQL>\nparams: …`，
 * 而**真正的原因（`connect ECONNREFUSED …` / `password authentication failed …`）住在 `.cause`**。
 * 只取 `.message` 的话，「产品中文化待处理查询失败（系统故障可观测，如 DB 断连）」这条告警发出去的
 * 正文就是一段 SQL 前缀，一个字都没提数据库连不上——那条告警存在的全部理由就在 `.cause` 里。
 *
 * （已实测：pg / drizzle 的 message 与 cause 均**不含** DSN 或口令，故沿链外发无凭据泄漏风险。）
 */
function formatError(e: Error, depth = 0): string {
  const head = `${e.name}: ${e.message}`;
  if (depth >= CAUSE_CHAIN_MAX || !(e.cause instanceof Error)) return head;
  return `${head} | cause: ${formatError(e.cause, depth + 1)}`;
}

/** detail 字段值的展示串（Error 沿 cause 链；对象 JSON 化；一律按 code point 截断）。 */
function formatDetailValue(v: unknown): string {
  const s =
    v instanceof Error
      ? formatError(v)
      : typeof v === 'object' && v !== null
        ? (() => {
            try {
              return JSON.stringify(v) ?? String(v);
            } catch {
              return String(v);
            }
          })()
        : String(v);
  // 按 code point 截断（复用 push/message.ts 的既有实现）：裸 .slice 会把 emoji 截成孤儿代理对。
  return truncateByCodePoint(s, DETAIL_VALUE_MAX);
}

/** 把 detail 摘要成正文行（dedupKey 放最后一行，其余字段按声明序）。 */
function detailLines(detail: AlertDetail): string[] {
  const lines = Object.entries(detail)
    .filter(([k]) => k !== 'dedupKey')
    .map(([k, v]) => `${k}=${formatDetailValue(v)}`);
  lines.push(`dedupKey=${detail.dedupKey}`);
  return lines;
}

/**
 * 把 `prefix + body` 交 `escapeMarkdownV2` 后不超过 `limit`：二分 `body` 的 code-point 前缀、取「转义后仍
 * ≤ limit」的最大前缀再整体转义。转义结果对更长输入单调不减，故二分成立；返回的是**转义后**的串——不是
 * 「先转义再截」，故不会留孤儿反斜杠。`prefix`（固定标题）计入每次整体转义的长度。常见路径（整体不超限）
 * 只做一次转义。
 */
function escapeToLimit(prefix: string, body: string, limit: number): string {
  const cps = [...body];
  const escapedAt = (n: number): string => escapeMarkdownV2(prefix + cps.slice(0, n).join(''));
  const full = escapedAt(cps.length);
  if (full.length <= limit) return full;
  let lo = 0;
  let hi = cps.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (escapedAt(mid).length <= limit) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return escapedAt(best);
}

/**
 * 按通道渲染一条告警——**两个通道的 sender 契约完全不同，绝不能给它们同一个裸文本**：
 * - telegram：`api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' })`，**零转义**。告警文案
 *   含 `.` `-` `(` `)` `!` 等 MarkdownV2 保留字（如「降级率 42.9% 超阈值（30%），中止本次流水线。」），
 *   不转义 ⇒ Telegram API 400 拒收。整条一次性 `escapeMarkdownV2`（不留任何 markup 标记，
 *   使「保留字必被反斜杠前导」这条不变量可被测试整体断言）。
 * - feishu：`send(text)` 的第一件事是 `JSON.parse(text)` 取 `{ card }`。裸文本 ⇒ 当场抛。
 *   故必须交 `JSON.stringify({ card })`，卡片结构照 `mr/curation/card.ts` 的范式
 *   （`config.wide_screen_mode` + `header{title, template}` + `elements[{tag:'div', text:{tag:'lark_md'}}]`），
 *   正文经 `escapeLarkMdText`。
 */
function renderAlert(channel: Channel, lines: readonly string[]): string {
  // 截断必须在转义【之前】、按 code point——先转义再截会把反斜杠截在半路；裸 .slice 又会把 emoji 截成
  // 孤儿代理对。先按转义前字符数粗截（feishu 分支用它；也作 telegram 二分的上界）。
  const body = truncateByCodePoint(
    lines.join('\n'),
    MAX_MESSAGE_LENGTH - [...ALERT_TITLE].length - 1,
  );
  switch (channel) {
    case 'telegram':
      // escapeMarkdownV2 每个保留字前加 `\`、最坏近乎翻倍，故**按转义后长度**限长（仅粗截转义前字符数
      // 不足以保证不超 Telegram 4096）：二分正文 code-point 前缀，取「转义后仍 ≤ MAX_MESSAGE_LENGTH」的
      // 最大前缀，再整体转义（不留孤儿反斜杠）。全正常字符时前缀=全文、全保留字时约取一半，均不超限。
      return escapeToLimit(`${ALERT_TITLE}\n`, body, MAX_MESSAGE_LENGTH);
    case 'feishu': {
      const card: FeishuCard = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: ALERT_TITLE },
          template: 'red',
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: escapeLarkMdText(body) } },
        ],
      };
      return JSON.stringify({ card });
    }
    default: {
      // 穷尽性检查：channelEnum 新增成员而本处未加渲染分支时编译期报错（防又一条通道收到裸文本）。
      const exhaustive: never = channel;
      throw new Error(`renderAlert: 未知 channel=${String(exhaustive)}`);
    }
  }
}

/**
 * 造一个把运维告警落到真实通道、并由 DB 唯一约束限频的 sink。
 *
 * `push_date` 一律经 `getPushDate()`（`env.PUSH_TIMEZONE`，Asia/Shanghai）——**不可用 UTC 日**：
 * UTC 日界是 08:00 CST，而日报链恰在 08:03 CST 跑，只差 3 分钟。各链若各算各的日期，
 * 唯一键就挡不住跨午夜的那一轮 ⇒ 持续故障期天天双响。
 *
 * 多通道**并发**发送（`Promise.allSettled`）：顺序循环下 telegram 挂起会连带饿死 feishu 那条告警。
 */
export function createOpsAlertSink(options: OpsAlertSinkOptions): AlertSink {
  const { senders, dbh = defaultDb, now = () => new Date() } = options;
  const channels = Object.keys(senders) as Channel[];

  if (channels.length === 0) return consoleAlertSink;

  return async (message, detail) => {
    const pushDate = getPushDate(now());
    const baseLines = [message, ...detailLines(detail)];

    await Promise.allSettled(
      channels.map(async (channel) => {
        const sender = senders[channel];
        if (!sender) return;

        // 1. 认领当日名额：只有【未成功】的行可被重新认领（崩溃残 pending / 上次 failed）。
        //    已有 success 行 → 0 行 → 跳过。这就是限频，且与 hasAlertedToday() 同口径。
        let claimedId: bigint | null = null;
        let rateLimitDown = false;
        try {
          const claimed = await dbh
            .insert(pushRecords)
            .values({
              targetType: TARGET_TYPE['ops-alert'],
              targetId: detail.dedupKey,
              channel,
              pushDate,
              status: 'pending',
            })
            .onConflictDoUpdate({
              target: [
                pushRecords.targetType,
                pushRecords.targetId,
                pushRecords.channel,
                pushRecords.pushDate,
              ],
              set: { status: 'pending', errorMessage: null, updatedAt: sql`now()` },
              setWhere: sql`${pushRecords.status} <> 'success'`,
            })
            .returning({ id: pushRecords.id });

          if (claimed.length === 0) return; // 今天已成功告过 → 真跳过。
          claimedId = claimed[0]!.id;
        } catch (claimErr) {
          // 告警通路不能依赖它要告警的那个子系统：DB 挂了正是最该响的时候。降级为不去重直接发。
          rateLimitDown = true;
          console.error(
            `[ops-alert] 认领当日名额失败（降级为不去重直接发）：channel=${channel} dedupKey=${detail.dedupKey}`,
            claimErr,
          );
        }

        // 2. 按通道渲染 + 发送（带超时，防单通道挂起拖死熔断中止）。
        const lines = rateLimitDown ? [...baseLines, RATE_LIMIT_UNAVAILABLE] : baseLines;
        try {
          await withTimeout(
            Promise.resolve(sender.send(renderAlert(channel, lines), 'MarkdownV2')),
            SEND_TIMEOUT_MS,
            `[ops-alert][${channel}]`,
          );
        } catch (sendErr) {
          console.error(
            `[ops-alert] 发送失败（置 failed，下次同 dedupKey 可重新认领重试）：` +
              `channel=${channel} dedupKey=${detail.dedupKey}`,
            sendErr,
          );
          const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          await setStatus(dbh, claimedId, 'failed', msg);
          return;
        }

        // 3. 成功 → success + pushed_at（与 dispatcher 终态同口径；否则 ops-alert 行永远
        //    status='success' AND pushed_at IS NULL）。
        await setStatus(dbh, claimedId, 'success');
      }),
    );
  };
}

/**
 * 把认领到的那行置终态。`id` 为 null（认领时 DB 已挂）→ 无行可改，跳过。
 * best-effort：终态写库再抛错也只留 stderr——告警是可观测，绝不向业务路径抛。
 */
async function setStatus(
  dbh: typeof defaultDb,
  id: bigint | null,
  status: 'success' | 'failed',
  errorMessage?: string,
): Promise<void> {
  if (id === null) return;
  try {
    await dbh
      .update(pushRecords)
      .set(
        status === 'success'
          ? {
              status: 'success',
              pushedAt: new Date(),
              errorMessage: null,
              updatedAt: sql`now()`,
            }
          : {
              status: 'failed',
              errorMessage: (errorMessage ?? '').slice(0, 1000),
              updatedAt: sql`now()`,
            },
      )
      .where(eq(pushRecords.id, id));
  } catch (err) {
    console.error(`[ops-alert] 终态写库失败（消息已发/已失败，行状态可能滞留）：id=${id}`, err);
  }
}

/**
 * 生产装配：已配置通道全集，限频由 `push_records` 的唯一键承载。
 *
 * **惰性构造真实 sender**：`run(ctx)` 在 run-lane-wrappers 单测里被以桩核心直调（不会真告警），
 * 若在此立刻构造真实 sender 会撞上 `createTelegramSender`/`createFeishuSender` 自身的 VITEST 守卫。
 * 推迟到首次真告警才装配 ⇒ **不需要本函数再加一层 VITEST 短路**——那层短路会让
 * `createOpsAlertSink → sender.send(...)` 这段接线在测试里从不执行（渲染契约无从被测试证伪）。
 * 传入 `senders` 即显式注入（测试注入 mock / 带桩 transport 的真实 sender），走同一条接线。
 *
 * 本函数住在这里而非 run-daily-workflow：后者是 lane 业务模块，受 driver-decoupling 守卫约束、
 * 禁读裸 `process.env`（见 pipeline/__tests__/driver-decoupling.guard.test.ts）。装配属基础设施。
 *
 * 未配置任何通道时 `createOpsAlertSink` 自行回落 `consoleAlertSink`，且**不写** `push_records`
 * ——否则「没通道」会被限频键算成「今天已告过」，真接上通道那天反而不响。
 */
export function buildOpsAlertSink(
  senders?: Partial<Record<Channel, MessageSender>>,
  now?: () => Date,
): AlertSink {
  if (senders) return createOpsAlertSink({ senders, ...(now ? { now } : {}) });

  let sink: AlertSink | undefined;
  return (message, detail) => {
    // 惰性构造【必须】兜底：createOpsAlertSink 内部每一层都有 catch（认领 / 发送 / 终态写库），
    // 唯独构造本身没有。sender 工厂抛错时 throw 会直接穿到调用方——而 product-digest 的
    // `await alert(...)` 就在 catch 里、其契约是「整步永不向上抛」；run-daily-workflow 的三处
    // `await alert(...)` 紧接 `throw new WorkflowAbortError(...)`，告警抛错会把熔断错误类型整个换掉。
    // 「告警绝不向业务路径抛」这条不变量，不能因为多了一层惰性就漏一个口子。
    if (sink === undefined) {
      try {
        sink = buildProductionSink(now);
      } catch (err) {
        console.error('[ops-alert] 装配真实通道失败，回落 stderr：', err);
        sink = consoleAlertSink;
      }
    }
    return sink(message, detail);
  };
}

/** 按 env 装配已配置通道的真实 sender（telegram 必配、飞书可选）。 */
function buildProductionSink(now?: () => Date): AlertSink {
  const senders: Partial<Record<Channel, MessageSender>> = {
    [CHANNEL.telegram]: createTelegramSender(),
  };
  if (isFeishuEnabled()) senders[CHANNEL.feishu] = createFeishuSender();
  return createOpsAlertSink({ senders, ...(now ? { now } : {}) });
}

/** 供测试断言 sink 确实经 DB 限频（而非进程内状态）。 */
export const OPS_ALERT_TARGET_TYPE = TARGET_TYPE['ops-alert'];

/**
 * 当日某 dedupKey 是否已**成功**告警（供测试/可观测查询）。
 * 与认领的 `setWhere status <> 'success'` 是同一个口径：存在 success 行 = 今天已告过 = 不再发。
 */
export async function hasAlertedToday(
  dedupKey: string,
  at: Date = new Date(),
  dbh: typeof defaultDb = defaultDb,
): Promise<boolean> {
  const rows = await dbh
    .select({ n: sql<number>`count(*)::int` })
    .from(pushRecords)
    .where(
      and(
        eq(pushRecords.targetType, OPS_ALERT_TARGET_TYPE),
        eq(pushRecords.targetId, dedupKey),
        eq(pushRecords.pushDate, getPushDate(at)),
        eq(pushRecords.status, 'success'),
      ),
    );
  return (rows[0]?.n ?? 0) > 0;
}
