/**
 * LoadExpert Web - 装柜计算 CLI 演示
 *
 * 运行：npm run demo（先 build 再执行 dist/scripts/demo.js）
 * 构造示例货物 + 柜型，跑一次装柜并打印结果。
 */
import type { Box, Container } from '../src/types/index.js';
import { load } from '../src/algorithm/load.js';
import { STRATEGY_NAMES } from '../src/algorithm/candidate-blocks.js';
import { containerVolume } from '../src/algorithm/candidate-blocks.js';

/** 20ft 标准柜 */
const container: Container = {
  id: 'con-20ft',
  name: '20ft 干货柜',
  innerLength: 5898,
  innerWidth: 2352,
  innerHeight: 2393,
  weightCapacity: 21770,
};

/** 示例货物：纸箱装灯具 */
const lampBox: Box = {
  id: 'lamp',
  name: 'LED 灯具纸箱',
  length: 580,
  width: 380,
  height: 320,
  weight: 18.5,
  stackClass: 4,
  supportClasses: [4, 4, 4, 4, 4, 4],
  supportPct: [1, 1, 1],
  pcsCount: 6,
  quantity: 1200,
};

/** 示例货物：小家电 */
const applianceBox: Box = {
  id: 'appliance',
  name: '小家电纸箱',
  length: 420,
  width: 310,
  height: 260,
  weight: 12,
  stackClass: 3,
  supportClasses: [3, 3, 3, 3, 3, 3],
  supportPct: [1, 1, 1],
  pcsCount: 2,
  quantity: 1500,
};

function fmt(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function main(): void {
  for (const strategy of [0, 3, 5]) {
    console.log(`\n========== 策略 ${strategy}（${STRATEGY_NAMES[strategy] ?? '未知'}） ==========`);
    const result = load({ boxes: [lampBox, applianceBox], container, strategy, lpEnabled: strategy === 5 });
    console.log(`柜型：${container.name}（${container.innerLength}×${container.innerWidth}×${container.innerHeight} mm，容积 ${fmt(containerVolume(container) / 1e9)} m³）`);
    console.log(`装载率：${(result.loadRate * 100).toFixed(2)}%`);
    console.log(`占用体积：${fmt(result.usedVolume / 1e9)} m³`);
    console.log(`总重量：${fmt(result.totalWeight)} kg（载重 ${fmt(container.weightCapacity)} kg）`);
    console.log(`总件数：${fmt(result.pieces)} 件（PCS 累计）`);
    console.log(`放置数：${result.placements.length} 个 placement；迭代 ${result.iterations} 轮`);
    console.log(`未装入：${result.rejected.length > 0 ? result.rejected.map((r) => `${r.boxId}(${r.reason})`).join(', ') : '无'}`);
    const byBox = new Map<string, { count: number; volume: number }>();
    for (const p of result.placements) {
      const cur = byBox.get(p.boxId) ?? { count: 0, volume: 0 };
      cur.count += p.count;
      cur.volume += p.dims[0] * p.dims[1] * p.dims[2] * p.count;
      byBox.set(p.boxId, cur);
    }
    for (const [id, info] of byBox) {
      console.log(`  ${id}: ${info.count} 箱，${fmt(info.volume / 1e9)} m³`);
    }
    if (result.layers.length > 0) {
      const maxLevel = Math.max(...result.layers.map((l) => l.level));
      console.log(`层数：${maxLevel}`);
    }
  }
}

main();
