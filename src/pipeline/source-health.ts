/**
 * 源级健康告警的共享判定叶子（p0-alert-lane C1.3 / design D11②）。
 *
 * 日报链（run-daily-workflow.ts 的 perSource 消费循环）与高频告警链（alert-scan.ts）对
 * `perSource.ok === false` 的结构性失败各发一条 `dedupKey='source-health:<source>'` 告警，
 * 两条链 MUST 共用**同一个判定**——「同一个判定」含良性限流豁免，故该谓词提为本共享函数、
 * 两链同 import（防两链判定**静默漂移**的结构要求；高频链 MUST NOT 反向 import 日报模块，
 * 故落在此叶子而非 run-daily-workflow）。
 */
import { ArxivRateLimitError } from '../collectors/arxiv.js';
import { ProductHuntRateLimitError } from '../collectors/product-hunt.js';

/**
 * 该源失败是否为「良性限流退避」——429 退避达上限、本轮放弃。arxiv/Product Hunt 把它设计为隔离、
 * 不告警的正常背压事件（周期性发生）。源级健康告警据此豁免，只对【异常】失败告警（sitemap 静默死亡
 * 那类）；真正的源死亡（连续多日零新增）由 source-staleness 兜底。cause 链也查（withRetry 可能包一层）。
 *
 * 按**错误类型**判定、与源无关：今日高频子集不含 arXiv/PH（且 DB 限频已把后果封顶为每天一响），
 * 共享不是止血、是防漂移。
 */
export function isBenignRateLimit(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e instanceof Error && depth < 5; depth += 1) {
    if (e instanceof ArxivRateLimitError || e instanceof ProductHuntRateLimitError) return true;
    e = e.cause;
  }
  return false;
}
