/**
 * 补全测试桩共享件（unify-judge-stage 任务 6.10）：补全折进判分入口后，两条判分链（日报 / 告警）
 * 的集成测试都需注入「不触网」补全桩，避免未注入桩的用例经默认 dns.lookup / global fetch 真实出网。
 * 统一从本文件导出，杜绝各测试文件各 fork 一份漂移。
 */
import type { EnrichContentOptions } from '../content-enrichment.js';

/**
 * 不触网的默认补全桩：resolve 返回公网占位 IP（不真解析 DNS）、fetchImpl 直接抛错（视为抓取失败
 * -> content 保持空 -> 判分/摘要退化仅标题，行为与补全前一致）。关心补全结果的用例自行覆盖 fetchImpl/resolve。
 */
export const NO_NETWORK_ENRICH: EnrichContentOptions = {
  resolve: async () => ['93.184.216.34'],
  fetchImpl: async () => {
    throw new Error('enrich fetch disabled in test');
  },
  logError: () => {},
};
