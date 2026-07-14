/**
 * 运维告警 sink 的集成测试（platform-foundation「运维告警落真实通道并由 DB 唯一约束限频」）。
 *
 * 这些断言必须跑在**真实 PG** 上——限频的全部机制就是 `push_records` 的
 * `UNIQUE(target_type, target_id, channel, push_date)`。任何内存桩都会让它们假绿：
 * 桩里「同 dedupKey 只发一次」是桩自己的逻辑，证明不了 DB 唯一键真的在挡。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { pushRecords } from '../../db/schema.js';
import { getPushDate } from '../../push/push-date.js';
import { CHANNEL } from '../../push/targets.js';
import type { MessageSender } from '../../push/dispatcher.js';
import {
  consoleAlertSink,
  createOpsAlertSink,
  hasAlertedToday,
  OPS_ALERT_TARGET_TYPE,
} from '../ops-alert-sink.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** 造一个记录调用、可选抛错的 sender 桩。 */
function stubSender(opts: { throws?: boolean } = {}): MessageSender & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(text: string) {
      calls.push(text);
      if (opts.throws) throw new Error('sender boom');
    },
  };
}

async function rowsFor(dedupKey: string) {
  return db
    .select({ status: pushRecords.status, channel: pushRecords.channel })
    .from(pushRecords)
    .where(
      and(
        eq(pushRecords.targetType, OPS_ALERT_TARGET_TYPE),
        eq(pushRecords.targetId, dedupKey),
      ),
    );
}

d('运维告警 sink：限频住在 DB 唯一键里（不是进程里）', () => {
  let key: string;

  beforeAll(() => {
    // 静音 best-effort 路径的 stderr（断言看的是 DB 行与 sender 调用次数）。
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => vi.restoreAllMocks());

  beforeEach(async () => {
    key = `test-alert:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await db.delete(pushRecords).where(eq(pushRecords.targetId, key));
  });

  it('同 dedupKey 同日重复告警 → sender 只被调一次（唯一键冲突即跳过）', async () => {
    const sender = stubSender();
    const alert = createOpsAlertSink({ senders: { [CHANNEL.telegram]: sender } });

    await alert('sitemap 整源失败', { dedupKey: key });
    await alert('sitemap 整源失败', { dedupKey: key });
    await alert('sitemap 整源失败', { dedupKey: key });

    // 高频链每 15 分钟一轮、每天 96 轮；这一条决定了它是「响一次」还是「刷屏 96 次」。
    expect(sender.calls).toHaveLength(1);

    const rows = await rowsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
    expect(await hasAlertedToday(key)).toBe(true);
  });

  it('两个【独立构造】的 sink 用同一 dedupKey → 仍只发一次（跨进程/跨链去重靠 DB，不靠进程状态）', async () => {
    // 模拟日报链与高频告警链各自构造 sink（生产就是两个进程/两次装配）。
    const senderA = stubSender();
    const senderB = stubSender();
    const alertFromDailyChain = createOpsAlertSink({ senders: { [CHANNEL.telegram]: senderA } });
    const alertFromAlertChain = createOpsAlertSink({ senders: { [CHANNEL.telegram]: senderB } });

    await alertFromAlertChain('源级健康告警', { dedupKey: key }); // 高频链先到（每 15 分钟一轮）
    await alertFromDailyChain('源级健康告警', { dedupKey: key }); // 日报链 08:03 才跑

    // 先到的那条发出去，后到的命中唯一键冲突而跳过——进程内 Map 做不到这一点（每次装配都是新的）。
    expect(senderB.calls).toHaveLength(1);
    expect(senderA.calls).toHaveLength(0);
    expect(await rowsFor(key)).toHaveLength(1);
  });

  it('发送失败 → 删掉 pending 行、不占当日名额（下次同 dedupKey 会重试）', async () => {
    const failing = stubSender({ throws: true });
    const alertFail = createOpsAlertSink({ senders: { [CHANNEL.telegram]: failing } });

    await alertFail('熔断中止', { dedupKey: key });

    expect(failing.calls).toHaveLength(1);
    // 名额已释放：不留 pending/failed 行。否则一次网络抖动 = 当天该告警彻底哑火。
    expect(await rowsFor(key)).toHaveLength(0);
    expect(await hasAlertedToday(key)).toBe(false);

    // 同日重试应真的重发（而非命中 ON CONFLICT DO NOTHING 而跳过）。
    const ok = stubSender();
    const alertOk = createOpsAlertSink({ senders: { [CHANNEL.telegram]: ok } });
    await alertOk('熔断中止', { dedupKey: key });

    expect(ok.calls).toHaveLength(1);
    expect(await hasAlertedToday(key)).toBe(true);
  });

  it('多通道 → 每通道各发一次、各占一行（唯一键含 channel）', async () => {
    const tg = stubSender();
    const fs = stubSender();
    const alert = createOpsAlertSink({
      senders: { [CHANNEL.telegram]: tg, [CHANNEL.feishu]: fs },
    });

    await alert('源级健康告警', { dedupKey: key });
    await alert('源级健康告警', { dedupKey: key }); // 第二次：两通道都该跳过

    expect(tg.calls).toHaveLength(1);
    expect(fs.calls).toHaveLength(1);

    const rows = await rowsFor(key);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(['feishu', 'telegram']);
  });

  it('未配置任何通道 → 回落 consoleAlertSink，且【不写】push_records', async () => {
    const alert = createOpsAlertSink({ senders: {} });
    expect(alert).toBe(consoleAlertSink);

    await alert('无通道时的告警', { dedupKey: key });

    // 关键：不写库。否则「今天没通道」会被限频键算成「今天已告过」——真接上通道那天反而不响。
    expect(await rowsFor(key)).toHaveLength(0);
  });

  it('push_date 用 PUSH_TIMEZONE 口径（不是 UTC 日）', async () => {
    // UTC 日界 = 08:00 CST，而日报链恰在 08:03 CST 跑。两条链若各算各的日期，
    // 唯一键就挡不住跨午夜那一轮 ⇒ 持续故障期天天双响。取一个两种口径不同日的时刻验证。
    const at = new Date('2026-07-14T00:30:00Z'); // UTC 07-14 / Asia/Shanghai 07-14 08:30
    const sender = stubSender();
    const alert = createOpsAlertSink({
      senders: { [CHANNEL.telegram]: sender },
      now: () => at,
    });

    await alert('时区口径', { dedupKey: key });

    const rows = await db
      .select({ pushDate: pushRecords.pushDate })
      .from(pushRecords)
      .where(eq(pushRecords.targetId, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pushDate).toBe(getPushDate(at));
  });
});
