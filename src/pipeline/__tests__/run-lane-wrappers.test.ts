/**
 * lane 薄 run(ctx) 包装契约单测（add-run-context-seam 组 B，任务 2.1/2.2/2.3/2.4，
 * spec Req「driver 无关核心 + 薄 run(ctx) 包装」/「按 lane 实有阶段的 run-event 发射与结局」，design D2/D4）。
 *
 * 覆盖包装的两条硬契约（不触 DB/Redis/LLM/网络——注入桩核心，故纯逻辑、VITEST 无真发风险）：
 *  - 委托核心并把 ctx.emit / ctx.input.now 映进 options 运维子集；
 *  - 核心抛错 → 包装 emit 一条 run.failed 终态后 **RE-THROW 原错误**（run(ctx) 仍 reject → BullMQ job
 *    失败可重试）。daily 专门断言 WorkflowAbortError 路径（2.2：既 emit run.failed 又 rejects.toThrow）。
 *
 * 注：run(ctx) 的第二参 `core` 是包装自带的测试缝（默认委托生产核心，worker/生产调 run(ctx) 单参）；
 * DI/测试 seam 仍留 options 核心、不进 ctx（design D2），故此处以桩核心而非 ctx 注入抛错。
 */
import { describe, expect, it, vi } from 'vitest';

// 各 lane 模块 import 时会经 config/env 单例校验；补齐最小必需 env（对齐既有集成测试）。
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';

import { makeLocalCtx, type Logger } from '../run-context.js';
import {
  run as runDaily,
  WorkflowAbortError,
  type RunDailyWorkflowOptions,
  type RunDailyWorkflowResult,
} from '../run-daily-workflow.js';
import {
  run as runAlert,
  type RunAlertScanOptions,
  type RunAlertScanResult,
} from '../alert-scan.js';
import { consoleAlertSink } from '../ops-alert-sink.js';

/** 收集 emit 落的 kind 序列（makeLocalCtx.emit → logger.info({ event: kind, ... })）。 */
function spyCtx(input?: unknown) {
  const info = vi.fn();
  const logger: Logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = makeLocalCtx({
    trigger: 'digest',
    logger,
    ...(input !== undefined ? { input } : {}),
  });
  const kinds = (): string[] =>
    info.mock.calls.map((c) => (c[0] as { event?: string }).event ?? '');
  return { ctx, kinds };
}

const okDailyResult: RunDailyWorkflowResult = {
  outcome: 'pushed',
  pushDate: '2020-02-02',
  collectedCount: 0,
  newsProcessableCount: 0,
  judge: { processed: 0, degraded: 0 },
  digest: { processed: 0, degraded: 0 },
  topNCount: 0,
  alerted: false,
};

describe('daily run(ctx)：WorkflowAbortError 路径（2.2）', () => {
  it('核心抛 WorkflowAbortError → 包装 emit run.failed 后 re-throw（run(ctx) reject，原实例不被吞/替换）', async () => {
    const { ctx, kinds } = spyCtx();
    const abort = new WorkflowAbortError('value-judge', 0.9);
    const throwingCore = async (): Promise<RunDailyWorkflowResult> => {
      throw abort;
    };

    const p = runDaily(ctx, throwingCore);
    // 既 rejects.toThrow(WorkflowAbortError)……
    await expect(p).rejects.toThrow(WorkflowAbortError);
    // ……且 re-throw 的是同一原始实例（非包裹/替换）。
    await expect(p).rejects.toBe(abort);
    // ……又 emit 一条 run.failed 终态。
    expect(kinds()).toContain('run.failed');
  });
});

describe('daily run(ctx)：正常委托 + 映射 emit/now', () => {
  it('核心正常 resolve → 不 emit run.failed，emit 映进 options.emit', async () => {
    const { ctx, kinds } = spyCtx();
    let captured: RunDailyWorkflowOptions | undefined;
    const core = async (
      opts: RunDailyWorkflowOptions = {},
    ): Promise<RunDailyWorkflowResult> => {
      captured = opts;
      return okDailyResult;
    };

    const r = await runDaily(ctx, core);
    expect(r).toBe(okDailyResult);
    expect(typeof captured?.emit).toBe('function'); // ctx.emit 映进 options.emit。
    expect(kinds()).not.toContain('run.failed');
  });

  it('ctx.input.now 透传给 options.now（input 映射）', async () => {
    const now = new Date('2020-02-02T00:00:00Z');
    const { ctx } = spyCtx({ now });
    let capturedNow: Date | undefined;
    const core = async (
      opts: RunDailyWorkflowOptions = {},
    ): Promise<RunDailyWorkflowResult> => {
      capturedNow = opts.now;
      return okDailyResult;
    };
    await runDaily(ctx, core);
    expect(capturedNow).toBe(now);
  });
});

const okAlertResult: RunAlertScanResult = {
  pushDate: '2020-02-02',
  collectedCount: 0,
  judged: 0,
  alertCandidateCount: 0,
  dispatched: [],
};

describe('alert run(ctx)：ctx→options 映射（emit/now，补齐 daily 之外的 alert lane）', () => {
  // ponytail: 只跑 run(ctx, spyCore)（桩核心）验 ctx→options 映射半；生产路径 run(ctx) 单参→真实默认核心
  // 不在此端到端跑——test-no-prod-sends：测试环境加载 .env，真实 senders 会真发飞书/TG。默认核心绑定由类型
  // 系统保证（core: typeof runAlertScan），本用例覆盖映射半，两半合起来即全路径。
  it('alert run(ctx) 映射：emit=ctx.emit、now=ctx.input.now', async () => {
    const now = new Date('2020-02-02T00:00:00Z');
    const ctx = makeLocalCtx({ trigger: 'alert-scan', input: { now } });
    let captured: RunAlertScanOptions | undefined;
    const r = await runAlert(ctx, async (opts: RunAlertScanOptions = {}) => {
      captured = opts;
      return okAlertResult;
    });
    expect(r).toBe(okAlertResult);
    expect(captured?.emit).toBe(ctx.emit); // emit: ctx.emit
    expect(captured?.now).toBe(now); // now: ctx.input.now
  });

  it('alert run(ctx) 生产装配：注入非 consoleAlertSink 的运维告警 sink（buildOpsAlertSink 产物）（C2.7②）', async () => {
    // 唯一能证伪「alert 字段加了、线没接」的断言（p0-alert-lane C1.3/C2.7，与日报链 run(ctx) 注入同型）：
    // 源级健康告警的单测自己注入 sink ⇒ 无论生产接没接线那些用例都恒绿；只有本用例证明核心从 run(ctx)
    // 拿到的是真装配产物、不是 stderr 回落。buildOpsAlertSink 惰性构造真实 sender（首次真告警才装配）
    // ⇒ 本断言不触发任何真实发送器构造（无 VITEST 守卫冲突、无真发风险）。
    const ctx = makeLocalCtx({ trigger: 'alert-scan' });
    let captured: RunAlertScanOptions | undefined;
    await runAlert(ctx, async (opts: RunAlertScanOptions = {}) => {
      captured = opts;
      return okAlertResult;
    });
    expect(typeof captured?.alert).toBe('function');
    expect(captured?.alert).not.toBe(consoleAlertSink);
  });
});

describe('alert run(ctx)：抛错 → run.failed + re-throw（2.3/2.4）', () => {
  it('alert 核心抛错 → emit run.failed 后 re-throw 原错误', async () => {
    const { ctx, kinds } = spyCtx();
    const boom = new Error('alert boom');
    await expect(
      runAlert(ctx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(kinds()).toContain('run.failed');
  });
});
