/**
 * 多柜型对比的分组派生逻辑测试
 *
 * 这段逻辑原先写在 CalculateView.vue 里，而 .vue 不在 tsconfig include 中
 * → 无类型检查、无测试。已经真出过两个错：
 *   1. 模板里 `row.containerId`（应为 `row.g.containerId`）→ 柜型列显示 undefined
 *   2. 「最优柜型」漏比装载率 → 45HQ(50%) 被标成最优，40HQ(86%) 落选
 *
 * 抽出到 src/web/lib/containerGroups.ts 并把该目录加进 tsconfig include 后可测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContainerTypeGroup, PackResult } from '../src/types/index.js';
import {
  bestGroupOf,
  containerVolumeOf,
  isBetterGroup,
  mergeGroups,
  toGroup,
} from '../src/web/lib/containerGroups.js';

/** 造一个最小可用的 PackResult（只需要 groups 逻辑用到的字段） */
function fakePlan(id: string, innerLength: number, pieces: number, usedVolume: number): PackResult {
  return {
    container: {
      id,
      name: id,
      innerLength,
      innerWidth: 1000,
      innerHeight: 1000,
      weightCapacity: 100000,
    } as PackResult['container'],
    placements: [],
    pieces,
    usedVolume,
    totalWeight: 0,
    loadRate: 0,
    strategy: 3,
    iterations: 1,
    lpEnabled: false,
    rejected: [],
  } as unknown as PackResult;
}

function group(
  containerId: string,
  len: number,
  pieces: number,
  rate: number,
  remaining: Array<{ boxId: string; qty: number }> = [],
): ContainerTypeGroup {
  const vol = containerVolumeOf({ innerLength: len, innerWidth: 1000, innerHeight: 1000 });
  return {
    containerId,
    plans: [fakePlan(containerId, len, pieces, Math.round(vol * rate))],
    totalContainers: 1,
    pieces,
    overallRate: rate,
    remaining,
  };
}

test('柜内容积公式与算法侧一致', () => {
  // 11900 × 2340 × 2680 = 74,627,280,000（报表里显示 74.627 m³）
  assert.equal(containerVolumeOf({ innerLength: 11900, innerWidth: 2340, innerHeight: 2680 }), 74627280000);
});

test('最优柜型：件数打平时必须比装载率（数量不限时必然打平）', () => {
  // 复现实测：三种柜型都装 1241 箱（总量收敛到货物总体积），
  // 只有装载率有区分度。若比较逻辑漏了装载率，就会永远选中第一个（50%）。
  const a = group('45HQ', 13556, 1241, 0.5);
  const b = group('20GP', 5898, 1241, 0.86);
  const c = group('40HQ', 11900, 1241, 0.58);
  assert.ok(isBetterGroup(b, a), '86% 应优于 50%');
  assert.ok(!isBetterGroup(a, b));
  assert.equal(bestGroupOf([a, b, c])?.containerId, '20GP');
});

test('最优柜型：剩余种类少者优先于件数多', () => {
  // 装得多的那档反而剩下一个品项，对"这批货能不能走"来说更糟
  const manyButLeft = group('A', 10000, 900, 0.9, [{ boxId: 'x', qty: 5 }]);
  const fewerAllDone = group('B', 5000, 700, 0.7, []);
  assert.ok(isBetterGroup(fewerAllDone, manyButLeft));
  assert.equal(bestGroupOf([manyButLeft, fewerAllDone])?.containerId, 'B');
});

test('最优柜型：全部打平时比用柜数少者', () => {
  const two: ContainerTypeGroup = { ...group('A', 10000, 1000, 0.9), totalContainers: 2 };
  const three: ContainerTypeGroup = { ...group('B', 10000, 1000, 0.9), totalContainers: 3 };
  assert.ok(isBetterGroup(two, three));
  assert.equal(bestGroupOf([three, two])?.containerId, 'A');
});

test('mergeGroups：plans 是各组并集，remaining 取最优柜型那组', () => {
  const a = group('45HQ', 13556, 1241, 0.5, [{ boxId: 'r', qty: 9 }]);
  const b = group('20GP', 5898, 1241, 0.86, []);
  const m = mergeGroups([a, b]);

  assert.equal(m.plans.length, 2, '两个柜型各一个柜，并集应为 2');
  assert.equal(m.totalContainers, 2);
  assert.equal(m.groups?.length, 2);
  // remaining 反映"最优柜型也装不下的量"，不是随便取一个
  assert.deepEqual(m.remaining, []);
  assert.equal(m.totalLoadedVolume, Math.round(containerVolumeOf({ innerLength: 13556, innerWidth: 1000, innerHeight: 1000 }) * 0.5) +
    Math.round(containerVolumeOf({ innerLength: 5898, innerWidth: 1000, innerHeight: 1000 }) * 0.86));
});

test('mergeGroups：空分组不崩', () => {
  const m = mergeGroups([]);
  assert.deepEqual(m.plans, []);
  assert.deepEqual(m.remaining, []);
  assert.equal(m.overallRate, 0);
  assert.deepEqual(m.groups, []);
});

test('toGroup：由单次计算结果构造分组，件数与装载率口径正确', () => {
  const p1 = fakePlan('C', 10000, 700, 5_000_000);
  const p2 = fakePlan('C', 10000, 300, 2_000_000);
  const vol = containerVolumeOf(p1.container);
  const g = toGroup('C', { plans: [p1, p2], totalLoadedVolume: 7_000_000, remaining: [] });
  assert.equal(g.pieces, 1000, '件数应为各柜之和');
  assert.equal(g.totalContainers, 2);
  assert.equal(g.overallRate, 7_000_000 / (vol * 2));
});