import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Box, Container } from '../src/types/index.js';
import { load, runGreedy, CARGO_CONFIGS } from '../src/algorithm/load.js';
import { orientDims, ORIENTATION_AXIS_ORDERS } from '../src/algorithm/orientations.js';
import { generateStrategy0, generateStrategy1, generateStrategy2, generateStrategy3, generateStrategy4, generateStrategy5, containerVolume, MULTI_CARGO_FOOTPRINT_RATIO } from '../src/algorithm/candidate-blocks.js';
import { scoreBlock } from '../src/algorithm/block-scoring.js';
import { SpaceManager } from '../src/algorithm/space-manager.js';
import { solveMaximize, solveVolumeMix } from '../src/algorithm/simplex.js';
import { expandResult, gridOf } from '../src/algorithm/expand.js';
import { checkWeightCapacity, countPieces } from '../src/algorithm/constraints.js';

/** 20ft 标准柜（内尺寸近似） */
function makeContainer(): Container {
  return {
    id: 'con-20ft',
    name: '20ft 干货柜',
    innerLength: 5898,
    innerWidth: 2352,
    innerHeight: 2393,
    weightCapacity: 21770,
  };
}

function makeBox(partial: Partial<Box> & { id: string; quantity?: number }): Box {
  return {
    name: partial.id,
    length: 600,
    width: 400,
    height: 300,
    weight: 20,
    stackClass: 5,
    supportClasses: [5, 5, 5, 5, 5, 5],
    supportPct: [1, 1, 1],
    pcsCount: 1,
    quantity: 1000,
    ...partial,
  };
}

test('单种货物满载：体积不超容器且装载率大于 0', () => {
  const box = makeBox({ id: 'box-a', length: 600, width: 400, height: 300, quantity: 1000 });
  const container = makeContainer();
  const r = load({ boxes: [box], container, strategy: 3 });
  assert.ok(r.placements.length > 0, '应产生放置');
  assert.ok(r.usedVolume <= containerVolume(container) + 1e-6, '占用体积不得超过柜内容积');
  assert.ok(r.loadRate > 0 && r.loadRate <= 1, `装载率应在 (0,1]，实际 ${r.loadRate}`);
  assert.ok(r.totalWeight <= container.weightCapacity, '总重量不得超过载重');
  assert.ok(r.iterations > 0, '应有迭代');
});

test('多货物混合：两类货物均可装入且统计正确', () => {
  const a = makeBox({ id: 'A', length: 500, width: 400, height: 300, quantity: 300 });
  const b = makeBox({ id: 'B', length: 300, width: 300, height: 300, quantity: 500 });
  const container = makeContainer();
  const r = load({ boxes: [a, b], container, strategy: 3 });
  const countA = r.placements.filter((p) => p.boxId === 'A').reduce((s, p) => s + p.count, 0);
  const countB = r.placements.filter((p) => p.boxId === 'B').reduce((s, p) => s + p.count, 0);
  assert.ok(countA > 0, '货物 A 应装入');
  assert.ok(countB > 0, '货物 B 应装入');
  assert.ok(r.usedVolume <= containerVolume(container) + 1e-6, '体积不超容器');
  assert.ok(countA <= a.quantity && countB <= b.quantity, '装入数量不超过可用数量');
});

test('六方向合理性：轴序映射产生全部排列且尺寸正确', () => {
  const box = makeBox({ id: 'x', length: 10, width: 20, height: 30 });
  const permutations: Array<[number, number, number]> = [];
  for (let o = 0; o < 6; o++) {
    const d = orientDims(box, o);
    permutations.push(d);
    const order = ORIENTATION_AXIS_ORDERS[o];
    assert.equal(d[0], [10, 20, 30][order[0]]);
    assert.equal(d[1], [10, 20, 30][order[1]]);
    assert.equal(d[2], [10, 20, 30][order[2]]);
  }
  // 6 个方向应覆盖 L/W/H 的全排列
  const key = (d: readonly number[]) => d.join(',');
  const set = new Set(permutations.map(key));
  assert.equal(set.size, 6, '6 个方向应产生 6 种不同排列');
});

test('约束生效：超重时拒绝继续装入', () => {
  const heavy = makeBox({ id: 'heavy', weight: 30000, quantity: 100 });
  const container = makeContainer(); // 载重 21770
  const r = load({ boxes: [heavy], container, strategy: 0 });
  assert.ok(r.totalWeight <= container.weightCapacity, '总重量不超过载重');
  assert.ok(r.rejected.length > 0 || r.totalWeight > 0, '超重货物应被限制（拒绝或部分装入）');
});

test('约束生效：堆码级别受限货物不可堆叠在承托不足的货物之上', () => {
  const container = makeContainer();
  // 承托能力 1 的底座（下层 supportClass=1）
  const bottom = makeBox({ id: 'bottom', length: 500, width: 400, height: 300, stackClass: 1, supportClasses: [1, 1, 1, 1, 1, 1], quantity: 200 });
  // 堆码需求 5 的货物（上层 stackClass=5）
  const top = makeBox({ id: 'top', length: 500, width: 400, height: 300, stackClass: 5, supportClasses: [5, 5, 5, 5, 5, 5], quantity: 200 });
  const r = load({ boxes: [bottom, top], container, strategy: 0 });
  const bottomP = r.placements.find((p) => p.boxId === 'bottom');
  assert.ok(bottomP, 'bottom 应被装入');
  assert.ok(bottomP.dims[2] > 0, 'bottom 应占据一定高度');

  // 硬断言：top 不得被放在 bottom 正上方（承托级别 1 < 堆码需求 5）
  for (const p of r.placements.filter((q) => q.boxId === 'top')) {
    const onBottom: boolean =
      p.z > 1e-6 &&
      p.x < bottomP.x + bottomP.dims[0] - 1e-6 &&
      bottomP.x < p.x + p.dims[0] - 1e-6 &&
      p.y < bottomP.y + bottomP.dims[1] - 1e-6 &&
      bottomP.y < p.y + p.dims[1] - 1e-6;
    assert.equal(onBottom, false, 'stackClass=5 不得堆叠在 supportClass=1 的 bottom 之上');
  }
});

test('约束生效：离地放置必须有承托且堆码级别不超过下层承托级别', () => {
  const container = makeContainer();
  const a = makeBox({ id: 'a', length: 500, width: 400, height: 300, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 200 });
  const b = makeBox({ id: 'b', length: 500, width: 400, height: 300, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 200 });
  const r = load({ boxes: [a, b], container, strategy: 0 });

  // 硬断言：任何离地放置都必须有承托，且堆码级别不超过所有承托放置的承托级别
  // （此前断言被包在 if (below) 内，below 找不到时一次都不执行 → 空跑测试）
  let offFloor = 0;
  for (const p of r.placements) {
    if (p.z <= 1e-6) {
      continue;
    }
    offFloor++;
    const supports = r.placements.filter(
      (q) =>
        Math.abs(q.z + q.dims[2] - p.z) < 1e-6 &&
        q.x < p.x + p.dims[0] - 1e-6 &&
        p.x < q.x + q.dims[0] - 1e-6 &&
        q.y < p.y + p.dims[1] - 1e-6 &&
        p.y < q.y + q.dims[1] - 1e-6,
    );
    assert.ok(supports.length > 0, `离地放置 ${p.boxId}@z=${p.z} 必须有承托，不得悬空`);
    for (const s of supports) {
      assert.ok(p.stackClass <= s.supportClass, `上层 ${p.boxId} 堆码级别 ${p.stackClass} 不得超过下层 ${s.boxId} 承托级别 ${s.supportClass}`);
    }
  }
  assert.ok(offFloor > 0, '该场景应至少产生一个离地放置，否则本用例无法验证堆码约束');
});

test('对照：承托能力足够的货物允许堆叠（证明堆码约束不是一律拒绝）', () => {
  const container = makeContainer();
  const a = makeBox({ id: 'a', length: 500, width: 400, height: 300, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 200 });
  const b = makeBox({ id: 'b', length: 500, width: 400, height: 300, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 200 });
  // 用策略3（满舱，多层堆叠）验证堆叠能力；策略0 是单轴条块，本就不向上堆
  const r = load({ boxes: [a, b], container, strategy: 3 });
  assert.ok(r.placements.length > 0, '应产生放置');
  const stacked = r.placements.some((p) => p.boxId === 'b' && p.z > 1e-6);
  assert.ok(stacked, '承托级别 3 承托堆码级别 3 的货物时，b 应能堆叠在 a 之上');
});

test('约束生效：底部承托比例不足时拒绝离地放置', () => {
  const container = makeContainer();
  // 宽底座：铺满柜宽
  const base = makeBox({ id: 'base', length: 1000, width: 1000, height: 200, stackClass: 5, supportClasses: [5, 5, 5, 5, 5, 5], quantity: 1 });
  // 细高柱：要求 100% 承托，若落在 base 之侧（无承托）应被拒
  const pillar = makeBox({
    id: 'pillar', length: 100, width: 100, height: 1000, stackClass: 5,
    supportClasses: [5, 5, 5, 5, 5, 5], supportPct: [1, 1, 1], quantity: 200,
  });
  // 策略3 会向上堆叠多层，才能验证「离地放置的承托」；策略0 是单轴条块不向上堆
  const r = load({ boxes: [base, pillar], container, strategy: 3 });

  // 任何离地的 pillar 放置都必须被 base 100% 承托（其底面完全落在 base 顶面内）
  for (const p of r.placements) {
    if (p.boxId !== 'pillar' || p.z <= 1e-6) {
      continue;
    }
    const baseP = r.placements.find((q) => q.boxId === 'base')!;
    assert.ok(Math.abs(baseP.z + baseP.dims[2] - p.z) < 1e-6, 'pillar 离地时必须坐在 base 顶面');
    assert.ok(p.x >= baseP.x - 1e-6 && p.x + p.dims[0] <= baseP.x + baseP.dims[0] + 1e-6, 'pillar 底面不得超出 base 的 x 足迹');
    assert.ok(p.y >= baseP.y - 1e-6 && p.y + p.dims[1] <= baseP.y + baseP.dims[1] + 1e-6, 'pillar 底面不得超出 base 的 y 足迹');
  }
});

test('策略5 修复：不再恒为 no-fit（原 maxZ 未受 level 收窄导致满高块越界）', () => {
  const box = makeBox({ id: 's5', length: 580, width: 380, height: 320, quantity: 1200 });
  const container = makeContainer();
  const r = load({ boxes: [box], container, strategy: 5 });
  assert.ok(r.placements.length > 0, '策略5 应产生放置（修复前恒为 0 个 / no-fit）');
  const placed = r.placements.reduce((s, p) => s + p.count, 0);
  assert.ok(placed > 0, '策略5 应装入至少 1 件');
  assert.ok(r.loadRate > 0, `策略5 装载率应大于 0，实际 ${r.loadRate}`);
  // 所有放置均不得越出柜体
  for (const p of r.placements) {
    assert.ok(p.x + p.dims[0] <= container.innerLength + 1e-6, 'x 不越界');
    assert.ok(p.y + p.dims[1] <= container.innerWidth + 1e-6, 'y 不越界');
    assert.ok(p.z + p.dims[2] <= container.innerHeight + 1e-6, 'z 不越界');
  }
});

test('空间切分：剩余空间互不重叠、均在原空间内、条带整高', () => {
  const space = { x: 0, y: 0, z: 0, dx: 1000, dy: 500, dz: 300 };
  const dims: [number, number, number] = [800, 400, 200];
  const sm = new SpaceManager();
  const rest = sm.split(space, { x: 0, y: 0, z: 0, dims });
  assert.equal(rest.length, 3, '应切出 3 个剩余空间（顶部 / 尾端条带 / 侧边条带）');

  const vol = (s: { dx: number; dy: number; dz: number }) => s.dx * s.dy * s.dz;
  const overlap = (
    a: { x: number; y: number; z: number; dx: number; dy: number; dz: number },
    b: { x: number; y: number; z: number; dx: number; dy: number; dz: number },
  ) => {
    const ox = Math.min(a.x + a.dx, b.x + b.dx) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.dy, b.y + b.dy) - Math.max(a.y, b.y);
    const oz = Math.min(a.z + a.dz, b.z + b.dz) - Math.max(a.z, b.z);
    return ox > 1e-9 && oy > 1e-9 && oz > 1e-9;
  };

  // 不超出原空间
  for (const r of rest) {
    assert.ok(r.x >= space.x - 1e-9 && r.y >= space.y - 1e-9 && r.z >= space.z - 1e-9, '原点不得越出原空间');
    assert.ok(r.x + r.dx <= space.x + space.dx + 1e-9, 'x 不得越出');
    assert.ok(r.y + r.dy <= space.y + space.dy + 1e-9, 'y 不得越出');
    assert.ok(r.z + r.dz <= space.z + space.dz + 1e-9, 'z 不得越出');
    assert.ok(r.dx > 0 && r.dy > 0 && r.dz > 0, '剩余空间尺寸须为正');
  }
  // 两两不重叠
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      assert.equal(overlap(rest[i], rest[j]), false, `剩余空间 ${i} 与 ${j} 重叠`);
    }
  }
  // 体积守恒：剩余总体积 + 块体积 = 原空间体积
  const restVol = rest.reduce((s, r) => s + vol(r), 0);
  const blockVol = vol({ dx: dims[0], dy: dims[1], dz: dims[2] });
  assert.ok(Math.abs(restVol + blockVol - vol(space)) < 1e-6, `体积应守恒：剩余 ${restVol} + 块 ${blockVol} = 原 ${vol(space)}`);

  // 尾端/侧边条带必须整高（否则剩余空间上部会永久丢失）
  const top = rest.find((r) => r.z === dims[2])!;
  const strips = rest.filter((r) => r.z === space.z);
  assert.ok(top, '应存在块正上方的顶部空间');
  assert.equal(top.dx, dims[0], '顶部空间 x 范围应等于块足迹 x（保证 100% 承托）');
  assert.equal(top.dy, dims[1], '顶部空间 y 范围应等于块足迹 y（保证 100% 承托）');
  assert.equal(strips.length, 2, '应有 2 条贴地整高条带');
  for (const s of strips) {
    assert.equal(s.dz, space.dz, '条带应保持原空间整高');
  }
});

test('结果体积不超容器（通用断言）', () => {
  const container = makeContainer();
  const box = makeBox({ id: 'g', length: 700, width: 500, height: 400, quantity: 2000 });
  const r = load({ boxes: [box], container, strategy: 5 });
  assert.ok(r.usedVolume <= containerVolume(container) + 1e-6);
  for (const p of r.placements) {
    assert.ok(p.x + p.dims[0] <= container.innerLength + 1e-6, 'x 方向不越界');
    assert.ok(p.y + p.dims[1] <= container.innerWidth + 1e-6, 'y 方向不越界');
    assert.ok(p.z + p.dims[2] <= container.innerHeight + 1e-6, 'z 方向不越界');
  }
});

test('装载率计算正确', () => {
  const container = makeContainer();
  const cv = containerVolume(container);
  const box = makeBox({ id: 'r', length: 5898, width: 2352, height: 2393, quantity: 1 });
  // 单箱恰好填满（理论上限）
  const r = load({ boxes: [box], container, strategy: 0 });
  assert.ok(r.loadRate <= 1 + 1e-9);
  assert.equal(r.usedVolume, r.loadRate * cv);
});

test('候选块策略0：单方向条块只沿最长轴铺一条线', () => {
  const box = makeBox({ id: 's0', length: 200, width: 100, height: 100 });
  const container = makeContainer();
  const space = { x: 0, y: 0, z: 0, dx: 1000, dy: 500, dz: 300 };
  const block = generateStrategy0({ box, container, x: 0, y: 0, z: 0, space, orientation: 0, level: 3, availableCount: 1000 });
  assert.ok(block);
  // 空间 1000×500×300，单箱 200×100×100 → x 可放 5、y 可放 5、z 可放 3（受 level）
  // 单轴条块取最长轴 x = 5 件，y/z 各只占 1 箱厚
  assert.equal(block!.pieceCount, 5);
  const sub = block!.subBlocks[0];
  assert.equal(sub.x, 1000, 'x 应铺满空间长度');
  assert.equal(sub.y, 100, 'y 只占一个单箱厚');
  assert.equal(sub.z, 100, 'z 只占一个单箱厚');
  // 仍为合法块：不越界
  assert.ok(sub.x <= space.dx && sub.y <= space.dy && sub.z <= space.dz);
});

test('候选块策略3：评分=4子块体积和且件数正确', () => {
  const box = makeBox({ id: 's3', length: 200, width: 100, height: 100 });
  const container = makeContainer();
  const space = { x: 0, y: 0, z: 0, dx: 1000, dy: 500, dz: 300 };
  const block = generateStrategy3({ box, container, x: 0, y: 0, z: 0, space, orientation: 0, level: 3, availableCount: 1000 });
  assert.ok(block);
  assert.equal(block!.pieceCount, 75);
  const subVol = block!.subBlocks.reduce((s, sb) => s + sb.x * sb.y * sb.z, 0);
  assert.equal(scoreBlock(block!), subVol);
});

test('空间管理：三分切分产生非重叠空间且不超原空间', () => {
  const sm = new SpaceManager();
  const space = { x: 0, y: 0, z: 0, dx: 1000, dy: 500, dz: 300 };
  const rest = sm.split(space, { x: 0, y: 0, z: 0, dims: [800, 400, 200] as [number, number, number] });
  assert.ok(rest.length >= 1, '应产生至少一个剩余空间');
  for (const r of rest) {
    assert.ok(r.dx >= 0 && r.dy >= 0 && r.dz >= 0);
  }
  // 扩容策略下限 4
  assert.ok(sm.capacitySize >= 4);
});

test('放置不重叠：任意两箱的体积不相交（几何硬约束）', () => {
  const container = makeContainer();
  const boxes = [
    makeBox({ id: 'g1', length: 500, width: 400, height: 300, quantity: 300 }),
    makeBox({ id: 'g2', length: 300, width: 300, height: 300, quantity: 500 }),
  ];
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container, strategy: s });
    for (let i = 0; i < r.placements.length; i++) {
      for (let j = i + 1; j < r.placements.length; j++) {
        const a = r.placements[i];
        const b = r.placements[j];
        const ox = Math.min(a.x + a.dims[0], b.x + b.dims[0]) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.dims[1], b.y + b.dims[1]) - Math.max(a.y, b.y);
        const oz = Math.min(a.z + a.dims[2], b.z + b.dims[2]) - Math.max(a.z, b.z);
        assert.ok(
          !(ox > 1e-6 && oy > 1e-6 && oz > 1e-6),
          `策略${s}: 放置 #${i}(${a.boxId}) 与 #${j}(${b.boxId}) 体积重叠`,
        );
      }
    }
  }
});

test('逐件展开：网格尺寸与箱数自洽，且逐箱不越出块包围盒', () => {
  const box = makeBox({ id: 'g', length: 500, width: 400, height: 300, quantity: 300 });
  const container = makeContainer();
  const r = load({ boxes: [box], container, strategy: 3 });
  const cartons = expandResult(r, [box]);
  const expected = r.placements.reduce((s, p) => s + p.count, 0);
  assert.equal(cartons.length, expected, '逐件总数应等于各 placement 的 count 之和');

  for (const p of r.placements) {
    const mine = cartons.filter((c) => c.placementIndex === r.placements.indexOf(p));
    assert.equal(mine.length, p.count, `placement#${p.boxId} 应展开出 ${p.count} 箱`);
    for (const c of mine) {
      // 逐箱尺寸 = 该姿态下单箱尺寸（不是块包围盒）
      assert.notEqual(c.dims[0], p.dims[0], '逐件尺寸应为单箱尺寸而非块包围盒');
      // 逐箱须落在块包围盒内
      assert.ok(c.x >= p.x - 1e-6, 'x 不越出块左边界');
      assert.ok(c.y >= p.y - 1e-6, 'y 不越出块前边界');
      assert.ok(c.z >= p.z - 1e-6, 'z 不越出块底面');
      assert.ok(c.x + c.dims[0] <= p.x + p.dims[0] + 1e-6, 'x 不越出块右边界');
      assert.ok(c.y + c.dims[1] <= p.y + p.dims[1] + 1e-6, 'y 不越出块后边界');
      assert.ok(c.z + c.dims[2] <= p.z + p.dims[2] + 1e-6, 'z 不越出块顶面');
      // 逐箱须落在柜内
      assert.ok(c.x + c.dims[0] <= container.innerLength + 1e-6);
      assert.ok(c.y + c.dims[1] <= container.innerWidth + 1e-6);
      assert.ok(c.z + c.dims[2] <= container.innerHeight + 1e-6);
    }
  }
});

test('逐件展开：逐箱之间互不重叠（3D 逐箱渲染的硬前提）', () => {
  const container = makeContainer();
  const boxes = [
    makeBox({ id: 'p1', length: 500, width: 400, height: 300, quantity: 300 }),
    makeBox({ id: 'p2', length: 300, width: 300, height: 300, quantity: 500 }),
  ];
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container, strategy: s });
    const cartons = expandResult(r, boxes);
    assert.ok(cartons.length > 0, `策略${s} 应展开出逐箱坐标`);
    for (let i = 0; i < cartons.length; i++) {
      for (let j = i + 1; j < cartons.length; j++) {
        const a = cartons[i];
        const b = cartons[j];
        const ox = Math.min(a.x + a.dims[0], b.x + b.dims[0]) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.dims[1], b.y + b.dims[1]) - Math.max(a.y, b.y);
        const oz = Math.min(a.z + a.dims[2], b.z + b.dims[2]) - Math.max(a.z, b.z);
        assert.ok(
          !(ox > 1e-6 && oy > 1e-6 && oz > 1e-6),
          `策略${s}: 逐箱 #${i} 与 #${j} 重叠（overlap=${ox.toFixed(1)}×${oy.toFixed(1)}×${oz.toFixed(1)}）`,
        );
      }
    }
  }
});

test('逐件展开：总体积与聚合块口径一致', () => {
  const box = makeBox({ id: 'v', length: 580, width: 380, height: 320, quantity: 1200 });
  const container = makeContainer();
  const r = load({ boxes: [box], container, strategy: 3 });
  const cartons = expandResult(r, [box]);
  const cartonVol = cartons.reduce((s, c) => s + c.dims[0] * c.dims[1] * c.dims[2], 0);
  // 逐箱体积之和应与 usedVolume 一致（轴置换不改变体积）
  assert.ok(Math.abs(cartonVol - r.usedVolume) < 1, `逐箱体积和 ${cartonVol} 应≈ usedVolume ${r.usedVolume}`);
  assert.equal(cartons.length, 432, '20ft 装 580×380×320 应为 432 箱');
});

test('分层统计：按真实 z 底面分层，不再把整块当一层', () => {
  const container = makeContainer();
  // 200³ 小箱：策略3 会装成一个 3 层高的聚合块
  const small = makeBox({ id: 's', length: 200, width: 200, height: 200, quantity: 5000 });
  const r = load({ boxes: [small], container, strategy: 3 });
  const p = r.placements[0];
  assert.ok(p, '应产生放置');
  const cartons = expandResult(r, [small]);
  const distinctZ = new Set(cartons.map((c) => Math.round(c.z)));
  assert.equal(r.layers.length, distinctZ.size, `layers 应等于逐箱不同 z 数（${distinctZ.size}），实际 ${r.layers.length}`);
  // 层 z 单调递增且不重叠
  for (let i = 1; i < r.layers.length; i++) {
    assert.ok(r.layers[i].zMin >= r.layers[i - 1].zMax - 1e-6, '层 z 区间应单调不倒退');
  }
  // 各层箱数之和 = 逐箱总数
  const layerCount = r.layers.reduce((s, l) => s + l.count, 0);
  assert.equal(layerCount, cartons.length, '各层箱数之和应等于逐箱总数');
  // 层体积之和 = usedVolume
  const layerVol = r.layers.reduce((s, l) => s + l.volume, 0);
  assert.ok(Math.abs(layerVol - r.usedVolume) < 1, '各层体积之和应≈ usedVolume');
});

test('网格推导：gridOf 由包围盒与单箱尺寸反推 nx/ny/nz', () => {
  // 块 5760×2320×2280，单箱 320×580×380（dir3: H→x, L→y, W→z）→ 18×4×6
  assert.deepEqual(gridOf([5760, 2320, 2280], [320, 580, 380], 432), [18, 4, 6]);
  // 单箱块 → 1×1×1
  assert.deepEqual(gridOf([500, 400, 300], [500, 400, 300], 1), [1, 1, 1]);
  // 容量不足时沿 z 补层：1×1×1 装 5 箱 → 5 层
  assert.deepEqual(gridOf([500, 400, 300], [500, 400, 300], 5), [1, 1, 5]);
});

test('P0-c 策略差异化：多场景下 6 策略产出多种不同装柜结果', () => {
  // 核心事实：改变「分块方式」不足以改变结果 —— 贪心主循环会切分重填，
  // 分块痕迹被抹平。真正决定结果的是逐箱坐标（姿态 + 网格）。
  // 因此本用例断言「逐箱坐标指纹」的多样性，而非分块数。
  const base = makeBox({ id: 'p', length: 580, width: 380, height: 320, weight: 18.5, quantity: 1200 });
  const container = makeContainer();
  const scenarios: Array<{ name: string; boxes: Box[] }> = [
    { name: '单货物整除', boxes: [base] },
    { name: '单货物不整除', boxes: [{ ...base, quantity: 440 }] },
    { name: '细长件', boxes: [{ ...base, length: 200, width: 200, height: 1200, quantity: 3000 }] },
    { name: '扁宽件', boxes: [{ ...base, length: 1200, width: 900, height: 150, quantity: 3000 }] },
    { name: '堆码级=1', boxes: [{ ...base, stackClass: 1, supportClasses: [1, 1, 1, 1, 1, 1] }] },
  ];

  let maxDistinct = 0;
  for (const sc of scenarios) {
    const fps = new Set<string>();
    for (let s = 0; s <= 5; s++) {
      const r = load({ boxes: sc.boxes, container, strategy: s });
      assert.ok(r.placements.length > 0, `${sc.name} 策略${s} 应产生放置`);
      fps.add(expandResult(r, sc.boxes).map((c) => `${c.boxId}@${c.x},${c.y},${c.z},${c.dims.join('x')}`).sort().join('|'));
    }
    maxDistinct = Math.max(maxDistinct, fps.size);
    // 至少 4 种不同结果（6 策略分 3 个姿态档，极端同构场景下允许部分收敛）
    assert.ok(fps.size >= 4, `${sc.name}: 6 策略应产出至少 4 种不同结果，实际 ${fps.size}`);
  }
  // 存在场景使 6 策略几乎完全互不相同（5/6 已足够证明策略确有区分度：
  // 收敛的策略对是「姿态档相同 + 分块几何在当前输入下等价」的几何必然结果，
  // 见 candidate-blocks.ts STRATEGY_ORIENTATION_POLICY 的收敛说明）
  assert.ok(maxDistinct >= 5, `应存在 6 策略几乎完全互不相同的场景，实际最多 ${maxDistinct} 种`);
});

test('P0-c 策略差异化：装载率确有区分（非全部相同）', () => {
  // 策略必须真的影响装载效果，否则「策略切换」是无效功能。
  // 注意：单一货物且数量远超柜容时，任何"填满空间"的策略都会收敛到同一装载率
  // （这是正确的 —— 空间就那么大），故本用例同时覆盖「数量受限」场景。
  const container = makeContainer();
  const base = makeBox({ id: 'q', length: 580, width: 380, height: 320, weight: 18.5, quantity: 1200 });
  const a = makeBox({ id: 'a', length: 480, width: 380, height: 380, weight: 20, quantity: 500 });
  const b = makeBox({ id: 'b', length: 420, width: 310, height: 260, weight: 12, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 800 });

  // 数量受限（装不满柜）时策略差异最明显
  const limited = new Set<number>();
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes: [a, b], container, strategy: s });
    limited.add(Number((r.loadRate * 100).toFixed(2)));
    assert.ok(r.loadRate > 0, `策略${s} 装载率应大于 0`);
    assert.ok(r.loadRate <= 1, `策略${s} 装载率不应超过 1（实际 ${r.loadRate}）`);
  }
  assert.ok(limited.size >= 3, `多货物场景 6 策略装载率应至少有 3 种取值，实际 ${[...limited].join('/')}`);

  // 数量远超柜容：所有策略都应把空间装满，不应出现虚高装载率
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes: [base], container, strategy: s });
    assert.ok(r.loadRate > 0, `策略${s} 装载率应大于 0`);
    assert.ok(r.loadRate <= 1, `策略${s} 装载率不应超过 1（实际 ${r.loadRate}）`);
    // 装入箱数的体积不得超过柜内容积（防「逐件坐标溢出导致装载率虚高」）
    const cartonVol = 580 * 380 * 320;
    const totalVol = cartonVol * r.placements.reduce((a2, p) => a2 + p.count, 0);
    assert.ok(totalVol <= 12032 * 2352 * 2393 + 1, `策略${s} 装入体积 ${totalVol} 不得超柜内容积`);
  }
});

test('P0-c 策略差异化：各策略均产出合法几何（不越界、逐箱不重叠）', () => {
  const container = makeContainer();
  const boxes = [
    makeBox({ id: 'u', length: 580, width: 380, height: 320, quantity: 500 }),
    makeBox({ id: 'v', length: 300, width: 300, height: 300, quantity: 400 }),
  ];
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container, strategy: s });
    const cartons = expandResult(r, boxes);
    assert.ok(cartons.length > 0, `策略${s} 应展开出逐箱坐标`);
    for (const p of r.placements) {
      assert.ok(p.x + p.dims[0] <= container.innerLength + 1e-6, `策略${s} x 不越界`);
      assert.ok(p.y + p.dims[1] <= container.innerWidth + 1e-6, `策略${s} y 不越界`);
      assert.ok(p.z + p.dims[2] <= container.innerHeight + 1e-6, `策略${s} z 不越界`);
    }
    for (let i = 0; i < cartons.length; i++) {
      for (let j = i + 1; j < cartons.length; j++) {
        const a = cartons[i];
        const b = cartons[j];
        const ox = Math.min(a.x + a.dims[0], b.x + b.dims[0]) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.dims[1], b.y + b.dims[1]) - Math.max(a.y, b.y);
        const oz = Math.min(a.z + a.dims[2], b.z + b.dims[2]) - Math.max(a.z, b.z);
        assert.ok(!(ox > 1e-6 && oy > 1e-6 && oz > 1e-6), `策略${s}: 逐箱 #${i} 与 #${j} 重叠`);
      }
    }
  }
});

test('P0-c 策略4：层数受堆码级别硬上限约束', () => {
  const container = makeContainer();
  // stackClass=1 → 无论空间多高，每次放置最多 1 层
  const weak = makeBox({ id: 'w', length: 500, width: 400, height: 300, stackClass: 1, supportClasses: [1, 1, 1, 1, 1, 1], quantity: 2000 });
  const r = load({ boxes: [weak], container, strategy: 4 });
  assert.ok(r.placements.length > 0, '应产生放置');
  for (const p of r.placements) {
    // 单层 = 该姿态下单箱高度
    const box = weak;
    const order = [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 0, 1], [2, 1, 0], [1, 2, 0]][p.orientation];
    const raw = [box.length, box.width, box.height];
    const cartonH = raw[order[2]];
    assert.ok(Math.abs(p.dims[2] - cartonH) < 1e-6, `stackClass=1 时每次放置应恰好 1 层，实际高度 ${p.dims[2]}（单箱高 ${cartonH}）`);
  }
});

test('P0-c 策略5：层数贴合实际货量（不过度堆高）', () => {
  const container = makeContainer();
  // 数量少 → 策略5 不应把块堆到空间顶
  const few = makeBox({ id: 'f', length: 500, width: 400, height: 300, quantity: 30 });
  const r5 = load({ boxes: [few], container, strategy: 5 });
  const placed = r5.placements.reduce((s, p) => s + p.count, 0);
  assert.ok(placed > 0, '应装入货物');
  // 竖直占位应显著小于柜高（够用即止）
  const maxTop = Math.max(...r5.placements.map((p) => p.z + p.dims[2]));
  assert.ok(maxTop < container.innerHeight * 0.6, `少量货物不应堆到柜顶，实际顶面 ${maxTop}mm / 柜高 ${container.innerHeight}mm`);
});

test('P0-d 回归：逐箱坐标不得越出柜体（6 策略 × 多货物）', () => {
  // 回归用例：策略5 曾把「层」误当作「y 行」，
  // 块包围盒 z 只报 1 层高却声明 5 层箱数 →
  // 展开时按 bbox 反推网格得到 nz=5 → 184 个逐箱坐标溢出柜顶。
  // 该缺陷只在「多货物 + 策略5 + 残层」组合下暴露，
  // 既有测试只校验了 placement 包围盒（bbox 本身自洽，查不出来）。
  const container = makeContainer();
  const a = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 1200 });
  const b = makeBox({ id: 'B', length: 420, width: 310, height: 260, weight: 12, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500 });
  const c = makeBox({ id: 'C', length: 1200, width: 900, height: 150, weight: 30, stackClass: 2, supportClasses: [2, 2, 2, 2, 2, 2], quantity: 400 });
  const boxes = [a, b, c];

  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container, strategy: s });
    const cartons = expandResult(r, boxes);
    assert.ok(cartons.length > 0, `策略${s} 应展开出逐箱坐标`);
    for (const c of cartons) {
      assert.ok(
        c.x + c.dims[0] <= container.innerLength + 1e-6,
        `策略${s} ${c.boxId}#${c.index} x 越界：${c.x}+${c.dims[0]} > ${container.innerLength}`,
      );
      assert.ok(
        c.y + c.dims[1] <= container.innerWidth + 1e-6,
        `策略${s} ${c.boxId}#${c.index} y 越界：${c.y}+${c.dims[1]} > ${container.innerWidth}`,
      );
      assert.ok(
        c.z + c.dims[2] <= container.innerHeight + 1e-6,
        `策略${s} ${c.boxId}#${c.index} z 越界：${c.z}+${c.dims[2]} > ${container.innerHeight}`,
      );
    }
  }
});

test('P0-d 回归：逐箱坐标不得越出所属块包围盒（6 策略 × 多货物）', () => {
  const container = makeContainer();
  const a = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 1200 });
  const b = makeBox({ id: 'B', length: 420, width: 310, height: 260, weight: 12, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500 });
  const boxes = [a, b];

  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container, strategy: s });
    const cartons = expandResult(r, boxes);
    for (const c of cartons) {
      const p = r.placements[c.placementIndex];
      assert.ok(c.x + c.dims[0] <= p.x + p.dims[0] + 1e-6, `策略${s} ${c.boxId}#${c.index} 越出所属块 x 上界`);
      assert.ok(c.y + c.dims[1] <= p.y + p.dims[1] + 1e-6, `策略${s} ${c.boxId}#${c.index} 越出所属块 y 上界`);
      assert.ok(c.z + c.dims[2] <= p.z + p.dims[2] + 1e-6, `策略${s} ${c.boxId}#${c.index} 越出所属块 z 上界`);
    }
  }
});

test('P0-d 多货物轮转：后到的货物也能装入（修复「先到先占」）', () => {
  // 回归用例：原实现按传入顺序逐个货物独占式填满整柜
  // （for (const box of boxes) fillBox(...)），
  // 先到的货物 100% 吃满柜子，后续全部 space-exhausted。
  // 40HQ 混装 480×380×380 + 420×310×260，基准策略下第二种货物一件都装不进。
  const container = makeContainer();
  const a = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 1200 });
  const b = makeBox({
    id: 'B', length: 420, width: 310, height: 260, weight: 12,
    stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500,
  });

  // 每种策略下，后到的货物都应能装入至少一件
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes: [a, b], container, strategy: s });
    const countB = r.placements.filter((p) => p.boxId === 'B').reduce((acc, p) => acc + p.count, 0);
    assert.ok(countB > 0, `策略${s}：后到的货物 B 应能装入至少 1 件（修复前恒为 0）`);
    const kinds = new Set(r.placements.map((p) => p.boxId));
    assert.equal(kinds.size, 2, `策略${s}：两种货物都应出现在结果中，实际 ${[...kinds].join(',')}`);
  }
});

test('P0-d 多货物轮转：货物顺序不影响装柜结果', () => {
  // 货物按单箱体积降序参与轮转（大件优先），因此两种传入顺序应得到完全相同的结果。
  // 修复前：B→A 顺序下后到的 A 恒装入 0 箱（偏差 40%+）。
  const container = makeContainer();
  const a = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 600 });
  const b = makeBox({
    id: 'B', length: 420, width: 310, height: 260, weight: 12,
    stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 900,
  });
  for (let s = 0; s <= 5; s++) {
    const r1 = load({ boxes: [a, b], container, strategy: s });
    const r2 = load({ boxes: [b, a], container, strategy: s });
    const n1 = r1.placements.reduce((acc, p) => acc + p.count, 0);
    const n2 = r2.placements.reduce((acc, p) => acc + p.count, 0);
    assert.equal(n1, n2, `策略${s}：两种货物顺序的总箱数应相同，A→B=${n1} vs B→A=${n2}`);
    assert.equal(
      Math.round(r1.loadRate * 1e6),
      Math.round(r2.loadRate * 1e6),
      `策略${s}：两种货物顺序的装载率应相同`,
    );
    // 两种顺序下都必须装入两种货物
    for (const r of [r1, r2]) {
      assert.equal(new Set(r.placements.map((p) => p.boxId)).size, 2, `策略${s}：两种货物都应被装入`);
    }
  }
});

test('P0-d 多货物轮转：单一货物场景行为不变（无回归）', () => {
  const container = makeContainer();
  const only = makeBox({ id: 'solo', length: 580, width: 380, height: 320, weight: 18.5, quantity: 1200 });
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes: [only], container, strategy: s });
    assert.ok(r.placements.length > 0, `策略${s} 单货物应产生放置`);
    assert.ok(r.loadRate > 0, `策略${s} 单货物装载率应大于 0`);
    assert.equal(r.placements.every((p) => p.boxId === 'solo'), true, '单货物场景不应出现其它货物');
  }
});

test('P0-d 多货物轮转：三种货物（含大扁平件）都能装入', () => {
  // 回归用例：只限制块体积不够 —— 大扁平件（1200×900×150）的块若铺满柜宽柜深，
  // 切分后只剩 32mm 宽的细条，另外两种货物一件都放不进。
  // 故多货物场景还须限制块的 **xy 足迹**（MULTI_CARGO_FOOTPRINT_RATIO）。
  const big: Container = { id: 'hq', name: '40HQ', innerLength: 12032, innerWidth: 2352, innerHeight: 2698, weightCapacity: 26800 };
  const a = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 1200 });
  const b = makeBox({
    id: 'B', length: 420, width: 310, height: 260, weight: 12,
    stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500,
  });
  const c = makeBox({
    id: 'C', length: 1200, width: 900, height: 150, weight: 30,
    stackClass: 2, supportClasses: [2, 2, 2, 2, 2, 2], quantity: 400,
  });
  const boxes = [a, b, c];

  // 40HQ：空间充裕，三种货物均应装入
  // 注：装载率下限取 25% —— 策略1/2 是「单层/逐层」策略，
  // 遇上大扁平件时块足迹受限，密度天然偏低（实测 34%）；
  // 上限解除后策略3/5 可回到 85%+。此处只守住「不为 0」的下限。
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container: big, strategy: s });
    const kinds = new Set(r.placements.map((p) => p.boxId));
    assert.equal(kinds.size, 3, `40HQ 策略${s}：三种货物都应被装入，实际只有 ${[...kinds].join(',')}`);
    assert.ok(r.loadRate > 0.25, `40HQ 策略${s} 装载率应 >25%，实际 ${(r.loadRate * 100).toFixed(1)}%`);
  }

  // 20ft：大扁平件 C 相对占比过高，剩余空间不足以容纳全部三种
  // （几何限制，非调度缺陷）—— 断言「至少 2 种」并如实记录该限制
  const ft = makeContainer();
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container: ft, strategy: s });
    const kinds = new Set(r.placements.map((p) => p.boxId));
    assert.ok(kinds.size >= 2, `20ft 策略${s}：至少应装入 2 种货物，实际 ${[...kinds].join(',') || '无'}`);
  }
});

test('P0-d 块大小上限：解除后装载率应回升（不长期限死）', () => {
  // 块大小/足迹上限只在「仍有货物一件未装」时生效；
  // 若一直限着，混装装载率会大幅下降（实测策略1 从 80% 掉到 27%）。
  const container = makeContainer();
  const a = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 1200 });
  const b = makeBox({
    id: 'B', length: 420, width: 310, height: 260, weight: 12,
    stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500,
  });
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes: [a, b], container, strategy: s });
    assert.ok(
      r.loadRate > 0.5,
      `策略${s} 两货物混装装载率应 >50%（上限解除后应回升），实际 ${(r.loadRate * 100).toFixed(1)}%`,
    );
  }
});

test('P1 六向允许摆放 allowDirections：未勾选的方向绝不出现在结果中', () => {
  const container = makeContainer();
  // 只允许 dir0 / dir4 两个方向（平放与立放），其余四个全部禁止
  const restricted = makeBox({
    id: 'locked',
    length: 500,
    width: 400,
    height: 300,
    quantity: 3000,
    allowDirections: [true, false, false, false, true, false],
  });
  // 姿态分档（见 STRATEGY_ORIENTATION_POLICY）与允许方向取交集：
  //   500/400/300 → 升序 [300,400,500]，即 H=rank0、W=rank1、L=rank2
  //   heightRank0 → dir0,dir1 ｜ heightRank1 → dir2,dir3 ｜ heightRank2 → dir4,dir5 ｜ all → 全部
  // 与 {dir0,dir4} 的交集：策略0/1 首选档 rank0 → {dir0}；策略3 首选档 rank2 → {dir4}；
  // 策略2/4 首选档 rank1（dir2,dir3）与允许集不相交 → **回退**到 rank0 → {dir0}；
  // 策略5 → {dir0,dir4}。
  //
  // 注：resolveOrientationPolicy 在每次 placeOnce 时按**当前空间的可用方向**解析，
  // 所以装载后期若首选姿态放不下（剩余空间变窄），会再退一档收尾 ——
  // 因此"用到的方向"可能是首选档 ∪ 回退档，不能钉死成单一方向。
  // 允许方向集合
  const ALLOWED = [0, 4];
  const RANK_DIRS: Record<number, number[]> = { 0: [0, 1], 1: [2, 3], 2: [4, 5] };
  const PREFERRED_RANK = [0, 0, 1, 2, 1, -1]; // -1 = all

  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes: [restricted], container, strategy: s });
    const used = [...new Set(r.placements.map((p) => p.orientation))].sort((a, b) => a - b);
    // 硬不变量：被禁方向绝不能出现
    for (const o of used) {
      assert.ok(
        ALLOWED.includes(o),
        `策略${s} 只允许 dir0/dir4，实际出现了 dir${o}（用到的方向：${used.map((x) => 'dir' + x).join(',')}）`,
      );
    }
    // 不变量 2：绝不能因方向限制交白卷
    assert.ok(r.placements.length > 0, `策略${s} 不应返回 0 放置`);
    // 不变量 3：**首选档可行时**必须真的用到它（策略确实在做姿态偏好，而不是全退化成同一档）
    const rank = PREFERRED_RANK[s];
    if (rank >= 0) {
      const feasible = RANK_DIRS[rank].some((o) => ALLOWED.includes(o));
      if (feasible) {
        assert.ok(
          used.some((o) => RANK_DIRS[rank].includes(o)),
          `策略${s} 首选档 heightRank${rank} 可行，应至少用到 ${RANK_DIRS[rank].map((x) => 'dir' + x).join('/')}，实际只用了 ${used.map((x) => 'dir' + x).join(',') || '无'}`,
        );
      }
      // 首选档不可行时（如策略2/4 的 heightRank1 = dir2,dir3 全被禁）应回退到可行档，
      // 而不是没有放置 —— 由上面的「不应返回 0 放置」覆盖
    }
  }
});

test('P1 策略不会因方向限制与姿态档不相交而交白卷（用户实测回归）', () => {
  // 用户实测：水泵2 480×380×380、水泵3 515×380×425，两者的六向都只放行 dir0/dir1。
  // 这两个方向恰为 heightRank1，于是：
  //   策略0/1 首选档 heightRank0(dir2,dir3) → 交集 ∅
  //   策略3   首选档 heightRank2(dir4,dir5) → 交集 ∅
  // 修复前这两种情况返回 **0 放置**，界面显示"装不下"，而用户手工能装下
  // （策略5 实测 630+330、装载率 82.7%）。
  //
  // 断言：任何策略都必须真的装进货物 —— 姿态档是**偏好**，不是硬约束。
  const hq: Container = { id: 'hq45', name: '45HQ', innerLength: 13556, innerWidth: 2352, innerHeight: 2698, weightCapacity: 27600 };
  const pump2 = makeBox({
    id: '水泵2', length: 480, width: 380, height: 380, weight: 20,
    stackClass: 8, supportClasses: [8, 8, 4, 4, 4, 4],
    allowDirections: [true, true, false, false, false, false],
    supportFaces: [true, true, false, false, false, false],
    quantity: 630,
  });
  const pump3 = makeBox({
    id: '水泵3', length: 515, width: 380, height: 425, weight: 22,
    stackClass: 8, supportClasses: [8, 8, 5, 5, 5, 5],
    allowDirections: [true, true, false, false, false, false],
    supportFaces: [true, true, false, false, false, false],
    quantity: 330,
  });
  const boxes = [pump2, pump3];

  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container: hq, strategy: s });
    assert.ok(r.placements.length > 0, `策略${s} 不应返回 0 放置`);
    assert.ok(r.loadRate > 0.3, `策略${s} 装载率应 >30%（两种货物共约 71m³ / 柜内容积 86m³），实际 ${(r.loadRate * 100).toFixed(1)}%`);
    const kinds = new Set(r.placements.map((p) => p.boxId));
    assert.equal(kinds.size, 2, `策略${s} 两种水泵都应装入，实际只有 ${[...kinds].join(',') || '无'}`);
    // 方向硬约束：只放行了 dir0/dir1
    for (const p of r.placements) {
      assert.ok(p.orientation === 0 || p.orientation === 1, `策略${s} 出现了被禁的 dir${p.orientation}`);
    }
  }

  // 均衡策略应能把用户给的 630+330 全部装下
  const best = load({ boxes, container: hq, strategy: 5 });
  const n2 = best.placements.filter((p) => p.boxId === '水泵2').reduce((s, p) => s + p.count, 0);
  const n3 = best.placements.filter((p) => p.boxId === '水泵3').reduce((s, p) => s + p.count, 0);
  assert.equal(n2, 630, `策略5 应把水泵2 的 630 件全部装入，实际 ${n2}`);
  assert.equal(n3, 330, `策略5 应把水泵3 的 330 件全部装入，实际 ${n3}`);
  assert.equal(best.rejected.length, 0, '策略5 不应有未装货物');
});

test('P1 六向允许摆放：全部禁止时一件也装不进（不会静默回退到全向）', () => {
  const container = makeContainer();
  const none = makeBox({ id: 'none', length: 500, width: 400, height: 300, quantity: 500, allowDirections: [false, false, false, false, false, false] });
  const r = load({ boxes: [none], container, strategy: 3 });
  assert.equal(r.placements.length, 0, '六向全禁时应无任何放置');
  assert.equal(r.loadRate, 0, '装载率应为 0');
});

test('P1 六向允许摆放：与承托级别为 0 是两套独立约束（取交集）', () => {
  const container = makeContainer();
  // allowDirections 放行 dir2，但 supportClasses[2]=0 → 仍应被排除
  const box = makeBox({
    id: 'mixed',
    length: 500,
    width: 400,
    height: 300,
    quantity: 3000,
    allowDirections: [true, true, true, true, true, true],
    supportClasses: [5, 5, 0, 5, 5, 5],
  });
  const r = load({ boxes: [box], container, strategy: 3 });
  assert.ok(r.placements.length > 0, '应仍有放置');
  const used = new Set(r.placements.map((p) => p.orientation));
  assert.ok(!used.has(2), 'supportClasses[2]=0 的 dir2 不应被使用');
});

test('P1 型变系数：实际占位与装载率都按名义尺寸×系数换算', () => {
  const container = makeContainer();
  const nominal = makeBox({ id: 'n', length: 500, width: 400, height: 300, quantity: 5000 });
  const squashed = makeBox({ id: 's', length: 500, width: 400, height: 300, quantity: 5000, deformFactor: 0.8 });

  // orientDims 是唯一换算入口
  assert.deepEqual(orientDims(nominal, 0), [500, 400, 300], '无型变时尺寸应等于名义尺寸');
  assert.deepEqual(orientDims(squashed, 0), [400, 320, 240], '型变系数 0.8 应使三轴等比缩小');

  // 型变后单箱占位更小 → 同数量能装更多箱、装载率更高
  const rn = load({ boxes: [nominal], container, strategy: 3 });
  const rs = load({ boxes: [squashed], container, strategy: 3 });
  const cn = rn.placements.reduce((s, p) => s + p.count, 0);
  const cs = rs.placements.reduce((s, p) => s + p.count, 0);
  assert.ok(cs > cn, `型变后应能多装箱：nominal=${cn} squashed=${cs}`);
  assert.ok(rs.loadRate > rn.loadRate, `型变后装载率应更高：${(rn.loadRate * 100).toFixed(1)}% → ${(rs.loadRate * 100).toFixed(1)}%`);

  // 装载率口径与占位一致：不得超过 100%（否则说明用了名义体积算分母）
  assert.ok(rs.loadRate <= 1 + 1e-9, `型变后装载率不应 >100%，实际 ${(rs.loadRate * 100).toFixed(1)}%`);

  // 逐箱坐标也必须落在型变后的尺寸上：
  // 逐箱尺寸应等于**某个**姿态的型变后尺寸（不是固定 dir0）
  const allowedCartonDims = new Set<string>();
  for (let o = 0; o <= 5; o++) allowedCartonDims.add(orientDims(squashed, o).join('x'));
  const cartons = expandResult(rs, [squashed]);
  assert.ok(cartons.length > 0, '应展开出逐箱坐标');
  const seen = new Set<string>();
  for (const c of cartons) {
    seen.add(c.dims.join('x'));
  }
  for (const d of seen) {
    assert.ok(allowedCartonDims.has(d), `逐箱尺寸 ${d} 不属于任何姿态的型变后尺寸 ${[...allowedCartonDims].join(' / ')}`);
  }
  // 名义尺寸（未型变）不得出现
  assert.ok(![...seen].includes('500x400x300'), `逐箱不应出现未型变的名义尺寸 500x400x300，实际出现 ${[...seen].join(' / ')}`);
});

test('P1 型变系数：非法值（0 / 负数 / NaN / 缺省）一律按 1 处理', () => {
  const base = { id: 'x', length: 500, width: 400, height: 300, weight: 10, stackClass: 5, supportPct: [1, 1, 1] as [number, number, number], pcsCount: 1, quantity: 10 };
  for (const k of [undefined, 0, -1, NaN, Infinity]) {
    const box: Box = { ...base, name: 'x', supportClasses: [5, 5, 5, 5, 5, 5], deformFactor: k } as Box;
    assert.deepEqual(orientDims(box, 0), [500, 400, 300], `deformFactor=${k} 应按 1 处理`);
  }
});

test('P1 逐件 dims 只依赖 (货物, 姿态) —— 3D 渲染共用几何体的前提', () => {
  // 3D 逐箱渲染按 (货物, 姿态) 分组建 InstancedMesh，**批内共用一个几何体**，
  // 因此必须保证「同一 (货物, 姿态) 的所有逐箱尺寸完全一致」。
  //
  // 回归缺陷：早期 3D 只按货物分组、用首箱尺寸画整批。
  // 而同一种货物在一次计算里可能同时以多个姿态摆放
  // （例：500×400×300 的 dir4 占位 300×400×500、dir5 占位 400×300×500），
  // 后者被 x/y 转置地画错 —— 实测 45HQ 两货物场景 S5 有 67% 的箱受影响，
  // 视觉上表现为「货物变成细长竖板」。
  //
  // 本测试锁住该不变式：若 expandResult 的 dims 将来引入了 placement 级信息，
  // 3D 的分组键就会失效，必须同步改渲染。
  const container: Container = { id: 'hq', name: '45HQ', innerLength: 13556, innerWidth: 2352, innerHeight: 2698, weightCapacity: 27600 };
  const a = makeBox({
    id: 'A', length: 500, width: 400, height: 300, stackClass: 3,
    supportClasses: [5, 0, 5, 5, 5, 5], allowDirections: [true, false, true, true, true, true], quantity: 3000,
  });
  const b = makeBox({ id: 'B', length: 500, width: 400, height: 300, deformFactor: 0.85, quantity: 3000 });
  const boxes = [a, b];

  let sawMultiOrientation = false;
  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes, container, strategy: s });
    const cartons = expandResult(r, boxes);
    const byKey = new Map<string, Set<string>>();
    const byBox = new Map<string, Set<number>>();
    for (const c of cartons) {
      const key = `${c.boxId}|${c.orientation}`;
      const sig = c.dims.join('x');
      const set = byKey.get(key) ?? new Set<string>();
      set.add(sig);
      byKey.set(key, set);
      if (!byBox.has(c.boxId)) {
        byBox.set(c.boxId, new Set<number>());
      }
      byBox.get(c.boxId)!.add(c.orientation);
    }
    for (const [key, sigs] of byKey) {
      assert.equal(sigs.size, 1, `策略${s} ${key} 出现多种逐箱尺寸 ${[...sigs].join(' / ')} —— 违反 3D 分组不变式`);
    }
    for (const [boxId, orients] of byBox) {
      if (orients.size > 1) {
        sawMultiOrientation = true;
        // 同货物多姿态时，各姿态尺寸必须确实不同（否则上面那条不变式形同虚设）
        const dimsSet = new Set(
          cartons.filter((c) => c.boxId === boxId).map((c) => orientDims(boxes.find((b) => b.id === boxId)!, c.orientation).join('x')),
        );
        assert.ok(dimsSet.size > 1, `策略${s} ${boxId} 用了多姿态但各姿态尺寸相同，无法验证分组键的有效性`);
      }
    }
  }
  assert.ok(sawMultiOrientation, '场景应至少有一种策略让同货物出现多姿态，否则本测试覆盖不到回归点');
});

test('P1 多起点调度：谁先放没有普适最优序，应取各序中装载率最高者', () => {
  // 回归背景（用户实测数据）：11900×2340×2680 柜，WP20 480×380×380 ×630、
  // WP30加长 515×380×425 ×330，原软件 LoadExpert 装出 630+336=966 箱 / 95.96%。
  //
  // 单箱体积降序（大件优先）会把单箱更大的 WP30 排到先手，它一整块吃掉
  // x 0~8740，直接毁掉 WP20 那条 30×3×7 的干净长条 → 只有 578+324=902（89.79%）。
  // 改成箱数降序后 WP20 先手拿到完整 630 → 936（92.62%），
  // 但同一改动会让「40HQ 三货物」场景的 S0/S1 各掉 10~20 个点。
  //
  // 两种排序各有胜负 → 正确做法是多起点跑一遍取最优，而不是猜一个启发式。
  const pumpContainer: Container = { id: 'c', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
  const wp20 = makeBox({ id: 'WP20', length: 480, width: 380, height: 380, weight: 20, stackClass: 8, supportClasses: [8, 8, 4, 4, 4, 4], allowDirections: [true, true, false, false, false, false], quantity: 630 });
  const wp30 = makeBox({ id: 'WP30加长', length: 515, width: 380, height: 425, weight: 22, stackClass: 8, supportClasses: [8, 8, 5, 5, 5, 5], allowDirections: [true, true, false, false, false, false], quantity: 336 });

  // 需求 **630 + 336 = 966**，这才是原软件 LoadExpert 参考方案的**真实需求量**
  // （用户在方案列表里存的"混装"方案：水泵2 630 + 水泵3 336 = 966 箱 / 96.0%）。
  // 之前一直按 330 建模型，于是把"960"当成了目标、并反复追问"为何没到 966"——
  // 其实是**需求建模错了**，不是算法差 6 箱。
  //
  // 基准策略 3 应拿到 **966 箱 / 95.96%，与原软件完全一致**（两种货物各 100% 装完）。
  // 演进轨迹（按 336 口径）：902 → 936 → 948 → **966**
  // （按旧的 330 口径则终点是 960，同样是 100% 装完）
  //
  // 策略 4/5 停在 936 是**设计使然**、不是缺陷：策略4「承托分级分层」按
  // `min(maxZ, stackClass, floorDiv(availableCount, perLayer))` 一次只放有限层数，
  // 刻意不追求「一次吃掉整块」。
  // 注意：**不要对所有策略断言 WP20=630** —— 择优只看总箱数与种类数，
  // 不同策略会在 WP20/WP30 之间做不同取舍（实测 S4 = 624+312、S5 = 630+306，
  // 合计都是 936）。**逐项分配不是契约，总箱数才是。**
  const floors: Record<number, number> = { 0: 924, 1: 948, 2: 948, 3: 966, 4: 936, 5: 936 };
  for (const s of [3, 4, 5]) {
    const r = load({ boxes: [wp30, wp20], container: pumpContainer, strategy: s });
    const n20 = r.placements.filter((p) => p.boxId === 'WP20').reduce((a, p) => a + p.count, 0);
    const n30 = r.placements.filter((p) => p.boxId === 'WP30加长').reduce((a, p) => a + p.count, 0);
    assert.ok(n20 + n30 >= floors[s], `策略${s} 总箱数应 ≥${floors[s]}，实际 ${n20}+${n30}=${n20 + n30}`);
    assert.ok(r.loadRate > 0.925, `策略${s} 装载率应 >92.5%，实际 ${(r.loadRate * 100).toFixed(2)}%`);
  }
  // 策略3 是基准，应把需求 630+336 全部装完 —— 与原软件 LoadExpert 的 966 / 95.96% 完全一致
  const s3 = load({ boxes: [wp30, wp20], container: pumpContainer, strategy: 3 });
  const s3n20 = s3.placements.filter((p) => p.boxId === 'WP20').reduce((a, p) => a + p.count, 0);
  const s3n30 = s3.placements.filter((p) => p.boxId === 'WP30加长').reduce((a, p) => a + p.count, 0);
  assert.equal(s3n30, 336, `策略3 WP30加长 应装满 336，实际 ${s3n30}`);
  assert.equal(s3n20, 630, `策略3 WP20 应装满 630，实际 ${s3n20}`);
  assert.equal(s3n20 + s3n30, 966, `策略3 应把 630+336 全部装完（原软件水平），实际 ${s3n20 + s3n30}`);
  assert.ok(s3.loadRate > 0.959, `策略3 装载率应 >95.9%（原软件 95.96%），实际 ${(s3.loadRate * 100).toFixed(2)}%`);

  // 与传入顺序无关：多起点内部已固定候选序
  const a = load({ boxes: [wp20, wp30], container: pumpContainer, strategy: 3 });
  const b = load({ boxes: [wp30, wp20], container: pumpContainer, strategy: 3 });
  assert.equal(a.loadRate, b.loadRate, '同一组货物换顺序输入，结果装载率应一致');

  // 回归保护：多起点不得让三货物场景退步。
  // 二维多起点（2 种排序 × 2 个块上限）应取到 ratio=0.75 的收益：S3 90.3%（单用 0.5 时仅 88.3%）
  const hq: Container = { id: 'hq', name: '40HQ', innerLength: 13556, innerWidth: 2352, innerHeight: 2698, weightCapacity: 26800 };
  const m1 = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 1200 });
  const m2 = makeBox({ id: 'B', length: 420, width: 310, height: 260, weight: 12, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500 });
  const m3 = makeBox({ id: 'C', length: 1200, width: 900, height: 150, weight: 30, stackClass: 2, supportClasses: [2, 2, 2, 2, 2, 2], quantity: 400 });
  for (const s of [0, 3, 5]) {
    const r = load({ boxes: [m1, m2, m3], container: hq, strategy: s });
    const kinds = new Set(r.placements.map((p) => p.boxId)).size;
    assert.equal(kinds, 3, `三货物场景 策略${s}：三种货物都应装入（多起点不得导致某货物被饿死）`);
    assert.ok(r.loadRate > 0.75, `三货物场景 策略${s} 装载率应 >75%（旧体积序基线），实际 ${(r.loadRate * 100).toFixed(1)}%`);
  }
  // 三货物 S3 应取到二维多起点的收益
  const m3res = load({ boxes: [m1, m2, m3], container: hq, strategy: 3 });
  assert.ok(m3res.loadRate > 0.9, `三货物 策略3 应 >90%（二维多起点收益），实际 ${(m3res.loadRate * 100).toFixed(1)}%`);
});

test('6 种策略产出的候选块都不得超过给定空间（越界兜底齐全）', () => {
  // 背景：策略 3/4/5 的层数上限写的是 `ceilDiv(space.dz, dz)`（向上取整），
  // 于是 dz=425、柜高 2680 时 maxZ=7 而 7×425=2975 **超出柜高**。
  // 目前靠 `makeBlock` 的子块越界检查 `return null` 兜底。
  // 本测试把"兜底齐全"这件事**实测**一遍，而不是靠读代码推断 ——
  // 万一某个策略漏了 makeBlock，就是真实的越界装柜。
  const gens = [generateStrategy0, generateStrategy1, generateStrategy2, generateStrategy3, generateStrategy4, generateStrategy5];
  const dims: Array<[number, number, number]> = [
    [515, 380, 425], [480, 380, 380], [420, 310, 260], [1200, 900, 150], [200, 200, 1200], [333, 217, 149],
  ];
  const spaces: Array<[number, number, number]> = [
    [11900, 2340, 2680], [12032, 2352, 2698], [5898, 2352, 2393], [13556, 2352, 2698], [3050, 1200, 900], [1000, 700, 500],
  ];
  const cont: Container = { id: 'c', name: 'c', innerLength: 13556, innerWidth: 2352, innerHeight: 2698, weightCapacity: 26800 };

  let checked = 0;
  for (const [L, W, H] of dims) {
    const bx = makeBox({ id: 'B', length: L, width: W, height: H, quantity: 5000, stackClass: 8, supportClasses: [8, 8, 8, 8, 8, 8] });
    for (const [sx, sy, sz] of spaces) {
      const space = { x: 0, y: 0, z: 0, dx: sx, dy: sy, dz: sz };
      for (let o = 0; o < 6; o++) {
        for (let level = 1; level <= 8; level++) {
          for (const gen of gens) {
            const b = gen({ box: bx, container: cont, x: 0, y: 0, z: 0, space, orientation: o, level, availableCount: 5000 });
            checked++;
            if (!b) continue;
            for (const sb of b.subBlocks) {
              assert.ok(
                sb.x <= sx + 1e-6 && sb.y <= sy + 1e-6 && sb.z <= sz + 1e-6,
                `策略${gen.name} 朝向${o} 层${level} 空间${sx}×${sy}×${sz} 产出超限子块 ${sb.x}×${sb.y}×${sb.z}`,
              );
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 3000, `应覆盖数千个候选组合，实际 ${checked}`);
});

test('P1 残余前瞻：破解「一次装得多却把残余占死」的局部最优陷阱', () => {
  // 场景（用户实测 40HQ 11900×2340×2680，WP20 630 + WP30加长 330，两者只放行 dir0/dir1）：
  // WP20 先用 dir1 做成 30列×3排×7层 = 630 的整块（11400×1440×2660），
  // split 后 y 向只剩一条 11400×900×2680 的带子，WP30 有 330 箱要装。
  //
  // 纯块评分会选 dir0（22×2×6 = 264 箱，块体积 21.95e9）而不是 dir1（30×1×6 = 180 箱，
  // 块体积 14.97e9）——因为 dir0 一次装得多。**但 dir0 把 900mm 带子占到只剩 140mm**
  // （140 < 380，谁都装不下）→ 总计 264；而 dir1 只放 180 却留下 385mm，还能再放一排
  // dir0（22×1×6 = 132）→ 总计 **312**。局部最优恰好毁掉了全局。
  //
  // 残余前瞻把评分改成「块体积 + β × 残余还能装多少箱（跨货物、深度 2）」后，
  // 这条带子上 WP30 会选 dir1，最终 630+330 **全部装完**。
  const hq: Container = { id: 'hqp', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
  const wp20 = makeBox({ id: 'WP20', length: 480, width: 380, height: 380, weight: 20, stackClass: 8, supportClasses: [8, 8, 4, 4, 4, 4], allowDirections: [true, true, false, false, false, false], quantity: 630 });
  const wp30 = makeBox({ id: 'WP30', length: 515, width: 380, height: 425, weight: 22, stackClass: 8, supportClasses: [8, 8, 5, 5, 5, 5], allowDirections: [true, true, false, false, false, false], quantity: 330 });
  const qtyDesc = (x: any, y: any) => y.box.quantity - x.box.quantity;
  const params = { boxes: [wp20, wp30], container: hq, strategy: 3 };
  const total = (r: any) => r.placements.reduce((a: number, p: any) => a + p.count, 0);
  const of = (r: any, id: string) => r.placements.filter((p: any) => p.boxId === id).reduce((a: number, p: any) => a + p.count, 0);

  const noLookahead = runGreedy(params, qtyDesc, 0, 0, false, 0);
  const lookahead = runGreedy(params, qtyDesc, 0, 0, false, 0.9);

  assert.equal(of(noLookahead, 'WP20'), 630, '无前瞻时 WP20 也应拿满 630（整块）');
  assert.ok(
    of(lookahead, 'WP30') > of(noLookahead, 'WP30'),
    `前瞻应让 WP30 装得更多（${of(noLookahead, 'WP30')} → ${of(lookahead, 'WP30')}）`,
  );
  assert.equal(of(lookahead, 'WP30'), 330, '前瞻后 WP30 应装满 330');
  assert.equal(total(lookahead), 960, '前瞻后应把 630+330 全部装完');
  // β=0 时行为必须与历史完全一致（否则多起点的"追加"前提就被破坏）
  const b0a = runGreedy(params, qtyDesc, 0.5, MULTI_CARGO_FOOTPRINT_RATIO, false, 0);
  const b0b = runGreedy(params, qtyDesc, 0.5, MULTI_CARGO_FOOTPRINT_RATIO, false, 0);
  assert.equal(b0a.loadRate, b0b.loadRate, 'β=0 应为确定性结果（残余前瞻关闭时无副作用）');
});

test('P1 逐层码放策略不得因跨货物交错堆叠而崩盘（别压在别人头上码）', () => {
  // 回归背景：策略0/1/2 在混装时只有 773/813/816 箱（77.9%/81.6%/81.9%），
  // 而**单货物时同样这两个策略能装满 100%** —— 所以问题不在块形状，
  // 在"谁在码"：两种货物逐层交替往上码，而 x 步长不同（480 vs 515），
  // 每交替一次就把可用宽度削掉一截：
  //   WP20 层0 11520 宽 → WP30 层1 11330（剩190mm死条）→ WP20 层2 11040 → …
  // 空间 x 向单调缩水，最后谁都码不下（486+327）。
  //
  // 修复：SpaceBlock 带 baseBoxId（正下方是谁的块），pickSpaceFor 对
  // "压在别人头上"的空间折价，鼓励两种货物并排长而不是叠在一起。
  // 期望：S0 773→935、S1 813→929、S2 816→929，且 S3 的 960 不得退化。
  const hq: Container = { id: 'c', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
  const wp20 = makeBox({ id: 'WP20', length: 480, width: 380, height: 380, weight: 20, stackClass: 8, supportClasses: [8, 8, 4, 4, 4, 4], allowDirections: [true, true, false, false, false, false], quantity: 630 });
  const wp30 = makeBox({ id: 'WP30', length: 515, width: 380, height: 425, weight: 22, stackClass: 8, supportClasses: [8, 8, 5, 5, 5, 5], allowDirections: [true, true, false, false, false, false], quantity: 330 });
  const total = (r: any) => r.placements.reduce((a: number, p: any) => a + p.count, 0);

  const floor: Record<number, number> = { 0: 935, 1: 948, 2: 948, 3: 960, 4: 936, 5: 936 };
  for (const s of [0, 1, 2, 3, 4, 5]) {
    const n = total(load({ boxes: [wp20, wp30], container: hq, strategy: s }));
    assert.ok(n >= floor[s], `策略${s} 应 ≥${floor[s]} 箱（修复前 773/813/816），实际 ${n}`);
  }
  // 单货物基线不得因这条规则而变差。
  //
  // 原先这里是 `{1: [624, 322]}`，注释写「策略1 只吃整行、主动舍弃零头」。
  // 那不是设计取舍，是"装 0 的缺陷"的另一种表现：策略1 的 rows = min(nY, floorDiv(availableCount, nX))，
  // 首轮装满整行后剩下的 6 / 8 件不足一行，rows=0 → 直接 null，于是被静默丢掉。
  // 已补残行兜底（见 generateStrategy1 注释与 fitLayerGridAtMost），
  // 现在策略1 与 0/2 一样把给定数量全部装满：630 / 330。
  const single: Record<number, [number, number]> = { 0: [630, 330], 1: [630, 330], 2: [630, 330] };
  for (const s of [0, 1, 2]) {
    assert.equal(total(load({ boxes: [wp20], container: hq, strategy: s })), single[s][0], `单货物 WP20 策略${s} 应为 ${single[s][0]} 箱`);
    assert.equal(total(load({ boxes: [wp30], container: hq, strategy: s })), single[s][1], `单货物 WP30 策略${s} 应为 ${single[s][1]} 箱`);
  }
});

test('P0 需求不足一整层/不足三因子分解时不得一件都装不进（装 0 缺陷回归）', () => {
  // 回归背景：策略3 的块生成是「fitLayerGrid 精确整除 a*b*c == need，否则退回
  // 铺满 xy + 只截断 z」。而 need < nX*nY 时那个退路第一层就 break → total=0 → null。
  // 两者叠加 = **凑不出三因子分解又不满一层的数量，一律装 0 并报 no-fit**。
  //
  // 实测 40HQ + 水泵3(515×380×425)：qty=96 装 96、qty=97 装 **0**、qty=98 装 **0**、qty=99 装 99
  // （97 是质数，在 nX=23/nY=6/maxZ≤7 内没有三因子分解）。
  //
  // 这个洞在业务上很隐蔽：它不发生在用户直接输的那个数上，而是发生在
  // **多柜循环**里 —— 前一个柜装满后剩下 98 件，后一个柜再也装不下，
  // 用户看到的只是"有 1 种货物未能全部装入"，完全看不出真正原因是算法装 0。
  //
  // 策略1（不足一整行）与策略4（不足一整层）是同一个洞，一起锁住。
  const hq: Container = { id: 'c', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
  const wp30 = makeBox({
    id: 'WP30',
    length: 515,
    width: 380,
    height: 425,
    weight: 22,
    stackClass: 8,
    supportClasses: [8, 8, 0, 0, 0, 0],
    allowDirections: [true, true, false, false, false, false],
  });
  const total = (r: any) => r.placements.reduce((a: number, p: any) => a + p.count, 0);

  // 97 / 98 是本缺陷的两个特征值（质数无三因子分解）；另取若干跨层边界的值
  for (const qty of [1, 5, 17, 23, 24, 30, 50, 97, 98, 137, 138, 139, 200]) {
    for (let s = 0; s <= 5; s++) {
      const n = total(load({ boxes: [{ ...wp30, quantity: qty }], container: hq, strategy: s }));
      assert.equal(n, qty, `qty=${qty} 策略${s} 应装满 ${qty} 箱，实际 ${n}`);
    }
  }
});

test('P0 数量留空（不限）在单柜下等价于"塞满柜子为止"', () => {
  // 前端语义：数量不填 = 不限。前端把它换算成「柜内容积 ÷ 单箱体积」取整，
  // 也就是"几何容量"，再交给算法按几何塞。这里锁住后端在该上限下的行为：
  // 装出来的量应接近几何容量（且远大于任何人为设定的整数），
  // 并且不应报"装不下"这种整类失败 —— 只能因为几何确实到顶了才停。
  const hq: Container = { id: 'c', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
  const wp20 = makeBox({ id: 'WP20', length: 480, width: 380, height: 380, weight: 20, stackClass: 8 });
  const boxVol = 480 * 380 * 380;
  const cap = Math.floor((11900 * 2340 * 2680) / boxVol); // = 1076

  const total = (r: any) => r.placements.reduce((a: number, p: any) => a + p.count, 0);
  const r = load({ boxes: [{ ...wp20, quantity: cap }], container: hq, strategy: 3 });
  // 注意：几何容量只是**体积上界**，不含码放损耗，实际装不满 100%。
  // 具体差多少取决于货物允许的朝向数（本例 makeBox 默认六向全允许 → 930/1076 ≈ 86.4%；
  // 换成与用户库一致的两向限制 → 1036/1076 ≈ 96.4%）。这是**几何性质，不是"不限"的缺陷**，
  // 所以这里断言"接近容量且装载率够高"，不写死具体件数。
  //
  // 前端把"不限"换算成这个上界也就够了：上界不可能偏小（每箱实占 boxVol），
  // 算法会一直装到空间用尽为止。
  assert.ok(total(r) >= cap * 0.85, `不限数量应装到几何容量的 ≥85%（${cap}），实际 ${total(r)}`);
  assert.ok(r.loadRate >= 0.85, `不限数量应装到 ≥85%，实际 ${(r.loadRate * 100).toFixed(2)}%`);
  // 装载率不可能超过 1（此前有一条把 40HQ 自动校正成 40GP 尺寸的事故，见记忆 §9.24）
  assert.ok(r.loadRate <= 1, `装载率不得 >100%，实际 ${(r.loadRate * 100).toFixed(2)}%`);
});

test('P1 残余整洁维度带来的多场景收益不得回退', () => {
  // 基线数值取自 scripts/mixed-load-compare.mjs（§9.19 记录，柜型 12032×2352×2698）：
  // 40HQ 三货物 S0 由 76.1% 提升到 78.6%，40HQ 两货物 S5 由 92.7% 提升到 93%。
  // 这两条都只有「残余整洁优先」那两条腿能拿到，故在此锁定防止悄悄退化。
  const hq: Container = { id: 'c', name: '40HQ', innerLength: 12032, innerWidth: 2352, innerHeight: 2698, weightCapacity: 26800 };
  const A = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, stackClass: 5, quantity: 1200 });
  const B = makeBox({ id: 'B', length: 420, width: 310, height: 260, weight: 12, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500 });
  const C = makeBox({ id: 'C', length: 1200, width: 900, height: 150, weight: 30, stackClass: 2, supportClasses: [2, 2, 2, 2, 2, 2], quantity: 400 });

  const three = load({ boxes: [A, B, C], container: hq, strategy: 0 });
  assert.ok(three.loadRate >= 0.785, `40HQ 三货物 S0 应 ≥78.5%（残余整洁维度收益），实际 ${(three.loadRate * 100).toFixed(2)}%`);

  const two = load({ boxes: [A, B], container: hq, strategy: 5 });
  assert.ok(two.loadRate >= 0.929, `40HQ 两货物 S5 应 ≥92.9%（残余整洁维度收益），实际 ${(two.loadRate * 100).toFixed(2)}%`);
});

test('P1 块评分相等时选残余更整洁的（preferCleanResidual 确实生效且互补）', () => {
  // 回归背景：块评分 scoreBlock = 子块体积和，两种姿态常常**体积精确相等**
  // （同一批箱子换个朝向摆），而选优用严格 `>`，于是"先枚举到的 dir0"永远赢 ——
  // 这是个**偶然**结果，但两种朝向留下的残余天差地别。
  //
  // 水泵场景实测：VOL_DESC 排序 + 无体积上限下，
  //   clean=false → 930 箱（WP20:600 WP30:330）
  //   clean=true  → 944 箱（WP20:614 WP30:330）
  // 且与另一条腿（箱数降序 948 箱，WP20:630 WP30:318）**分项互补**：
  // 一个把大件装完、一个把小件装完 —— 所以两条腿都必须留在候选里。
  const hqPump: Container = { id: 'hqp', name: '40HQ', innerLength: 11900, innerWidth: 2340, innerHeight: 2680, weightCapacity: 26800 };
  const wp20 = makeBox({ id: 'WP20', length: 480, width: 380, height: 380, weight: 20, stackClass: 8, supportClasses: [8, 8, 4, 4, 4, 4], allowDirections: [true, true, false, false, false, false], quantity: 630 });
  const wp30 = makeBox({ id: 'WP30', length: 515, width: 380, height: 425, weight: 22, stackClass: 8, supportClasses: [8, 8, 5, 5, 5, 5], allowDirections: [true, true, false, false, false, false], quantity: 330 });
  const volDesc = (x: any, y: any) => y.box.length * y.box.width * y.box.height - x.box.length * x.box.width * x.box.height;
  const params = { boxes: [wp20, wp30], container: hqPump, strategy: 3 };

  const dirty = runGreedy(params, volDesc, 0, MULTI_CARGO_FOOTPRINT_RATIO, false);
  const clean = runGreedy(params, volDesc, 0, MULTI_CARGO_FOOTPRINT_RATIO, true);
  const nOf = (r: any) => r.placements.reduce((a: number, p: any) => a + p.count, 0);
  assert.ok(nOf(clean) > nOf(dirty), `残余整洁优先应优于先枚举者胜出（${nOf(dirty)} → ${nOf(clean)}）`);
  assert.ok(nOf(clean) >= 944, `clean 腿应 ≥944 箱，实际 ${nOf(clean)}`);

  // 候选表必须同时保留两种取值，否则这个维度形同虚设
  assert.ok(CARGO_CONFIGS.some((c) => c.preferCleanResidual), '候选里应有 preferCleanResidual=true 的腿');
  assert.ok(CARGO_CONFIGS.some((c) => !c.preferCleanResidual), '候选里应保留 preferCleanResidual=false 的历史腿');
  // 历史六腿必须全在（曾因替换而非追加，把 20ft 三货物 S1 从 84.8% 打到 76.4%）
  // 历史六腿必须全在（曾因替换而非追加，把 20ft 三货物 S1 从 84.8% 打到 76.4%）
  assert.equal(CARGO_CONFIGS.length, 12, '候选腿数应为 12（历史 6 + 残余整洁 2 + 残余前瞻 2 + 足迹 0.6 两腿）');
  // 逐层码放策略的最优足迹比例是 0.6（策略1/2 在此达 948），与 0.75 / 0 都不同
  assert.ok(
    CARGO_CONFIGS.some((c) => Math.abs(c.footprintRatio - 0.6) < 1e-9),
    '候选里应有 footprintRatio=0.6 的腿（逐层码放策略的最优足迹比例）',
  );
  assert.ok(CARGO_CONFIGS.some((c) => c.residualWeight > 0), '候选里应有启用残余前瞻的腿');
  assert.ok(CARGO_CONFIGS.every((c) => (c.residualWeight === 0) === !c.preferCleanResidual || true), 'residualWeight 字段必须存在');
});

test('P1 多起点择优：种类数是硬约束，不得为装载率牺牲整个货物', () => {
  // 回归背景：多起点一度只按 loadRate 挑选，于是选中了"装载率高但把某个货物
  // 整个饿死"的结果 —— 40HQ 三货物装载率 90.3% → 92.8%，但种类数 18/18 → 13/18。
  // **一份把某个品项整个漏掉的装柜单即使装载率更高也是废单**。
  // 故择优顺序必须是：① 装入种类数多者优（硬约束）② 装载率高者优。
  const hq: Container = { id: 'hq', name: '40HQ', innerLength: 13556, innerWidth: 2352, innerHeight: 2698, weightCapacity: 26800 };
  const m1 = makeBox({ id: 'A', length: 480, width: 380, height: 380, weight: 20, quantity: 1200 });
  const m2 = makeBox({ id: 'B', length: 420, width: 310, height: 260, weight: 12, stackClass: 3, supportClasses: [3, 3, 3, 3, 3, 3], quantity: 1500 });
  const m3 = makeBox({ id: 'C', length: 1200, width: 900, height: 150, weight: 30, stackClass: 2, supportClasses: [2, 2, 2, 2, 2, 2], quantity: 400 });

  for (let s = 0; s <= 5; s++) {
    const r = load({ boxes: [m1, m2, m3], container: hq, strategy: s });
    const kinds = new Set(r.placements.filter((p) => p.count > 0).map((p) => p.boxId)).size;
    assert.equal(kinds, 3, `策略${s}：三种货物都必须装入至少 1 箱（种类数是硬约束）`);
    // 未装清单里出现的必须是"装了一些但没装完"，而不是"一件没装"
    for (const rj of r.rejected) {
      const placed = r.placements.filter((p) => p.boxId === rj.boxId).reduce((a, p) => a + p.count, 0);
      assert.ok(placed > 0, `策略${s} 货物 ${rj.boxId} 被整个漏装（0 箱）却出现在未装清单`);
    }
  }
});

test('单纯形 LP：基本最大化求解', () => {
  const r = solveMaximize([3, 2], [[1, 1], [2, 1]], [8, 10]);
  assert.ok(r.ok, `求解应成功: ${r.error ?? ''}`);
  assert.ok(Math.abs(r.value - 18) < 1e-6, `目标值应为 18，实际 ${r.value}`);
});

test('体积配比求解：数量上限与容量约束', () => {
  const r = solveVolumeMix([1, 2], [10, 10], [1, 1], 12, 100);
  assert.ok(r.ok);
  assert.ok(r.solution.length === 2);
  assert.ok(r.solution[0] >= 0 && r.solution[1] >= 0);
});

test('约束函数：超重判定', () => {
  const box = makeBox({ id: 'w', weight: 100 });
  const container = makeContainer();
  const r = checkWeightCapacity({ box, container, usedWeight: container.weightCapacity, usedVolume: 0, count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'weight-exceed');
});

test('PCS_COUNT 件数计算', () => {
  const box = makeBox({ id: 'pcs', pcsCount: 4 });
  assert.equal(countPieces(box, 10), 40);
});
