/**
 * 正文超集检查：防跨变更的【静默回滚】。
 *
 * openspec-cn 的 MODIFIED 是**整条需求替换**，而归档守卫（specs-apply.js 的
 * findMissingCurrentScenarios）只比**场景名**、不比正文。⇒ 两个变更改同一条需求时，
 * 后归档者若没把前驱的正文抄全，前驱的 MUST 会被**静默回滚**——`validate --strict`
 * 与归档守卫**都是绿的**。本检查是那个缺口的唯一机械兜底。
 *
 * 用法：node scripts/spec-body-superset.mjs <change-a> <change-b> [...]   （按归档顺序传）
 *
 * 判据：对每个「被多个变更 MODIFY 的同名需求」，后继的正文必须包含前驱的每一行**实质行**。
 * 实质行 = 长度 > 30 的非空行（避开格式噪音与标题）。
 *
 * 命中不等于有 bug——后继可能是**有意改写**（重构该需求正是它的目的）。故本检查是
 * **候选生成器，不是裁决器**：每一处都必须人工裁决「这是有意翻转，还是漏抄」。
 */
import fs from 'node:fs';
import path from 'node:path';

const chain = process.argv.slice(2);
if (chain.length < 2) {
  console.error('用法: node scripts/spec-body-superset.mjs <change-a> <change-b> [...]（按归档顺序）');
  process.exit(2);
}

const RE_REQ = /^###\s*(?:Requirement|需求)[:：]\s*(.+?)\s*$/;
const norm = (s) => s.replace(/\s+/g, '');

/** 抽出一份 spec.md 里每条需求的实质正文行。 */
function requirementBodies(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(RE_REQ);
    if (m) {
      cur = m[1];
      out.set(cur, []);
      continue;
    }
    if (cur && /^##\s/.test(line)) cur = null; // 离开需求块
    if (cur && line.trim().length > 30) out.get(cur).push(line.trim());
  }
  return out;
}

const seen = new Map(); // "capability::需求名" -> [变更名, 实质行[]]
let rollbacks = 0;

for (const change of chain) {
  const specsDir = path.join('openspec/changes', change, 'specs');
  if (!fs.existsSync(specsDir)) continue;

  for (const capability of fs.readdirSync(specsDir)) {
    const specFile = path.join(specsDir, capability, 'spec.md');
    for (const [req, lines] of requirementBodies(specFile)) {
      const key = `${capability}::${req}`;
      const prior = seen.get(key);

      if (prior) {
        const [priorChange, priorLines] = prior;
        const have = new Set(lines.map(norm));
        const lost = priorLines.filter((l) => !have.has(norm(l)));

        if (lost.length > 0) {
          rollbacks += 1;
          console.log(`\n❌ ${change} :: ${key}`);
          console.log(`   基线 = ${priorChange}；下列 ${lost.length} 行实质正文在后继里【消失了】：`);
          for (const l of lost.slice(0, 5)) console.log(`     − ${l.slice(0, 110)}`);
          if (lost.length > 5) console.log(`     … 另 ${lost.length - 5} 行`);
        } else {
          console.log(`✅ ${change} :: ${key}（完整继承 ${priorChange} 的 ${priorLines.length} 行）`);
        }
      }

      seen.set(key, [change, lines]);
    }
  }
}

if (rollbacks === 0) {
  console.log('\n✅ 无跨变更正文回滚');
  process.exit(0);
}

console.log(
  `\n❌ ${rollbacks} 处正文会被静默回滚（validate --strict 与归档场景名守卫都抓不到）。` +
    `\n   逐处裁决：是【有意翻转】（在返回里逐条说明），还是【漏抄基线】（补回去）。`,
);
process.exit(1);
