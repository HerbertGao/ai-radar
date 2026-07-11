/**
 * RunContext seam 单测（任务 1.3，spec Req2/Req5，design D1/D3/D8）。
 *
 * 覆盖：emit 落结构化日志记录（{ event: kind, ... }）；propose 单测层验证
 * （桩 handler 直执行、发 action.executed、resolve，不 park/不审批）；
 * 断言 run-context.ts 不 import 任何 @hangar/* 脊柱包。
 * 纯逻辑无 I/O，恒运行（不涉网络/LLM，VITEST 护栏 N/A）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { makeLocalCtx, type Logger, type RunContext } from '../run-context.js';

/** 结构化 logger 桩：4 个方法均为 spy，断言记录形状用。 */
function spyLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('makeLocalCtx.emit（结构化日志）', () => {
  it('emit(kind, payload) 落一条 { event: kind, ...payload } 结构化记录', () => {
    const logger = spyLogger();
    const ctx = makeLocalCtx({ logger });

    ctx.emit('stage.collect', { collected: 3 });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({ event: 'stage.collect', collected: 3 }, 'stage.collect');
  });

  it('emit 无 payload 时记录仅含 event', () => {
    const logger = spyLogger();
    const ctx = makeLocalCtx({ logger });

    ctx.emit('run.failed');

    expect(logger.info).toHaveBeenCalledWith({ event: 'run.failed' }, 'run.failed');
  });
});

describe('RunContext 形状与 trigger', () => {
  it('trigger/config/input 透传，缺省 config={}、trigger 未定义时不置 undefined', () => {
    const withTrigger = makeLocalCtx({ trigger: 'digest', config: { dryRun: true }, input: 42 });
    expect(withTrigger.trigger).toBe('digest');
    expect(withTrigger.config).toEqual({ dryRun: true });
    expect(withTrigger.input).toBe(42);

    const bare = makeLocalCtx();
    expect(bare.config).toEqual({});
    // exactOptionalPropertyTypes：未传 trigger 时该属性缺席（而非显式 undefined）。
    expect('trigger' in bare).toBe(false);
  });
});

describe('makeLocalCtx.propose（前向兼容 shim）', () => {
  it('桩 handler 直执行、发一条 action.executed、结果 resolve（不 park/不审批）', async () => {
    const logger = spyLogger();
    const handler = vi.fn(async (args: object) => ({ ok: true, echoed: args }));
    const ctx: RunContext = makeLocalCtx({ logger, handlers: { 'push.send': handler } });

    const result = await ctx.propose({ tool: 'push.send', args: { channel: 'feishu' } });

    // handler 直执行（收到 args 与 ctx 自身）。
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ channel: 'feishu' }, ctx);
    // 结果 resolve（非 pending/park）。
    expect(result).toEqual({ ok: true, echoed: { channel: 'feishu' } });
    // 发一条 action.executed。
    expect(logger.info).toHaveBeenCalledWith({ event: 'action.executed', tool: 'push.send' }, 'action.executed');
  });

  it('handler 在 emit action.executed 之前执行（顺序：exec → emit）', async () => {
    const order: string[] = [];
    const logger: Logger = {
      info: vi.fn((obj: object) => {
        if ((obj as { event?: string }).event === 'action.executed') order.push('emit');
      }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const handler = vi.fn(async () => {
      order.push('exec');
    });
    const ctx = makeLocalCtx({ logger, handlers: { t: handler } });

    await ctx.propose({ tool: 't', args: {} });

    expect(order).toEqual(['exec', 'emit']);
  });

  it('未注册 tool 抛清晰错误（misconfig 炸响，不静默）', async () => {
    const ctx = makeLocalCtx({ logger: spyLogger() });
    await expect(ctx.propose({ tool: 'nope', args: {} })).rejects.toThrow(/nope/);
  });
});

describe('本地镜像不引脊柱依赖（spec Req2 scenario）', () => {
  it('run-context.ts 源码不出现任何 @hangar/* import', () => {
    const src = readFileSync(new URL('../run-context.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('@hangar');
  });
});
