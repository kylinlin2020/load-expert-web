/** P0-d 混装效果总览：3 货物 / 2 货物 / 单货物 + 几何正确性 */
import { load, expandResult } from '../dist/src/algorithm/index.js';

const HQ = { id: 'c', name: '40HQ', innerLength: 12032, innerWidth: 2352, innerHeight: 2698, weightCapacity: 26800 };
const FT = { id: 'c2', name: '20ft', innerLength: 5898, innerWidth: 2352, innerHeight: 2393, weightCapacity: 21770 };

const mk = (id, l, w, h, weight, sc, qty) => ({
  id, name: id, length: l, width: w, height: h, weight,
  stackClass: sc, supportClasses: new Array(6).fill(sc), supportPct: [1, 1, 1], pcsCount: 1, quantity: qty,
});

const A = mk('A', 480, 380, 380, 20, 5, 1200);
const B = mk('B', 420, 310, 260, 12, 3, 1500);
const C = mk('C', 1200, 900, 150, 30, 2, 400);

function run(label, boxes, container) {
  console.log(`\n--- ${label} ---`);
  let kindsTotal = 0;
  let rates = [];
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container, strategy: s });
    const m = new Map();
    for (const p of r.placements) m.set(p.boxId, (m.get(p.boxId) ?? 0) + p.count);
    const cartons = expandResult(r, boxes);
    let oob = 0;
    for (const c of cartons) {
      if (c.x + c.dims[0] > container.innerLength + 1e-6 || c.y + c.dims[1] > container.innerWidth + 1e-6 || c.z + c.dims[2] > container.innerHeight + 1e-6) oob++;
    }
    kindsTotal += m.size;
    rates.push(Number((r.loadRate * 100).toFixed(1)));
    console.log(
      `S${s} rate=${(r.loadRate * 100).toFixed(1).padStart(5)}% 种类=${m.size}/${boxes.length}` +
      ` 箱=${String(cartons.length).padStart(5)} 越界=${oob} ${JSON.stringify([...m])}`,
    );
  }
  console.log(`  → 种类合计 ${kindsTotal}/${boxes.length * 6}  装载率 ${rates.join('/')}%`);
}

run('40HQ 三货物 (A1200 B1500 C400)', [A, B, C], HQ);
run('40HQ 两货物 (A1200 B1500)', [A, B], HQ);
run('40HQ 单货物 (A1200)', [A], HQ);
run('20ft 三货物 (A600 B900 C200)', [mk('A',480,380,380,20,5,600), mk('B',420,310,260,12,3,900), mk('C',1200,900,150,30,2,200)], FT);
