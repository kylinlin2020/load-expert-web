/**
 * 诊断：各策略在"数量小于一整层"时的装载能力
 *
 * 背景（scripts/small-qty-bug.mjs 定位到的根因）：
 *   generateStrategy3 要求 fitLayerGrid 精确整除，否则退回"铺满 xy + 截断 z"，
 *   而后者在 availableCount < nX*nY 时第一层就 break → total=0 → 返回 null。
 *   实测 40HQ + 水泵3：qty=96 装 96，**qty=97 装 0**，qty=98 装 0，qty=99 装 99。
 *
 * generateStrategy1 同病：`rows = min(nY, floorDiv(availableCount, nX))`，
 * availableCount < nX 时 rows=0 → null。
 * generateStrategy2 有残层处理（count = min(nX*nY, availableCount)），不受影响。
 *
 * 本脚本对 6 个策略 × 一串数量跑一遍，输出每个策略实际装了多少，
 * 用来确认修复范围（哪些策略的 null 是"设计如此"，哪些是"装 0 的缺陷"）。
 */
import { load } from '../dist/src/algorithm/load.js';
import { STRATEGY_NAMES } from '../dist/src/algorithm/candidate-blocks.js';

const container = {
  id: 3,
  name: '40HQ',
  label: '40 尺高柜',
  innerLength: 11900,
  innerWidth: 2340,
  innerHeight: 2680,
  doorDims: { width: 2340, height: 2680 },
  weightCapacity: 26800,
};

const base = {
  id: '14',
  name: '水泵3',
  sku: '',
  length: 515,
  width: 380,
  height: 425,
  weight: 22,
  deformFactor: 1,
  deformTolerance: 0,
  stackClass: 8,
  supportClasses: [8, 8, 0, 0, 0, 0],
  supportPct: [1, 1, 1],
  pcsCount: 1,
  allowDirections: [true, true, false, false, false, false],
  maxPlaceDepth: [0, 0, 0, 0, 0, 0],
  supportFaces: [true, true, false, false, false, false],
};

const qtys = [1, 5, 17, 23, 24, 30, 50, 97, 98, 137, 138, 139, 200, 500];

const header = ['qty'].concat(Array.from({ length: 6 }, (_, s) => `S${s}`));
console.log(header.map((h, i) => h.padStart(i === 0 ? 5 : 7)).join(''));

const bad = [];
for (const qty of qtys) {
  const row = [String(qty).padStart(5)];
  for (let s = 0; s < 6; s++) {
    const r = load({ boxes: [{ ...base, quantity: qty }], container, strategy: s });
    row.push(`${r.pieces}/${qty}`.padStart(7));
    if (r.pieces === 0) bad.push({ qty, s, name: STRATEGY_NAMES[s] });
  }
  console.log(row.join(''));
}

console.log('\n装 0 的组合：');
for (const b of bad) console.log(`  qty=${b.qty} 策略${b.s}（${b.name}）`);
console.log(`\n共 ${bad.length} / ${qtys.length * 6} 个组合装 0`);