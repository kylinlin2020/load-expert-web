/** P0-c 策略差异对比：验证 6 个策略产出真正不同的装柜结果 */
import { load, planMultiContainer, expandResult, STRATEGY_NAMES } from '../dist/src/algorithm/index.js';

const con = { id: 'c', name: '20ft', innerLength: 5898, innerWidth: 2352, innerHeight: 2393, weightCapacity: 21770 };
const lamp = { id: 'lamp', name: 'L', length: 580, width: 380, height: 320, weight: 18.5, stackClass: 4, supportClasses: [4, 4, 4, 4, 4, 4], supportPct: [1, 1, 1], pcsCount: 6, quantity: 1200 };
const app = { id: 'app', name: 'A', length: 420, width: 310, height: 260, weight: 12, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], supportPct: [1, 1, 1], pcsCount: 2, quantity: 1500 };

const dist = (r) => {
  const m = new Map();
  for (const p of r.placements) m.set(p.boxId, (m.get(p.boxId) ?? 0) + p.count);
  return JSON.stringify([...m]);
};

console.log('--- A 单货物 (灯饰 1200 箱 / 20ft) ---');
for (let s = 0; s <= 5; s++) {
  const r = load({ boxes: [lamp], container: con, strategy: s });
  const placed = r.placements.reduce((a, x) => a + x.count, 0);
  const cartons = expandResult(r, [lamp]);
  console.log(
    `S${s} ${STRATEGY_NAMES[s].padEnd(12)} rate=${(r.loadRate * 100).toFixed(2).padStart(6)}%` +
    ` placements=${String(r.placements.length).padStart(3)} placed=${String(placed).padStart(4)}/1200` +
    ` layers=${String(r.layers.length).padStart(2)} cartons=${String(cartons.length).padStart(4)}`,
  );
}

console.log('\n--- B 混合货物 (灯饰 1200 + 家电 1500) ---');
for (let s = 0; s <= 5; s++) {
  const r = load({ boxes: [lamp, app], container: con, strategy: s });
  console.log(
    `S${s} ${STRATEGY_NAMES[s].padEnd(12)} rate=${(r.loadRate * 100).toFixed(2).padStart(6)}%` +
    ` placements=${String(r.placements.length).padStart(3)} dist=${dist(r)}`,
  );
}

/**
 * 策略指纹：把装柜结果规范化成字符串，两个策略指纹相同即代表结果完全一致
 * 归一化到逐箱坐标（而非聚合块），这样"块数不同但摆法相同"也能被识别为相同
 */
function fingerprint(result, boxes) {
  return expandResult(result, boxes)
    .map((c) => `${c.boxId}@${c.x},${c.y},${c.z},${c.dims.join('x')}`)
    .sort()
    .join('|');
}

/** 在多个差异化场景下比对 6 个策略指纹 */
const scenarios = [
  { name: '单货物 整除 (灯饰 1200)', boxes: [lamp] },
  { name: '单货物 不整除 (灯饰 440)', boxes: [{ ...lamp, quantity: 440 }] },
  { name: '细长件 200×200×1200', boxes: [{ ...lamp, length: 200, width: 200, height: 1200, quantity: 3000 }] },
  { name: '扁宽件 1200×900×150', boxes: [{ ...lamp, length: 1200, width: 900, height: 150, quantity: 3000 }] },
  { name: '堆码级别=1 (强制单层)', boxes: [{ ...lamp, stackClass: 1, supportClasses: [1, 1, 1, 1, 1, 1] }] },
  { name: '混合货物 (灯饰+家电)', boxes: [lamp, app] },
  { name: '混合 不整除 (440+777)', boxes: [{ ...lamp, quantity: 440 }, { ...app, quantity: 777 }] },
  { name: '混合 异形 (扁+细长)', boxes: [{ ...lamp, length: 1200, width: 900, height: 150, quantity: 800 }, { ...app, length: 200, width: 200, height: 1200, quantity: 500 }] },
];

let allDistinct = true;
for (const sc of scenarios) {
  const fps = [];
  for (let s = 0; s <= 5; s++) {
    fps.push(fingerprint(load({ boxes: sc.boxes, container: con, strategy: s }), sc.boxes));
  }
  const groups = new Map();
  fps.forEach((f, s) => {
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(s);
  });
  const dup = [...groups.values()].filter((g) => g.length > 1);
  const ok = dup.length === 0;
  if (!ok) allDistinct = false;
  console.log(
    `  ${ok ? '✅' : '⚠️ '} ${sc.name.padEnd(28)} 唯一指纹=${groups.size}/6` +
    (dup.length ? `  重复组=${dup.map((g) => '[' + g.join(',') + ']').join(' ')}` : ''),
  );
}
console.log(`\n所有场景 6 策略互不相同：${allDistinct ? '✅ 是' : '⚠️ 否'}`);

console.log('\n--- D 几何不重叠 + 逐箱不重叠（6 策略全跑）---');
for (let s = 0; s <= 5; s++) {
  const r = load({ boxes: [lamp, app], container: con, strategy: s });
  const cartons = expandResult(r, [lamp, app]);
  let bad = 0;
  for (let i = 0; i < cartons.length; i++) {
    for (let j = i + 1; j < cartons.length; j++) {
      const a = cartons[i], b = cartons[j];
      const ox = Math.min(a.x + a.dims[0], b.x + b.dims[0]) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.dims[1], b.y + b.dims[1]) - Math.max(a.y, b.y);
      const oz = Math.min(a.z + a.dims[2], b.z + b.dims[2]) - Math.max(a.z, b.z);
      if (ox > 1e-6 && oy > 1e-6 && oz > 1e-6) bad++;
    }
  }
  console.log(`S${s} cartons=${String(cartons.length).padStart(5)} overlaps=${bad} ${bad === 0 ? '✅' : '❌'}`);
}

console.log('\n--- E 多柜装载 ---');
for (let s = 0; s <= 5; s++) {
  const r = planMultiContainer({ boxes: [lamp, app], container: con, strategy: s });
  console.log(
    `S${s} ${STRATEGY_NAMES[s].padEnd(12)} containers=${String(r.totalContainers).padStart(2)}` +
    ` overall=${(r.overallRate * 100).toFixed(2).padStart(6)}% remaining=${JSON.stringify(r.remaining)}`,
  );
}
