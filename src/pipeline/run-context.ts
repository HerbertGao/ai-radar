/**
 * RunContext seam（Phase A0，纯解耦）。
 *
 * driver 无关的流水线执行契约的**本地镜像**：形状对齐目标脊柱（hangar）的 RunContext
 * （input/trigger/config/logger/emit/propose），但**不 import 任何脊柱包**——闸后（Phase M）
 * 把本地类型换成脊柱的 RunContext 即可机械替换（design D1）。
 *
 * emit → 结构化日志记录（{ event: kind, ...payload }）；run_events 落库可选，A0 默认不建表（design D3）。
 * propose → A0 前向兼容 shim：本地直执行 handler、emit action.executed、resolve（无审批/park，design D8）；
 * A0 无 lane 调用方，仅单测层验证。
 */

/**
 * 最小的、pino 兼容的结构化 logger 形状（真实 pino.Logger 可直接赋给它）。
 *
 * ponytail: 本仓未装 pino（且 proposal 明列「无新增运行时依赖」），故不引 pino，
 * 只保留其 (obj, msg) 结构化调用形状 + 默认走 console/stderr。
 * upgrade path: Phase M 换脊柱 logger 或按需 `pino({ level })`，本接口无需变。
 */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

/** driver 无关的流水线执行契约（本地镜像 hangar 形状）。 */
export interface RunContext {
  input: unknown;
  trigger?: string;
  config: Record<string, unknown>;
  logger: Logger;
  emit(kind: string, payload?: object): void;
  propose(action: { tool: string; args: object }): Promise<unknown>;
}

/** action handler：A0 仅单测桩注入；lane 业务体不调 propose。 */
export type ActionHandler = (args: object, ctx: RunContext) => Promise<unknown>;

export interface MakeLocalCtxOptions {
  trigger?: string;
  config?: Record<string, unknown>;
  input?: unknown;
  logger?: Logger;
  handlers?: Record<string, ActionHandler>;
}

/**
 * 默认 logger：结构化 JSON 单行写 stderr（对齐本仓「日志走 console.error / stderr」约定）。
 * ponytail: 无 level 过滤——A0 观测终交脊柱 monitor，需要时再加 level 旋钮。
 */
function makeConsoleLogger(): Logger {
  const write =
    (level: string) =>
    (obj: object, msg?: string): void => {
      console.error(JSON.stringify({ level, ...(msg !== undefined ? { msg } : {}), ...obj }));
    };
  return {
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    debug: write('debug'),
  };
}

/**
 * 本地 driver 上的 RunContext 装配器。
 * - emit(kind, payload) → 落一条结构化日志记录 { ...payload, event: kind }（event 后置防覆盖）。
 * - propose({ tool, args }) → 查 handlers[tool] 直执行、emit action.executed、resolve 结果；
 *   无 handler 抛清晰错误（misconfig 时炸响，A0 仅单测桩会走到）。
 */
export function makeLocalCtx(opts: MakeLocalCtxOptions = {}): RunContext {
  const logger = opts.logger ?? makeConsoleLogger();
  const handlers = opts.handlers ?? {};

  const emit = (kind: string, payload?: object): void => {
    // payload 先展开、event 后置：确保 payload 里若混入 event 键也不会盖掉生命周期事件名。
    logger.info({ ...(payload ?? {}), event: kind }, kind);
  };

  const ctx: RunContext = {
    input: opts.input,
    ...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
    config: opts.config ?? {},
    logger,
    emit,
    async propose(action) {
      const handler = handlers[action.tool];
      if (!handler) {
        throw new Error(`makeLocalCtx.propose: 未注册 tool="${action.tool}" 的 handler`);
      }
      const result = await handler(action.args, ctx);
      emit('action.executed', { tool: action.tool });
      return result;
    },
  };

  return ctx;
}
