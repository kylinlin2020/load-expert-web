/**
 * 逐配置诊断：穷举 CARGO_CONFIGS 各维度组合，打印每种货物的分项箱数与块序列
 *
 * 用途：`load()` 只返回择优后的聚合结果，看不出是哪一腿赢、哪一腿饿死货物、
 * 也没法看出"先手货物到底有没有一次吃掉整块"。导出 `runGreedy` 就是为了这个脚本
 * （业务路径仍走 load()）。
 *
 * 用法：node scripts/config-probe.mjs
 */
import { load, runGreedy, CARGO_CONFIGS } from '../dist/src/algorithm/index.js';

const HQ = { id: 'hq', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
const box = (id, length, width, height, quantity) => ({
  name: id, id, length, width, height, quantity, weight: 20,
  allowDirections: [true, true, false, false, false, false],
  deformFactor: 1, stackClass: 8, supportClasses: [8, 8, 8, 8, 8, 8],
  supportPct: [1, 1, 1], pcsCount: 1,
  supportFaces: 0, maxPlaceDepth: 0,
});

const CASES = [
  { name: '水泵 630+330', boxes: [box('WP20', 480, 380, 380, 630), box('WP30', 515, 380, 425, 330)] },
];

const SORTS = {
  vol: (x, y) => (y.box.length * y.box.width * y.box.height) - (x.box.length * x.box.width * x.box.height),
  qty: (x, y) => y.box.quantity - x.box.quantity,
};
const showSeq = process.argv.includes('--seq');

for (const c of CASES) {
  const params = { boxes: c.boxes, container: HQ, strategy: 3 };
  const agg = load(params);
  const aggN = agg.placements.reduce((a, p) => a + p.count, 0);
  console.log(`\n### ${c.name}  load() = ${aggN} 箱 / ${(agg.loadRate * 100).toFixed(2)}%`);
  for (const p of agg.placements) {
    console.log(`    ${p.boxId.padEnd(5)} dir${p.orientation}  ${p.dims.join('x').padEnd(18)} (${p.x},${p.y},${p.z})  ${p.count}`);
  }

  console.log('\n--- load() 现用配置 ---');
  for (let i = 0; i < CARGO_CONFIGS.length; i++) {
    const cfg = CARGO_CONFIGS[i];
    const r = runGreedy(params, cfg.sortKey, cfg.blockRatio, cfg.footprintRatio, cfg.preferCleanResidual, cfg.residualWeight);
    const n = r.placements.reduce((a, p) => a + p.count, 0);
    console.log(`  [${i}] ${perCargo(r)}  ${n} 箱 / ${(r.loadRate * 100).toFixed(2)}%`);
  }

  console.log('\n--- 穷举 sort × vol × fp × clean × β（残余前瞻权重）---');
  const rows = [];
  for (const [sn, sk] of Object.entries(SORTS)) {
    for (const vol of [0.5, 0.75, 0]) {
      for (const fp of [0.75, 0]) {
        for (const clean of [false, true]) {
          for (const beta of [0, 0.7, 0.8, 0.9, 0.95, 1]) {
            const r = runGreedy(params, sk, vol, fp, clean, beta);
            const n = r.placements.reduce((a, p) => a + p.count, 0);
            rows.push({ sn, vol, fp, clean, beta, n, r, rate: r.loadRate });
          }
        }
      }
    }
  }
  rows.sort((a, b) => b.n - a.n);
  for (const x of rows.slice(0, 24)) {
    console.log(`  ${x.sn} vol=${x.vol} fp=${x.fp} clean=${x.clean ? 'Y' : 'n'} β=${x.beta}  ${String(x.n).padStart(4)} 箱 / ${(x.rate * 100).toFixed(2)}%  ${perCargo(x.r)}`);
  }
  console.log(`  ...共 ${rows.length} 组；β=0 的最好成绩 = ${Math.max(...rows.filter((x) => x.beta === 0).map((x) => x.n))} 箱`);
  if (showSeq) {
    console.log('\n--- 分项最优配置的块序列 ---');
    // ① WP20 拿到完整 630 的配置里，WP30 最多的
    const wp20Full = rows.filter((x) => x.n >= 900 && x.r.placements.some((p) => p.boxId === 'WP20')).slice(0, 2);
    const seen = new Set();
    for (const x of [...rows.slice(0, 1), ...wp20Full]) {
      const key = `${x.sn}/${x.vol}/${x.fp}/${x.clean}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  ▸ ${key} = ${x.n} ${perCargo(x.r)}`);
      for (const p of x.r.placements) {
        console.log(`      ${p.boxId.padEnd(5)} dir${p.orientation}  ${p.dims.join('x').padEnd(18)} (${p.x},${p.y},${p.z})  ${p.count}`);
      }
    }
  }
}

function perCargo(r) {
  const m = new Map();
  for (const p of r.placements) m.set(p.boxId, (m.get(p.boxId) ?? 0) + p.count);
  return [...m].map(([k, v]) => `${k}:${v}`).join(' ');
}