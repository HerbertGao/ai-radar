/**
 * Model Radar（P5 / 5d，add-model-radar-snapshot-cross-process-invalidation）服务进程后台刷新接线（design D2/D4）。
 *
 * 建 subscriber（收跨进程失效信号 → invalidate 进程内缓存）+ 周期 rebuild 定时器
 * （用**非 publish** 的 `rebuildModelRadarSnapshot`，避免每 tick 自 publish→自订阅 invalidate→冷重建 thrash，
 * 见 design D2 承重不变量 / F7）。返回 `stop()`：`clearInterval` + best-effort `quit()`。
 *
 * 抽成独立 seam（不耦合 HTTP server boot）以便 tasks 4.5/4.6 用 fake timer + spy 单测。
 */
import { env } from '../../config/env.js';
import { createSnapshotInvalidationSubscriber } from './invalidation.js';
import { invalidateModelRadarSnapshot, rebuildModelRadarSnapshot } from './cache.js';

/** 后台刷新句柄；`stop()` 清周期 rebuild 定时器 + best-effort 关 subscriber（优雅关闭时调，design D4）。 */
export interface SnapshotBackgroundHandle {
  stop(): Promise<void>;
}

/**
 * 启动服务进程后台刷新：建 subscriber（收跨进程失效信号 → invalidate 进程内缓存）+ 周期 rebuild 定时器
 * （调**非 publish** 的 `rebuildModelRadarSnapshot`，避免每 tick 自 publish→自订阅 thrash，见 design D2）。
 * 返回 `stop()`：`clearInterval` + best-effort `quit()`，供 `src/index.ts` 优雅关闭调用。
 *
 * @param intervalMs 周期 rebuild 间隔（毫秒），默认 `env.MR_SNAPSHOT_REBUILD_INTERVAL_MS`。
 * @returns 后台刷新句柄（含 `stop()`）。
 */
export function startSnapshotBackgroundRefresh(
  intervalMs: number = env.MR_SNAPSHOT_REBUILD_INTERVAL_MS,
): SnapshotBackgroundHandle {
  const subscriber = createSnapshotInvalidationSubscriber(() => invalidateModelRadarSnapshot());
  const timer = setInterval(() => {
    // 周期 rebuild 用非 publish 的 cache fn（承重不变量，禁用会 publish 的 runSnapshotRebuild）；
    // 推进的 now 驱动 staleness 阈值穿越；fail-closed 保留旧快照、不崩。
    rebuildModelRadarSnapshot(undefined, new Date()).catch((err) => {
      console.error('[mr-snapshot] 周期 rebuild 失败（旧快照保留）：', err);
    });
  }, intervalMs);
  timer.unref(); // 不阻塞进程退出
  return {
    stop: async () => {
      clearInterval(timer);
      // best-effort：Redis 挂时 quit reject 不成 unhandledRejection；只读 subscriber 无未刷状态。
      await subscriber.quit().catch((err) => {
        console.error('[mr-snapshot] subscriber quit 失败（best-effort，已忽略）：', err);
      });
    },
  };
}
