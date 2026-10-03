/**
 * 验证：单一足迹比例 maxBlockFootprintRatio **无法**表达「留出一条 y 向空带」
 *
 * 960 箱的 WP20 整块是 30 列 × 3 排 × 7 层 = 11400×1440×2660，
 * 柜内 y 向 2340 能放 4 排（4×480 = 1920），**故意只用 3 排、空出第 4 排**给 WP30。
 *
 * 但 capFootprint 是**一个标量同时管两轴**：
 *   nX = floor(fp × 11900/380) = floor(fp × 31.32)  需要 ≥ 30 → fp ≥ 0.958
 *   nY = floor(fp ×  2340/380) = floor(fp ×  6.16)  需要 ≤  3 → fp <  0.650
 * 0.958 > 0.650 → **两轴要求相反，不存在任何单一 fp 能同时满足**。
 *
 * 本脚本实跑一遍扫描，确认 S1 在任何 fp 下都拿不到 960。
 * 用法：node scripts/footprint-tradeoff.mjs
 */
import { runGreedy } from '../dist/src/algorithm/index.js';

const HQ = { id: 'hq', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
const box = (id, l, w, h, qty) => ({
  name: id, id, length: l, width: w, height: h, quantity: qty, weight: 20,
  allowDirections: [true, true, false, false, false, false],
  deformFactor: 1, stackClass: 8, supportClasses: [8, 8, 8, 8, 8, 8],
  supportPct: [1, 1, 1], pcsCount: 1,
});
const boxes = [box('WP20', 480, 380, 380, 630), box('WP30', 515, 380, 425, 330)];
const qtyDesc = (x, y) => y.box.quantity - x.box.quantity || 1;
const nOf = (r) => r.placements.reduce((a, p) => a + p.count, 0);

console.log('capFootprint(n, unit, span, fp) = max(1, min(n, floor(fp*span/unit)))');
console.log('要 30 列 → fp ≥ 30/31.32 = 0.958；要 ≤3 排 → fp < 4/6.16 = 0.650\n');
console.log('  fp   | nX(可放列) nY(可放排) | S0    S1    S2    S3');
for (const fp of [0.3, 0.4, 0.5, 0.6, 0.649, 0.65, 0.7, 0.75, 0.8, 0.9, 0.95, 0.958, 0.98, 1.0]) {
  const nX = Math.max(1, Math.min(31, Math.floor((fp * 11900) / 380)));
  const nY = Math.max(1, Math.min(4, Math.floor((fp * 2340) / 480)));
  const cells = [0, 1, 2, 3].map((s) => nOf(runGreedy({ boxes, container: HQ, strategy: s }, qtyDesc, 0, fp, false, 0.9)));
  console.log(
    `  ${fp.toFixed(3)} |     ${String(nX).padStart(2)}       ${String(nY).padStart(2)}    |` +
      cells.map((c) => String(c).padStart(5)).join(' ') +
      (cells.some((c) => c >= 960) ? '  ← 有策略到 960' : ''),
  );
}
console.log('\n（fp=0 表示完全不限制，等价于上表 fp=1.0 的上界）');