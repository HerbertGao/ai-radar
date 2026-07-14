/**
 * 运维告警 sink 的集成测试（platform-foundation「运维告警落真实通道并由 DB 唯一约束限频」）。
 *
 * 这些断言必须跑在**真实 PG** 上——限频的全部机制就是 `push_records` 的
 * `UNIQUE(target_type, target_id, channel, push_date)`。任何内存桩都会让它们假绿：
 * 桩里「同 dedupKey 只发一次」是桩自己的逻辑，证明不了 DB 唯一键真的在挡。
 *
 * **渲染契约（buildOpsAlertSink 那条用例）用真实 sender + 注入 transport**，不用 stub sender：
 * 两个通道的 sender 契约不同（telegram 要转义后的 MarkdownV2 文本、feishu 要 `{card}` 的 JSON 串），
 * 而 stub sender 对任何入参都照收——它证明不了「发得出去」，只证明「调用过」。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { pushRecords } from '../../db/schema.js';
import { getPushDate } from '../../push/push-date.js';
import { escapeMarkdownV2 } from '../../push/message.js';
import { CHANNEL } from '../../push/targets.js';
import { createFeishuSender, type FetchLike } from '../../push/feishu.js';
import { createTelegramSender, type BotApiLike } from '../../push/telegram.js';
import type { MessageSender } from '../../push/dispatcher.js';
import {
  buildOpsAlertSink,
  consoleAlertSink,
  createOpsAlertSink,
  hasAlertedToday,
  OPS_ALERT_TARGET_TYPE,
} from '../ops-alert-sink.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

/** 造一个记录调用、可选抛错的 sender 桩（仅用于状态机断言，渲染契约另用真实 sender）。 */
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
    .select({
      status: pushRecords.status,
      channel: pushRecords.channel,
      pushedAt: pushRecords.pushedAt,
      errorMessage: pushRecords.errorMessage,
    })
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

  it('同 dedupKey 同日重复告警 → sender 只被调一次（已有 success 行即跳过）', async () => {
    const sender = stubSender();
    const alert = createOpsAlertSink({ senders: { [CHANNEL.telegram]: sender } });

    await alert('sitemap 整源失败', { dedupKey: key });
    await alert('sitemap 整源失败', { dedupKey: key });
    await alert('sitemap 整源失败', { dedupKey: key });

    expect(sender.calls).toHaveLength(1);

    const rows = await rowsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
    expect(rows[0]!.pushedAt).not.toBeNull(); // 成功路径必写 pushed_at（与 dispatcher 终态同口径）。
    expect(await hasAlertedToday(key)).toBe(true);
  });

  it('BullMQ 重跑同一 daily job（两次独立装配）用同一 dedupKey → 仍只发一次（去重靠 DB，不靠进程状态）', async () => {
    // 当前唯一接入的是日报链；重复告警的真实来源是 BullMQ 对同一 daily job 的重试——
    // 重试是新一轮执行、sink 是新装配的实例，进程内 Map 挡不住（每次装配都是新的），DB 唯一键能。
    const senderA = stubSender();
    const senderB = stubSender();
    const firstRun = createOpsAlertSink({ senders: { [CHANNEL.telegram]: senderA } });
    const retryRun = createOpsAlertSink({ senders: { [CHANNEL.telegram]: senderB } });

    await firstRun('系统级故障：采集返回 0 条', { dedupKey: key });
    await retryRun('系统级故障：采集返回 0 条', { dedupKey: key }); // BullMQ 重试同一 job

    expect(senderA.calls).toHaveLength(1);
    expect(senderB.calls).toHaveLength(0); // 重试那轮命中已有 success 行 → 跳过。
    expect(await rowsFor(key)).toHaveLength(1);
  });

  it('崩溃遗留的 pending 行【不得】挡死当天重试：重新认领 → 真的发出去', async () => {
    // 进程 A：INSERT pending 后崩溃 —— 消息从未发出。若认领用 ON CONFLICT DO NOTHING，
    // 进程 B 会被这条 pending 挡掉（0 行 → 跳过）⇒ 今天一条都不告警，且 hasAlertedToday() 仍报 false。
    await db.insert(pushRecords).values({
      targetType: OPS_ALERT_TARGET_TYPE,
      targetId: key,
      channel: CHANNEL.telegram,
      pushDate: getPushDate(new Date()),
      status: 'pending',
    });
    expect(await hasAlertedToday(key)).toBe(false);

    const sender = stubSender();
    const alert = createOpsAlertSink({ senders: { [CHANNEL.telegram]: sender } });
    await alert('熔断中止', { dedupKey: key });

    expect(sender.calls).toHaveLength(1); // 残 pending 被重新认领 → 重试发送。
    const rows = await rowsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
    expect(await hasAlertedToday(key)).toBe(true);
  });

  it('发送失败 → 置 failed（不删行）；同日再告 → 重新认领并重发', async () => {
    const failing = stubSender({ throws: true });
    const alertFail = createOpsAlertSink({ senders: { [CHANNEL.telegram]: failing } });

    await alertFail('熔断中止', { dedupKey: key });

    expect(failing.calls).toHaveLength(1);
    // 推送不变量：成功置 success、失败置 failed。DELETE 会让「告警发送失败」这一事实在 DB 里查不到。
    const failedRows = await rowsFor(key);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.status).toBe('failed');
    expect(failedRows[0]!.errorMessage).toContain('sender boom');
    expect(await hasAlertedToday(key)).toBe(false); // 没发出去 = 今天还没告过。

    // failed 行满足 `status <> 'success'` → 下次可重新认领 → 真重发（而非被残行挡住）。
    const ok = stubSender();
    const alertOk = createOpsAlertSink({ senders: { [CHANNEL.telegram]: ok } });
    await alertOk('熔断中止', { dedupKey: key });

    expect(ok.calls).toHaveLength(1);
    const rows = await rowsFor(key);
    expect(rows).toHaveLength(1); // 仍是同一行（被复用），不是新增一行。
    expect(rows[0]!.status).toBe('success');
    expect(rows[0]!.errorMessage).toBeNull(); // 重新认领时清掉上次的 error_message。
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

  it('DB 认领失败（告警通路依赖的正是它要告警的子系统）→ 仍发送，并标注「限频不可用」', async () => {
    // product-digest 那条「待中文化产品查询失败（如 DB 断连）」的告警恰恰在 DB 断连时触发：
    // 若认领失败即放弃发送，最需要告警的那类故障上通道全哑。宁可重复一条，不可哑火。
    const sender = stubSender();
    const brokenDb = {
      insert: () => {
        throw new Error('db down');
      },
    } as unknown as typeof db;
    const alert = createOpsAlertSink({
      senders: { [CHANNEL.telegram]: sender },
      dbh: brokenDb,
    });

    await alert('产品中文化待处理查询失败（系统故障可观测）', { dedupKey: key });

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toContain(escapeMarkdownV2('限频不可用（DB 异常）'));
  });

  it('push_date 用 PUSH_TIMEZONE 口径（不是 UTC 日）', async () => {
    // UTC 日界 = 08:00 CST，而日报链恰在 08:03 CST 跑。取一个**两种口径分属不同日**的时刻：
    // 2026-07-13T16:30:00Z = UTC 07-13 / Asia/Shanghai 07-14 00:30。断言字面量（不是 getPushDate(at)
    // ——那是拿被测代码调的同一个函数当预期值，同义反复、零分辨力）。
    const at = new Date('2026-07-13T16:30:00Z');
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
    expect(rows[0]!.pushDate).toBe('2026-07-14'); // UTC 日会是 '2026-07-13'。
  });
});

d('运维告警 sink：按通道渲染（真实 sender + 注入 transport，走完整条接线）', () => {
  let key: string;

  // Telegram API 400 拒收的真实文案：含 MarkdownV2 保留字 `.` `-` `(` `)` `!` 等。
  const MESSAGE = 'Value Judge 阶段降级率 42.9% 超阈值（30%），中止本次流水线。';

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => vi.restoreAllMocks());

  beforeEach(async () => {
    key = `test-render:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await db.delete(pushRecords).where(eq(pushRecords.targetId, key));
  });

  it('buildOpsAlertSink(senders) → telegram 收到转义后的 MarkdownV2、feishu 收到 {card} JSON', async () => {
    const tgSent: string[] = [];
    const fsSent: string[] = [];

    // 真实 TelegramSender + 注入 api：证明的是「sink 交给 sender 的 payload 本身合法」。
    const api: BotApiLike = {
      async sendMessage(_chatId, text) {
        tgSent.push(text);
      },
    };
    // 真实 FeishuSender + 注入 fetch：它 send() 的第一件事是 JSON.parse(text)——裸文本当场抛，
    // sink 会把它 catch 成一次「发送失败」⇒ fsSent 为空 ⇒ 下面的断言红。这才是契约被真正证伪。
    const fetchImpl: FetchLike = async (_url, init) => {
      fsSent.push(init.body);
      return { ok: true, status: 200, text: async () => '{"code":0}' };
    };

    const alert = buildOpsAlertSink({
      [CHANNEL.telegram]: createTelegramSender({ api, chatId: 'test-chat' }),
      [CHANNEL.feishu]: createFeishuSender({
        webhookUrl: 'https://open.feishu.invalid/hook',
        signSecret: 'test-secret',
        fetchImpl,
      }),
    });

    await alert(MESSAGE, {
      dedupKey: key,
      kind: 'degrade-abort',
      failed: 3,
      // 模拟 drizzle 的 DrizzleQueryError：message 是「Failed query: <SQL>」，真正的故障原因
      // （connect ECONNREFUSED …）住在 cause 里。只取 message 的话，「DB 断连」这条告警的正文
      // 会是一段 SQL 前缀、一个字都不提数据库连不上。
      error: Object.assign(new Error('Failed query: select 1'), {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      }),
    });

    // ── Telegram：保留字必须全部被转义，否则 Telegram API 400 拒收整条告警。
    expect(tgSent).toHaveLength(1);
    const tgText = tgSent[0]!;
    expect(tgText).toContain(escapeMarkdownV2(MESSAGE));
    expect(tgText).not.toMatch(/(?<!\\)[_*[\]()~`>#+\-=|{}.!]/); // 无「未被反斜杠前导」的保留字。

    // detail 的上下文必须进消息体（否则运维收到的是一句没有上下文的裸话）。
    expect(tgText).toContain(escapeMarkdownV2('kind=degrade-abort'));
    expect(tgText).toContain(escapeMarkdownV2('failed=3'));
    // Error 必须沿 cause 链展开——真正的故障原因在 cause 里，不展开就等于没告警。
    expect(tgText).toContain(escapeMarkdownV2('connect ECONNREFUSED 127.0.0.1:5432'));
    expect(tgText).toContain(escapeMarkdownV2('cause:'));
    expect(tgText).toContain(escapeMarkdownV2(`dedupKey=${key}`));

    // ── 飞书：sender 要的是 JSON.stringify({ card })；裸文本会在 JSON.parse 处当场抛。
    expect(fsSent).toHaveLength(1);
    const body = JSON.parse(fsSent[0]!) as {
      msg_type: string;
      card: { header: { title: { content: string } }; elements: unknown[] };
    };
    expect(body.msg_type).toBe('interactive');
    expect(body.card).toBeDefined();
    expect(body.card.header.title.content).toContain('运维告警');
    expect(JSON.stringify(body.card.elements)).toContain('lark_md');
    expect(JSON.stringify(body.card.elements)).toContain('kind=degrade-abort');

    // 两通道都真的发出去了 → 各一行 success。
    const rows = await rowsFor(key);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'success')).toBe(true);
  });
});
