/**
 * 运维告警出口（platform-foundation「运维告警落真实通道并由 DB 唯一约束限频」）。
 *
 * 在此之前，本仓的「告警」终点是 `console.error('[pipeline][ALERT] …')`——`worker` 从不注入
 * 真 sink。规范里反复建立的「logError 不是告警出口 / classifySystemFailure 是」这个区分，在代码里
 * 是同一个 console.error、只差一个前缀。任何「让失败响起来」的护栏因此都是空的。
 *
 * **限频住在 DB 里，不在进程里**：告警经 `push_records` 的
 * `UNIQUE(target_type, target_id, channel, push_date)` 落地——`target_type='ops-alert'`、
 * `target_id=<dedupKey>`。首次告警 INSERT 成功并发送；同日同 dedupKey 的后续告警撞唯一键、
 * `ON CONFLICT DO NOTHING` 返回 0 行，直接跳过。由此白拿三件事：
 *
 * 1. **零新状态**：不需要 Redis 键、不需要进程内 Map。后者会在每次 redeploy 复位 ⇒「连续 N 轮
 *    失败才告警」永不达标 ⇒ 静默不告警，比刷屏更糟。
 * 2. **跨进程 / 跨重启 / 跨链自动去重**：日报链（每天一次）与高频告警链（每 15 分钟一次）用同一个
 *    dedupKey ⇒ 一条先告了，另一条自动命中唯一键冲突而跳过。sitemap 每轮都 throw 时，96 轮里只响一次。
 * 3. **幂等由 DB 唯一约束保障**，与本仓第一架构原则一致——绝不交给应用层自由发挥。
 *
 * **发送失败不占当日名额**：sender 抛错时删掉那条 pending 行。否则一次网络抖动 =
 * 当天该告警彻底哑火（下次同 dedupKey 命中 ON CONFLICT DO NOTHING 而跳过）。
 */
import { and, eq, sql } from 'drizzle-orm';

import { isFeishuEnabled } from '../config/env.js';
import { db as defaultDb } from '../db/index.js';
import { pushRecords } from '../db/schema.js';
import type { MessageSender } from '../push/dispatcher.js';
import { createFeishuSender } from '../push/feishu.js';
import { createTelegramSender } from '../push/telegram.js';
import { getPushDate } from '../push/push-date.js';
import { CHANNEL, TARGET_TYPE, type Channel } from '../push/targets.js';

/**
 * 告警明细。`dedupKey` **必填**——它是 `push_records.target_id`（`varchar(128) NOT NULL`），
 * 也是当日限频的键。必填让编译器逼出每一个告警调用方；写成可选时，忘传的调用方会在运行时
 * 违反 NOT NULL、被 sink 的 best-effort catch 吞掉 ⇒ 那条告警连 stderr 都不再有。
 */
export interface AlertDetail {
  /** 当日限频键（每 dedupKey 每通道每天至多一条）。形如 `source-health:sitemap`。 */
  dedupKey: string;
  [key: string]: unknown;
}

/** 告警出口。可返回 Promise——真 sink 要做 DB 写入 + 网络发送，调用方 MUST await。 */
export type AlertSink = (message: string, detail: AlertDetail) => void | Promise<void>;

/** 兜底出口：未配置任何推送通道时用它。**不写 `push_records`**——否则「没通道」会被算成「今天已告过」。 */
export const consoleAlertSink: AlertSink = (message, detail) =>
  console.error(`[pipeline][ALERT] ${message}`, detail);

export interface OpsAlertSinkOptions {
  /** 已配置的通道 → sender。空对象 ⇒ 回落 `consoleAlertSink`。 */
  senders: Partial<Record<Channel, MessageSender>>;
  /** 可注入 db 或事务句柄（默认全局 db）。 */
  dbh?: typeof defaultDb;
  /** 可注入「现在」（默认 `new Date()`）——两条链必须用同一口径算 push_date。 */
  now?: () => Date;
}

/**
 * 造一个把运维告警落到真实通道、并由 DB 唯一约束限频的 sink。
 *
 * `push_date` 一律经 `getPushDate()`（`env.PUSH_TIMEZONE`，Asia/Shanghai）——**不可用 UTC 日**：
 * UTC 日界是 08:00 CST，而日报链恰在 08:03 CST 跑，只差 3 分钟。两条链若各算各的日期，
 * 唯一键就挡不住跨午夜的那一轮 ⇒ 持续故障期天天双响。
 */
export function createOpsAlertSink(options: OpsAlertSinkOptions): AlertSink {
  const { senders, dbh = defaultDb, now = () => new Date() } = options;
  const channels = Object.keys(senders) as Channel[];

  if (channels.length === 0) return consoleAlertSink;

  return async (message, detail) => {
    const pushDate = getPushDate(now());

    for (const channel of channels) {
      const sender = senders[channel];
      if (!sender) continue;

      try {
        // 唯一键冲突 = 今天已就该 dedupKey 告过警 → 0 行 → 跳过。这就是限频。
        const claimed = await dbh
          .insert(pushRecords)
          .values({
            targetType: TARGET_TYPE['ops-alert'],
            targetId: detail.dedupKey,
            channel,
            pushDate,
            status: 'pending',
          })
          .onConflictDoNothing()
          .returning({ id: pushRecords.id });

        if (claimed.length === 0) continue;

        try {
          await sender.send(message, 'MarkdownV2');
          await dbh
            .update(pushRecords)
            .set({ status: 'success' })
            .where(eq(pushRecords.id, claimed[0]!.id));
        } catch (sendErr) {
          // 发送失败 ⇒ 删掉 pending 行，不占当日名额（否则一次网络抖动 = 当天该告警彻底哑火）。
          await dbh.delete(pushRecords).where(eq(pushRecords.id, claimed[0]!.id));
          console.error(
            `[ops-alert] 发送失败（已释放当日名额，下次同 dedupKey 会重试）：channel=${channel} dedupKey=${detail.dedupKey}`,
            sendErr,
          );
        }
      } catch (err) {
        // best-effort：告警自身绝不向上抛错（它是可观测，不是业务路径）。至少留 stderr。
        console.error(
          `[ops-alert] 告警落库失败：channel=${channel} dedupKey=${detail.dedupKey} — ${message}`,
          err,
        );
      }
    }
  };
}

/**
 * 生产装配：已配置通道全集，限频由 `push_records` 的唯一键承载。
 *
 * **VITEST 下回落 stderr**（与 `createTelegramSender` / `createFeishuSender` 自身的守卫同口径）：
 * `run(ctx)` 在 run-lane-wrappers 单测里被直调，若在此构造真实 sender 会真发到生产 chat。
 * 本函数住在这里而非 run-daily-workflow：后者是 lane 业务模块，受 driver-decoupling 守卫约束、
 * 禁读裸 `process.env`（见 pipeline/__tests__/driver-decoupling.guard.test.ts）。装配属基础设施。
 *
 * 未配置任何通道时 `createOpsAlertSink` 自行回落 `consoleAlertSink`，且**不写** `push_records`
 * ——否则「没通道」会被限频键算成「今天已告过」，真接上通道那天反而不响。
 */
export function buildOpsAlertSink(): AlertSink {
  if (process.env.VITEST) return consoleAlertSink;

  const senders: Partial<Record<Channel, MessageSender>> = {
    [CHANNEL.telegram]: createTelegramSender(),
  };
  if (isFeishuEnabled()) senders[CHANNEL.feishu] = createFeishuSender();
  return createOpsAlertSink({ senders });
}

/** 供测试断言 sink 确实经 DB 限频（而非进程内状态）。 */
export const OPS_ALERT_TARGET_TYPE = TARGET_TYPE['ops-alert'];

/** 当日某 dedupKey 是否已成功告警（供测试/可观测查询）。 */
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
