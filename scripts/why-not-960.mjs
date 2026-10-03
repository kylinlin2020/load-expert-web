/**
 * 策略 0/1/2 为什么到不了 960：穷举全部多起点配置，各策略的最优成绩
 *
 * 要回答的问题：S3 能到 960（两种货物 100%），
 * 而 S0/S1/S2 只有 935/929/929 —— 是**块形状**的硬限制，还是**空间策略**没调好？
 * 方法：对每个策略穷举 CARGO_CONFIGS 的全部维度组合，看任何配置能否突破。
 *
 * 用法：node scripts/why-not-960.mjs
 */
import { load, runGreedy, CARGO_CONFIGS } from '../dist/src/algorithm/index.js';

const HQ = { id: 'hq', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
const box = (id, l, w, h, qty) => ({
  name: id, id, length: l, width: w, height: h, quantity: qty, weight: 20,
  allowDirections: [true, true, false, false, false, false],
  deformFactor: 1, stackClass: 8, supportClasses: [8, 8, 8, 8, 8, 8],
  supportPct: [1, 1, 1], pcsCount: 1,
});

const boxes = [box('WP20', 480, 380, 380, 630), box('WP30', 515, 380, 425, 330)];
const per = (r) => {
  const m = new Map();
  for (const p of r.placements) m.set(p.boxId, (m.get(p.boxId) ?? 0) + p.count);
  return `${m.get('WP20') ?? 0}+${m.get('WP30') ?? 0}`;
};

console.log('需求 630+330 = 960（= 几何上限，两种货物各 100%）\n');
console.log('策略 | 10 腿配置内最好 | 达到 960 的腿数 | load() 实际');
for (let s = 0; s <= 5; s++) {
  let best = 0;
  let hits = 0;
  for (const c of CARGO_CONFIGS) {
    const r = runGreedy({ boxes, container: HQ, strategy: s }, c.sortKey, c.blockRatio, c.footprintRatio, c.preferCleanResidual, c.residualWeight);
    const n = r.placements.reduce((a, p) => a + p.count, 0);
    if (n >= 960) hits++;
    if (n > best) best = n;
  }
  const agg = load({ boxes, container: HQ, strategy: s });
  const an = agg.placements.reduce((a, p) => a + p.count, 0);
  console.log(`  S${s}  |     ${String(best).padStart(4)}     |        ${hits}        |  ${an} (${per(agg)})`);
}

console.log('\n--- 单独跑「无上限 + 残余前瞻」这一条腿（最宽松的配置）---');
const loose = CARGO_CONFIGS[9];
for (let s = 0; s <= 5; s++) {
  const r = runGreedy({ boxes, container: HQ, strategy: s }, loose.sortKey, loose.blockRatio, loose.footprintRatio, loose.preferCleanResidual, loose.residualWeight);
  const orients = [...new Set(r.placements.map((p) => p.orientation))].sort();
  console.log(`  S${s}  ${String(r.placements.reduce((a, p) => a + p.count, 0)).padStart(4)} 箱  ${per(r)}  姿态={${orients}}`);
}

console.log('\n--- 策略1 的首个块形状（看它是否"总是铺满 y"）---');
for (const s of [0, 1, 2, 3]) {
  const r = runGreedy({ boxes, container: HQ, strategy: s }, loose.sortKey, loose.blockRatio, loose.footprintRatio, loose.preferCleanResidual, loose.residualWeight);
  const p = r.placements[0];
  console.log(`  S${s} 首块 ${p.boxId} dir${p.orientation} ${p.dims.join('x')} @ (${p.x},${p.y},${p.z}) ${p.count} 箱`);
}
console.log(`\n  柜内尺寸 ${HQ.innerLength}x${HQ.innerWidth}x${HQ.innerHeight}`);
console.log('  WP20 dir1 = 380x480x380 → x 可放 31 列、y 可放 4 排');
console.log('  30x3x7 整块 = 11400x1440x2660，**只占 y 的 3 排（1440），故意空出第 4 排给 WP30**');