/**
 * Model Radar（P5 / 5c，add-model-radar-compare-api）快照 rebuild job body（task 5.3/5.3b，design D8）。
 *
 * 交付**可直接调用的 rebuild job body** `runSnapshotRebuild`：注入 `now`（供 CI 断言陈旧/阈值穿越）、
 * 注入 `dbh`/`buildFn`，**never-throws**（内部 try/catch + 结构化结果），失败时旧快照保留（fail-closed
 * 由 cache 层 `rebuildModelRadarSnapshot` 的「先 build 再替换」保证）。
 *
 * 它既是「rebuild job 的纯函数体」，又被授权写编排边界**复用为提交后触发器**（design D8：价改耦合 rebuild
 * 经调用方触发、不需常驻 worker）——`recordPriceChange` / `upsertPlan` 委托改价路径在**最外层事务提交后**
 * `await runSnapshotRebuild({ dbh })`，覆盖全部 success outcome（recompute 必跑；ETag 是否变取决于服务表征
 * 是否真变，纯 noop-same-tuple 可不变）。seed/策展脚本末尾亦调本函数。
 *
 * **5c 范围边界（机制就绪、装配延后，不谎称运行中安全网）**：
 * - 本期交付 = job body + 注入 now + CI 测；价改/seed 触发经**调用方**（API/seed 进程）即时跑。
 * - **常驻 worker 装配（链7 四件套 `createMrSnapshotRebuildQueue`/`scheduleMrSnapshotRebuild`/
 *   `createMrSnapshotRebuildWorker` + `MR_SNAPSHOT_REBUILD_ENABLED` 开关 + 间隔 env，仿 scrape-queue 链）与
 *   跨进程失效（Redis pub/sub）显式延后 5d**。5c **无 live 消费者**（常驻安全网 blast radius=0），故本期
 *   不加未用的 worker/env（YAGNI）；5d 装配时 env 命名宜对齐既有 `MR_*_CRON`+`_CRON_TZ` 约定，或注明刻意用
 *   `every:ms`。保鲜回路（`setReviewFlag`/`markChecked`/staleness 排程）改 reviewStatus/staleness 的众多
 *   cron 驱动写，将由该后台周期 rebuild 安全网兜底——**周期/带外、非 on-read，请求路径绝不触发写**。
 */
import { db as defaultDb } from '../../db/index.js';
import {
  rebuildModelRadarSnapshot,
  type SnapshotBuildFn,
} from './cache.js';

type DbLike = typeof defaultDb;

/** rebuild job 结果（可观测；never-throws，失败以 `ok:false` + error 表达，旧快照已保留）。 */
export interface SnapshotRebuildResult {
  ok: boolean;
  /** 成功时 = 新内容哈希（公开 version/ETag）；失败时 null。 */
  version: string | null;
  /** 成功时 = 快照 plan 数；失败时 null。 */
  planCount: number | null;
  /** 失败原因（成功时省略）。 */
  error?: string;
}

export interface RunSnapshotRebuildOptions {
  /** db 句柄（默认全局 db；测试/seed 注入隔离实例）。 */
  dbh?: DbLike;
  /** 参考时刻（默认当前；CI 注入以驱动 staleness 阈值穿越）。 */
  now?: Date;
  /** 构建函数（默认真 builder；测试注入桩）。 */
  buildFn?: SnapshotBuildFn;
}

/**
 * rebuild job body —— 重建进程内快照缓存并刷新 version/ETag。**never-throws**。
 *
 * fail-closed：构建/校验失败时 cache 层不覆盖旧快照，本函数捕获后返回 `ok:false`、记日志，
 * **不把异常抛给调用方**（价改/seed 的成功路径不因 rebuild 失败而中断）。
 */
export async function runSnapshotRebuild(
  options: RunSnapshotRebuildOptions = {},
): Promise<SnapshotRebuildResult> {
  const dbh = options.dbh ?? defaultDb;
  const now = options.now ?? new Date();
  try {
    const { snapshot, version } = await rebuildModelRadarSnapshot(
      dbh,
      now,
      options.buildFn,
    );
    return { ok: true, version, planCount: snapshot.plans.length };
  } catch (err) {
    // fail-closed：旧快照已保留（cache 层「先 build 再替换」）；这里只记日志、返回失败结果，不上抛。
    const error = err instanceof Error ? err.message : String(err);
    console.error('[mr-snapshot] rebuild 失败（旧快照保留，不覆盖）：', error);
    return { ok: false, version: null, planCount: null, error };
  }
}
