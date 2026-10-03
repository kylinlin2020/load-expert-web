/** 进度诊断脚本：验证算法真实行为（非单测断言覆盖范围） */
import { load, planMultiContainer, expandResult } from '../dist/src/algorithm/index.js';

const container = {
  id: 'con-20ft', name: '20ft', innerLength: 5898, innerWidth: 2352, innerHeight: 2393, weightCapacity: 21770,
};

const lamp = {
  id: 'lamp', name: 'LED', length: 580, width: 380, height: 320, weight: 18.5,
  stackClass: 4, supportClasses: [4,4,4,4,4,4], supportPct: [1,1,1], pcsCount: 6, quantity: 1200,
};
const appliance = {
  id: 'appliance', name: '家电', length: 420, width: 310, height: 260, weight: 12,
  stackClass: 3, supportClasses: [3,3,3,3,3,3], supportPct: [1,1,1], pcsCount: 2, quantity: 1500,
};

const out = [];
const p = (s) => out.push(s);

p('=== A. 6 种策略单货物（灯饰 1200 箱 / 20ft）===');
const single = { ...lamp, quantity: 1200 };
for (let s = 0; s <= 5; s++) {
  const r = load({ boxes: [single], container, strategy: s });
  const placed = r.placements.reduce((a, x) => a + x.count, 0);
  p(`策略 ${s}: 装载率=${(r.loadRate*100).toFixed(2)}%  placement数=${r.placements.length}  已装=${placed}/${single.quantity}  层数=${r.layers.length}  迭代=${r.iterations}  未装=${JSON.stringify(r.rejected)}`);
  for (const pl of r.placements) {
    p(`    placement: dims=${pl.dims.join('x')} @(${pl.x},${pl.y},${pl.z}) count=${pl.count} dir=${pl.orientation}`);
  }
}

p('');
p('=== B. 两种货物混合（灯饰 1200 + 家电 1500）===');
for (let s = 0; s <= 5; s++) {
  const r = load({ boxes: [lamp, appliance], container, strategy: s });
  const byBox = new Map();
  for (const pl of r.placements) byBox.set(pl.boxId, (byBox.get(pl.boxId)??0) + pl.count);
  p(`策略 ${s}: 装载率=${(r.loadRate*100).toFixed(2)}%  placement=${r.placements.length}  分布=${JSON.stringify([...byBox])}  未装=${JSON.stringify(r.rejected)}`);
}

p('');
p('=== C. 层信息 layers 检查（策略3 单货物）===');
{
  const r = load({ boxes: [single], container, strategy: 3 });
  p(`layers.length = ${r.layers.length}（P0-b 前为 1：整块被当成一层）`);
  r.layers.forEach((l) => p(`  layer${l.level} z=${l.zMin}~${l.zMax} count=${l.count}`));
  const cartons = expandResult(r, [single]);
  p(`逐件坐标数 = ${cartons.length}，不同 z 数 = ${new Set(cartons.map((c) => Math.round(c.z))).size}`);
}

p('');
p('=== D. 层高是否能超过 1（多件小货物）===');
{
  const small = { ...lamp, length: 200, width: 200, height: 200, quantity: 5000, supportClasses:[4,4,4,4,4,4] };
  const r = load({ boxes: [small], container, strategy: 3 });
  const placed = r.placements.reduce((a,x)=>a+x.count,0);
  const cartons = expandResult(r, [small]);
  p(`小箱 200x200x200: 装载率=${(r.loadRate*100).toFixed(2)}% placement=${r.placements.length} 已装=${placed}/5000 迭代=${r.iterations}`);
  p(`  placement[0]: ${JSON.stringify(r.placements[0])}`);
  p(`  layers=${r.layers.length}（真实物理层），逐件=${cartons.length}`);
  r.layers.forEach((l) => p(`    layer${l.level} z=${l.zMin}~${l.zMax} count=${l.count}`));
}

p('');
p('=== E. 多柜装载 planMultiContainer ===');
{
  const r = planMultiContainer({ boxes: [lamp, appliance], container, strategy: 3 });
  p(`总柜数=${r.totalContainers} 总体装载率=${(r.overallRate*100).toFixed(2)}% 剩余=${JSON.stringify(r.remaining)}`);
  r.plans.forEach((pl, i) => {
    const byBox = new Map();
    for (const x of pl.placements) byBox.set(x.boxId, (byBox.get(x.boxId)??0)+x.count);
    p(`  柜#${i+1}: 装载率=${(pl.loadRate*100).toFixed(2)}% placement=${pl.placements.length} 分布=${JSON.stringify([...byBox])}`);
  });
}

p('');
p('=== F. 高级设置开关（allowRotation=false 等）是否生效 ===');
{
  const r1 = load({ boxes: [single], container, strategy: 3, options: { allowRotation: false } });
  p(`allowRotation=false: 装载率=${(r1.loadRate*100).toFixed(2)}% placement=${r1.placements.length} dirs=${[...new Set(r1.placements.map(x=>x.orientation))]}`);
  const r2 = load({ boxes: [single], container, strategy: 3, options: { candidateLimit: 1 } });
  p(`candidateLimit=1:    装载率=${(r2.loadRate*100).toFixed(2)}% placement=${r2.placements.length}`);
  const r3 = load({ boxes: [single], container, strategy: 3, options: { maxIterations: 2 } });
  p(`maxIterations=2:    装载率=${(r3.loadRate*100).toFixed(2)}% 未装=${JSON.stringify(r3.rejected)}`);
}

p('');
p('=== G. 载重约束是否真的生效 ===');
{
  const heavy = { ...lamp, weight: 500, quantity: 1200 };
  const r = load({ boxes: [heavy], container, strategy: 3 });
  const placed = r.placements.reduce((a,x)=>a+x.count,0);
  p(`重货 500kg/箱: 已装=${placed} 总重=${r.totalWeight}kg (上限 ${container.weightCapacity}) 装载率=${(r.loadRate*100).toFixed(2)}% 未装=${JSON.stringify(r.rejected)}`);
}

console.log(out.join('\n'));
