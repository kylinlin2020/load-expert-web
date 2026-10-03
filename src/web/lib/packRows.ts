/**
 * 装柜结果的可视化行数据（**唯一来源**）
 *
 * 装柜计算页与「打印/报表」页都要用同一套：装入清单、分层明细、装柜步骤。
 * 本模块把这些派生逻辑从 CalculateView 里抽出来，供两处共用 ——
 * **否则打印出来的步骤单和页面上看到的会是两套算法算出来的两个结果**，
 * 现场照着打印件装却和页面不一致，这是最不能接受的缺陷。
 *
 * 全部为纯函数（无 Vue 依赖），便于单独验证。
 */
import type { Box, CartonPlacement, PackResult, Placement } from '../../types/index.js';
import { expandResult } from '../../algorithm/expand.js';

/** 姿态中文名（按 ORIENTATION_AXIS_ORDERS 的轴序推导：哪一轴朝上决定平/侧/立） */
export const ORIENTATION_NAMES = ['平放·长沿柜长', '平放·长沿柜宽', '侧放·宽朝上', '侧放·宽朝上', '立放·长朝上', '立放·长朝上'] as const;
export const ORIENTATION_SHORT = ['平放', '平放', '侧放', '侧放', '立放', '立放'] as const;

/**
 * 未装原因分类（算法已细化 reason；未知一律标注 UNCERTAIN 推断）
 *
 * **措辞以此处为准**：原先写在 CalculateView 里，现移到本模块供页面与打印报表共用。
 * 搬过来时逐条保持原措辞不变（"空间耗尽/放不下/迭代上限…"），避免为了统一而改动用户看到的文案。
 */
export const REASON_LABEL: Record<string, string> = {
  'weight-exceed': '超重',
  'volume-exceed': '体积不足',
  'space-exhausted': '空间耗尽',
  'no-fit': '放不下',
  'iteration-limit': '迭代上限',
  'lp-capped': '配比截断',
  'stack-class-exceed': '堆码超限',
  'support-pct-exceed': '承托不足',
  'support-pct-invalid': '承托参数非法',
  'no-support': '无承托（悬空）',
  UNCERTAIN: '原因未知',
};

/** 按 id 找货物元数据 */
export function boxMetaOf(boxes: readonly Box[], boxId: string): Box | undefined {
  return boxes.find((b) => b.id === boxId);
}

/** 逐件坐标（把聚合 placement 展开到单箱） */
export function buildCartons(result: PackResult | null, boxes: readonly Box[]): CartonPlacement[] {
  return result ? expandResult(result, [...boxes]) : [];
}

export interface LoadSummaryRow {
  boxId: string;
  name: string;
  sku: string;
  count: number;
  volume: number;
  weight: number;
}

/** 装入清单：按货物类型聚合 */
export function buildLoadSummary(result: PackResult | null, boxes: readonly Box[]): LoadSummaryRow[] {
  if (!result) return [];
  const map = new Map<string, LoadSummaryRow>();
  for (const p of result.placements) {
    const b = boxMetaOf(boxes, p.boxId);
    const cur = map.get(p.boxId) ?? {
      boxId: p.boxId,
      name: b?.name ?? `货物 ${p.boxId}`,
      sku: b?.sku ?? '',
      count: 0,
      volume: 0,
      weight: 0,
    };
    // 体积按货物原始单箱体积 × 箱数计。
    // 注意 p.dims 是**块包围盒**（nx×ny×nz 箱的合并尺寸），直接 × count 会重复放大；
    // 轴置换不改变体积，故用原始 L×W×H 即可。
    cur.count += p.count;
    cur.volume += b ? b.length * b.width * b.height * p.count : 0;
    cur.weight += (b?.weight ?? 0) * p.count;
    map.set(p.boxId, cur);
  }
  return [...map.values()].sort((a, b2) => b2.volume - a.volume);
}

export interface LayerRow {
  level: number;
  zMin: number;
  zMax: number;
  totalCount: number;
  totalVolume: number;
  items: Array<{ boxId: string; name: string; count: number }>;
}

/**
 * 分层明细：按每箱真实 z 底面分层
 *
 * 原实现用聚合 placement 的包围盒做 z 区间重叠判定，一个 3 层高的聚合块
 * 会被算成 1 层（200³ 小箱装出 dims=[5800,2200,600] count=957 却只报 1 层）。
 * 现改为直接用逐件坐标按 z 底面聚合，与后端 summarizeLayers 口径一致。
 */
export function buildLayerRows(cartons: readonly CartonPlacement[], result: PackResult | null, boxes: readonly Box[]): LayerRow[] {
  if (cartons.length === 0) {
    // 兜底：逐件为空（历史方案无 boxes 元数据）时退回按聚合块 z 聚类
    if (!result) return [];
    const groups = new Map<number, { zMin: number; zMax: number; items: Placement[] }>();
    for (const p of result.placements) {
      // items 必须显式标注：写 `items: []` 会被推成 never[]，随后 push 就报
    // "Argument of type 'Placement' is not assignable to parameter of type 'never'"。
    // 这个目录原先不在 tsconfig include 里，所以一直没被发现。
    const g: { zMin: number; zMax: number; items: Placement[] } = groups.get(Math.round(p.z)) ?? {
      zMin: p.z,
      zMax: p.z + p.dims[2],
      items: [],
    };
      g.zMax = Math.max(g.zMax, p.z + p.dims[2]);
      g.items.push(p);
      groups.set(Math.round(p.z), g);
    }
    return [...groups.values()]
      .sort((a, b) => a.zMin - b.zMin)
      .map((g, i) => {
        const itemMap = new Map<string, { boxId: string; name: string; count: number }>();
        let totalCount = 0;
        let totalVolume = 0;
        for (const p of g.items) {
          const b = boxMetaOf(boxes, p.boxId);
          const cur = itemMap.get(p.boxId) ?? { boxId: p.boxId, name: b?.name ?? `货物 ${p.boxId}`, count: 0 };
          cur.count += p.count;
          itemMap.set(p.boxId, cur);
          totalCount += p.count;
          // 同上：块包围盒不可直接乘 count
          totalVolume += b ? b.length * b.width * b.height * p.count : 0;
        }
        return { level: i + 1, zMin: g.zMin, zMax: g.zMax, totalCount, totalVolume, items: [...itemMap.values()] };
      });
  }

  // 按 z 底面聚合（同 z 的箱归为同一层）
  const groups = new Map<number, CartonPlacement[]>();
  for (const ct of cartons) {
    const key = Math.round(ct.z);
    const arr = groups.get(key);
    if (arr) {
      arr.push(ct);
    } else {
      groups.set(key, [ct]);
    }
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([z, items], i) => {
      const itemMap = new Map<string, { boxId: string; name: string; count: number }>();
      let totalCount = 0;
      let totalVolume = 0;
      let zMax = 0;
      for (const ct of items) {
        const b = boxMetaOf(boxes, ct.boxId);
        const cur = itemMap.get(ct.boxId) ?? { boxId: ct.boxId, name: b?.name ?? `货物 ${ct.boxId}`, count: 0 };
        cur.count += 1;
        itemMap.set(ct.boxId, cur);
        totalCount += 1;
        totalVolume += ct.dims[0] * ct.dims[1] * ct.dims[2];
        zMax = Math.max(zMax, ct.z + ct.dims[2]);
      }
      return { level: i + 1, zMin: z, zMax, totalCount, totalVolume, items: [...itemMap.values()] };
    });
}

export interface StepRow {
  step: number;
  /** 对应 result.placements 的下标，用于 3D 高亮 */
  placementIndex: number;
  boxId: string;
  name: string;
  sku: string;
  /** 姿态 0..5 */
  orientation: number;
  /** 该姿态下单箱占位尺寸 */
  dims: readonly [number, number, number];
  /** 本步件数 */
  count: number;
  /** 占位区域（mm） */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  volume: number;
  weight: number;
  /** 累计件数 / 累计体积（装到这里就够了） */
  cumCount: number;
  cumVolume: number;
  /** 累计装载率（打印步骤单时用，现场看"装到第 N 步装到几成"） */
  cumRate: number;
}

/**
 * 装柜步骤：由逐件坐标按 placementIndex 归组，再排成物理上可执行的顺序
 *
 * ## 排序规则
 *  1. **z 底面升序** —— 必须自下而上，否则会出现"空中楼阁"（先装的箱子悬空）
 *  2. 同层按**距柜门由远及近**推进：若门在 x=L 端则 x 降序，反之 x 升序。
 *     即"先装柜内深处、最后装靠近门口"，卸货时靠门的先取。
 *
 * ## 诚实标注
 *  - 「装柜步骤」的**排序规则与列结构由本项目自拟**（没有权威规范可依），
 *    按装柜作业通行做法实现 —— 与其他系统的步骤单不一定可互换，对接前请先核对。
 *  - 柜门位置**未在容器模型中记录**（只有 doorDims 门尺寸，没有门在哪端），
 *    故做成显式可切换的 `doorAtMaxX`，避免把约定偷偷写死。
 *  - 步骤粒度 = 聚合放置块。若同一步内跨越了很大的空间跨度，
 *    现场可再按 x/y 子区域二次拆分（当前未做）。
 */
export function buildStepRows(
  cartons: readonly CartonPlacement[],
  boxes: readonly Box[],
  doorAtMaxX: boolean,
  containerVol: number,
): StepRow[] {
  if (cartons.length === 0) return [];

  // 逐件 → 按 placementIndex 归组
  interface Acc {
    placementIndex: number;
    boxId: string;
    orientation: number;
    dims: readonly [number, number, number];
    count: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    zMin: number;
    zMax: number;
  }
  const groups = new Map<number, Acc>();
  for (const ct of cartons) {
    let g = groups.get(ct.placementIndex);
    if (!g) {
      g = {
        placementIndex: ct.placementIndex,
        boxId: ct.boxId,
        orientation: ct.orientation,
        dims: ct.dims,
        count: 0,
        xMin: ct.x,
        xMax: ct.x + ct.dims[0],
        yMin: ct.y,
        yMax: ct.y + ct.dims[1],
        zMin: ct.z,
        zMax: ct.z + ct.dims[2],
      };
      groups.set(ct.placementIndex, g);
    }
    g.count += 1;
    g.xMin = Math.min(g.xMin, ct.x);
    g.yMin = Math.min(g.yMin, ct.y);
    g.zMin = Math.min(g.zMin, ct.z);
    g.xMax = Math.max(g.xMax, ct.x + ct.dims[0]);
    g.yMax = Math.max(g.yMax, ct.y + ct.dims[1]);
    g.zMax = Math.max(g.zMax, ct.z + ct.dims[2]);
  }

  const dirSign = doorAtMaxX ? -1 : 1;
  const ordered = [...groups.values()].sort((a, b) => a.zMin - b.zMin || (a.xMin - b.xMin) * dirSign);

  let cumCount = 0;
  let cumVolume = 0;
  return ordered.map((g, i) => {
    const b = boxMetaOf(boxes, g.boxId);
    // 体积按逐件实际占位累加（不能用名义 L×W×H × 件数，型变系数下会算错）
    const volume = g.dims[0] * g.dims[1] * g.dims[2] * g.count;
    const weight = (b?.weight ?? 0) * g.count;
    cumCount += g.count;
    cumVolume += volume;
    const cumRate = containerVol > 0 ? cumVolume / containerVol : 0;
    return {
      step: i + 1,
      placementIndex: g.placementIndex,
      boxId: g.boxId,
      name: b?.name ?? `货物 ${g.boxId}`,
      sku: b?.sku ?? '',
      orientation: g.orientation,
      dims: g.dims,
      count: g.count,
      xMin: Math.round(g.xMin),
      xMax: Math.round(g.xMax),
      yMin: Math.round(g.yMin),
      yMax: Math.round(g.yMax),
      zMin: Math.round(g.zMin),
      zMax: Math.round(g.zMax),
      volume,
      weight,
      cumCount,
      cumVolume,
      cumRate,
    };
  });
}