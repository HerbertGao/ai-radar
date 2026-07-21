/**
 * 出口闸守卫（add-run-context-seam 组 D，任务 4.1/4.2，design D7）。
 *
 * 断言两个 **lane 业务模块**（run-daily-workflow.ts / alert-scan.ts）在
 * **直接 import 层面**无 BullMQ driver 耦合：
 *  - 无 `import ... from 'bullmq'`（含从 bullmq 导入的 `Job`）；
 *  - 无经 `./queue.js` 的连接符号 import（buildConnection 等）；
 *  - 无 `job.data` 用法；
 *  - 无原始 `process.env` 生产流程分支（`env` 单例经 Zod 校验，明确允许——见下 4.1）。
 *
 * driver 文件（queue/alert-queue/worker.ts）**排除**在断言外——它们合法 import bullmq。
 *
 * 4.1 确认（读码核实，非改码）：两个 lane 业务模块均经 `import { env } from '../config/env.js'`
 *   **就地**读 env 单例（run-daily-workflow.ts:31、alert-scan.ts:46），
 *   未把 env.* 搬进 ctx.config、未改评估时机（lazy-at-stage 不变，design D7 推论）。故本守卫允许 env 单例、
 *   只闸 process.env 原始读——三模块原始 process.env 命中数 = 0。
 *
 * ponytail: 直接 import 守卫——transitive 依赖图不在 A0 范围（design D7），不引 madge 等工具。
 * 匹配 `from 'x'` import 上下文（非裸标识符），避免误伤 `WeeklyReportJobData` 之类含 "Job" 的类型名。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** src/pipeline/ 目录（本文件在 __tests__/ 下，上溯一层）。 */
const PIPELINE_DIR = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(PIPELINE_DIR + file, 'utf8');

/** 两个 lane 业务模块（driver 文件 queue/alert-queue/worker.ts 排除在外）。 */
const LANE_BUSINESS_MODULES = [
  'run-daily-workflow.ts',
  'alert-scan.ts',
] as const;

// import 上下文匹配（`from 'x'` 仅出现在 import 语句里，故不误伤裸标识符/类型名）。
const BULLMQ_IMPORT = /from\s+['"]bullmq['"]/; // import ... from 'bullmq'（含 Job）
const QUEUE_CONN_IMPORT = /from\s+['"]\.\/queue(\.js)?['"]/; // 经 ./queue.js 的连接符号
const JOB_DATA = /\bjob\.data\b/; // BullMQ Job.data 用法
const RAW_PROCESS_ENV = /\bprocess\.env\b/; // 原始 process.env（env 单例允许，见 4.1）

describe('出口闸：lane 业务模块直接 import 无 BullMQ driver 耦合（4.2）', () => {
  it.each(LANE_BUSINESS_MODULES)('%s 无 bullmq / ./queue.js / job.data / 原始 process.env', (file) => {
    const src = read(file);
    expect(BULLMQ_IMPORT.test(src), `${file} 直接 import 了 bullmq`).toBe(false);
    expect(QUEUE_CONN_IMPORT.test(src), `${file} 直接 import 了 ./queue.js 连接符号`).toBe(false);
    expect(JOB_DATA.test(src), `${file} 含 job.data 用法`).toBe(false);
    expect(RAW_PROCESS_ENV.test(src), `${file} 含原始 process.env（应走 env 单例）`).toBe(false);
  });

  it('4.1：两个 lane 业务模块就地读 env 单例（import { env } from ../config/env.js）', () => {
    // env 单例读**不搬位置、不改评估时机**（design D7）：断言仍就地 import env（非搬进 ctx.config）。
    for (const file of LANE_BUSINESS_MODULES) {
      expect(/import\s+\{[^}]*\benv\b[^}]*\}\s+from\s+['"]\.\.\/config\/env\.js['"]/.test(read(file)), file).toBe(true);
    }
  });

  // 正例对照：守卫的 regex 必须真能在 known-positive driver 文件命中（防 regex 恒不匹配的假绿）。
  it('正例对照：driver 文件 worker.ts 命中 bullmq + ./queue.js（证明 regex 有效）', () => {
    const driver = read('worker.ts');
    expect(BULLMQ_IMPORT.test(driver)).toBe(true);
    expect(QUEUE_CONN_IMPORT.test(driver)).toBe(true);
  });
});
