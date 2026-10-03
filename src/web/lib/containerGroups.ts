/**
 * 多柜型对比：结果分组的派生逻辑（纯函数，无 Vue 依赖）
 *
 * ## 为什么要单独抽出来
 *
 * 这段逻辑一开始写在 CalculateView.vue 里，于是：
 * - `.vue` 不在 tsconfig 的 include 里 → **没有类型检查、没有测试**
 * - 已经真出过两个错：模板里把 `row.containerId` 写成 `row.g` 的同级（显示 undefined），
 *   以及「最优柜型」的比较漏了装载率一级，导致 45HQ(50%) 被标成最优而 40HQ(86%) 落选
 *
 * 前端视图里的**判断逻辑**（尤其"哪个更好"这种最容易被想当然的）应该有测试。
 * 故抽到这里，并在 tsconfig 的 include 里加上 `src/web/lib`（只有纯 .ts，不含 .vue）。
 */
import type { ContainerTypeGroup, MultiPlanResult, PackResult } from '../../types/index.js';

/** 柜内容积（mm³）。与算法侧 `containerVolume` 同一公式，此处独立实现以免 web 层跨层依赖算法内部 */
export function containerVolumeOf(c: { innerLength: number; innerWidth: number; innerHeight: number }): number {
  return c.innerLength * c.innerWidth * c.innerHeight;
}

/** 某组共装入的件数 */
export function groupPieces(g: ContainerTypeGroup): number {
  return g.plans.reduce((s, p) => s + p.pieces, 0);
}

/** 某组仍剩的件数合计 */
export function groupRemainingCount(g: ContainerTypeGroup): number {
  return g.remaining.reduce((s, r) => s + r.qty, 0);
}

/**
 * a 是否优于 b —— 「最优柜型」的判定，依次比较：
 *   1. 剩余**种类**少者优（装得下的品项多）
 *   2. 件数多者优
 *   3. **装载率高者优**
 *   4. 用柜数少者优
 *
 * ## 第 3 级（装载率）必须有 —— 实测踩过的坑
 *
 * 数量填「不限」时，各柜型都会一直装到自己的几何上限，总件数**必然打平**
 * （实测 20GP / 40HQ / 45HQ 三种柜型都装 1241 箱，因为总量收敛到货物总体积）。
 * 此时只按"件数 + 剩余"比较会永远选中**第一个**柜型，
 * 于是出现过"45HQ 装载率 50% 被标成最优，而 40HQ 的 86% 排在后面"这种误导结论。
 * 装载率正是此时唯一有区分度的指标。
 */
export function isBetterGroup(a: ContainerTypeGroup, b: ContainerTypeGroup): boolean {
  if (a.remaining.length !== b.remaining.length) {
    return a.remaining.length < b.remaining.length;
  }
  if (a.pieces !== b.pieces) {
    return a.pieces > b.pieces;
  }
  if (Math.abs(a.overallRate - b.overallRate) > 1e-9) {
    return a.overallRate > b.overallRate;
  }
  return a.totalContainers < b.totalContainers;
}

/** 最优柜型（无分组时返回 undefined） */
export function bestGroupOf(groups: ContainerTypeGroup[]): ContainerTypeGroup | undefined {
  let best: ContainerTypeGroup | undefined;
  for (const g of groups) {
    if (!best || isBetterGroup(g, best)) {
      best = g;
    }
  }
  return best;
}

/**
 * 把多个柜型的分组结果合成一个 `MultiPlanResult`
 *
 * 总体装载率口径与后端 `planMultiContainer` 尾部一致：已装体积 / 总柜内容积。
 *
 * ## `remaining` 为什么取「最优柜型」那一组
 *
 * 多柜型是**对比**语义：每组都拿**同一批货物数量**独立算了一遍，
 * 所以不存在全局剩余（货并没有被"分掉"，而是被算了 N 次）。
 * 有意义的问题是"**最优柜型也装不下多少**" —— 那才是需要换柜型或改包装的信息。
 * 逐柜型的剩余看 `groups[].remaining`。
 *
 * ## `plans` / `totalContainers` 等汇总字段在对比模式下不可相加
 *
 * 它们是各组结果的并集，同一批货被重复计入。UI 上**不能**把它们当成
 * "总共装了 N 箱 / 需要 N 个柜"来用，对比模式的统计卡刻意换了口径。
 */
export function mergeGroups(groups: ContainerTypeGroup[]): MultiPlanResult {
  const plans: PackResult[] = groups.flatMap((g) => g.plans);
  const totalLoadedVolume = plans.reduce((s, p) => s + p.usedVolume, 0);
  const totalContainerVolume = plans.reduce((s, p) => s + containerVolumeOf(p.container), 0);
  const best = bestGroupOf(groups);
  return {
    plans,
    totalContainers: plans.length,
    totalLoadedVolume,
    totalContainerVolume,
    overallRate: totalContainerVolume > 0 ? totalLoadedVolume / totalContainerVolume : 0,
    remaining: best?.remaining ?? [],
    groups,
  };
}

/** 由单次 `calculateMulti` 的返回构造一个柜型分组 */
export function toGroup(
  containerId: number | string,
  m: { plans: PackResult[]; totalLoadedVolume: number; remaining: Array<{ boxId: string; qty: number }> },
): ContainerTypeGroup {
  const totalContainerVolume = m.plans.reduce((s, p) => s + containerVolumeOf(p.container), 0);
  return {
    containerId,
    plans: m.plans,
    totalContainers: m.plans.length,
    pieces: m.plans.reduce((s, p) => s + p.pieces, 0),
    overallRate: totalContainerVolume > 0 ? m.totalLoadedVolume / totalContainerVolume : 0,
    remaining: m.remaining,
  };
}