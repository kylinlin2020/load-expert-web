/**
 * 逐件展开（Placement → CartonPlacement[]）与真实分层统计
 *
 * 背景：算法主循环输出的是**聚合块** —— 一个 Placement 的 dims 是块包围盒、
 * count 是箱数（20ft 装 580×380×320 纸箱 → 1 个 placement，dims=5760×2320×2280，
 * count=432）。3D 若按整块渲染会得到一个实心大方块，装柜效果图完全失真。
 *
 * 展开规则（与 candidate-blocks.ts 的 6 个策略生成逻辑一致）：
 *   块内为规则网格：nx = round(bbox.x / carton.x)、ny = round(bbox.y / carton.y)、
 *   nz = round(bbox.z / carton.z)；
 *   按 z 主序填充 —— x 变化最快，其次 y，最后 z；装满 count 即停止。
 *   末尾可能残留空槽（如策略 2 逐层填充时末行不足 countX）。
 *
 * 例外：若按上式推出的网格容量 < count（理论上不应发生，防御性处理），
 * 沿 z 方向补足层数。
 */
import type { Box, CartonPlacement, LayerInfo, PackResult, Placement } from '../types/index.js';
import { orientDims } from './orientations.js';

/** 轴向件数：span 为该轴占用长度，unit 为单箱在该轴的尺寸 */
function axisCount(span: number, unit: number): number {
  if (!(unit > 0) || !(span > 0)) {
    return 1;
  }
  const n = Math.floor(span / unit + 1e-6);
  return n >= 1 ? n : 1;
}

/**
 * 由「层数」直接生成逐件网格尺寸
 *
 * 用于**残层块**：策略 2/5 允许末层不足整行，块的包围盒 y/z 是按 ceil 结果
 * 收紧的（如 230 箱排成 46×1×5，最后一层只有 0 箱但 z 仍占满 5 层高）。
 * 此时不能从包围盒反推 nz（会算出比实际层数多的层），
 * 必须直接用已知的层数，否则展开会溢出块的 z 上界。
 *
 * @param perLayer 每层件数（= nx * ny）
 * @param layerCount 实际层数
 * @param count 总箱数
 */
export function gridFromLayers(perLayer: number, layerCount: number, count: number): [number, number, number] {
  if (perLayer <= 0) {
    return [1, 1, Math.max(1, count)];
  }
  return [perLayer, 1, Math.max(1, layerCount)];
}

/** boxId → Box 索引 */
export function indexBoxes(boxes: readonly Box[]): Map<string, Box> {
  const map = new Map<string, Box>();
  for (const b of boxes) {
    map.set(b.id, b);
  }
  return map;
}

/**
 * 推导块内网格尺寸 (nx, ny, nz)
 * @param bbox 块包围盒尺寸
 * @param carton 单箱在该方向姿态下的尺寸
 * @param count 块内箱数（用于容量不足时补层）
 */
export function gridOf(
  bbox: readonly [number, number, number],
  carton: readonly [number, number, number],
  count: number,
): [number, number, number] {
  let nx = axisCount(bbox[0], carton[0]);
  let ny = axisCount(bbox[1], carton[1]);
  let nz = axisCount(bbox[2], carton[2]);
  // 防御：容量不足则沿 z 补层
  const perLayer = nx * ny;
  if (perLayer * nz < count) {
    nz += Math.ceil((count - perLayer * nz) / perLayer);
  }
  return [nx, ny, nz];
}

/** 展开单个聚合放置为逐件坐标；缺少货物元数据时返回空数组 */
export function expandPlacement(placement: Placement, box: Box | undefined, placementIndex: number, startIndex = 0): CartonPlacement[] {
  if (!box) {
    return [];
  }
  const [dx, dy, dz] = orientDims(box, placement.orientation);
  if (!(dx > 0 && dy > 0 && dz > 0)) {
    return [];
  }
  const count = Math.max(0, Math.floor(placement.count));
  if (count === 0) {
    return [];
  }
  const [nx, ny, nz] = gridOf(placement.dims, [dx, dy, dz], count);
  const dims: readonly [number, number, number] = [dx, dy, dz];
  const out: CartonPlacement[] = [];
  let placed = 0;
  for (let k = 0; k < nz && placed < count; k++) {
    for (let j = 0; j < ny && placed < count; j++) {
      for (let i = 0; i < nx && placed < count; i++) {
        out.push({
          index: startIndex + placed,
          placementIndex,
          indexInPlacement: placed,
          boxId: placement.boxId,
          orientation: placement.orientation,
          dims,
          x: placement.x + i * dx,
          y: placement.y + j * dy,
          z: placement.z + k * dz,
          stackClass: placement.stackClass,
          supportClass: placement.supportClass,
        });
        placed++;
      }
    }
  }
  return out;
}

/** 展开全部放置为逐件坐标（index 跨 placement 连续递增） */
export function expandPlacements(placements: readonly Placement[], boxes: readonly Box[] | Map<string, Box>): CartonPlacement[] {
  const byId = boxes instanceof Map ? boxes : indexBoxes(boxes);
  const out: CartonPlacement[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    out.push(...expandPlacement(p, byId.get(p.boxId), i, out.length));
  }
  return out;
}

/** 便捷入口：直接展开整个计算结果 */
export function expandResult(result: PackResult, boxes: readonly Box[] | Map<string, Box>): CartonPlacement[] {
  return expandPlacements(result.placements, boxes);
}

/** 单个聚合放置的逐层构成（不物化逐件坐标，O(nz)） */
export interface PlacementLayer {
  /** 块内层序（0 起） */
  k: number;
  /** 该层底面 z */
  z: number;
  /** 该层单箱高度 */
  dz: number;
  /** 该层箱数（末层可能不足 nx*ny） */
  count: number;
}

/** 拆出某放置的逐层构成 */
export function placementLayers(placement: Placement, cartonDims: readonly [number, number, number]): PlacementLayer[] {
  const [dx, dy, dz] = cartonDims;
  if (!(dx > 0 && dy > 0 && dz > 0)) {
    return [];
  }
  const count = Math.max(0, Math.floor(placement.count));
  if (count === 0) {
    return [];
  }
  const [nx, ny, nz] = gridOf(placement.dims, [dx, dy, dz], count);
  const perLayer = nx * ny;
  const out: PlacementLayer[] = [];
  let placed = 0;
  for (let k = 0; k < nz && placed < count; k++) {
    const n = Math.min(perLayer, count - placed);
    out.push({ k, z: placement.z + k * dz, dz, count: n });
    placed += n;
  }
  return out;
}

/**
 * 真实分层统计（替代原先按 placement 包围盒聚类的做法）
 *
 * 原实现把整个聚合块当作一层，200³ 小箱装出 dims=[5800,2200,600] count=957
 * （实为 3 个物理层）却只报 layers.length=1，导致「分层明细」与 3D 切片失真。
 * 现按每箱实际 z 底面聚合：同 z 的箱归为同一层，zMax 取该层最高箱顶。
 */
export function summarizeLayers(placements: readonly Placement[], boxes: readonly Box[] | Map<string, Box>): LayerInfo[] {
  const byId = boxes instanceof Map ? boxes : indexBoxes(boxes);
  interface Acc {
    zMin: number;
    zMax: number;
    count: number;
    volume: number;
    boxId: string;
    orientation: number;
  }
  const groups = new Map<number, Acc>();
  const key = (z: number) => Math.round(z);

  for (const p of placements) {
    const box = byId.get(p.boxId);
    if (!box) {
      continue;
    }
    const [dx, dy, dz] = orientDims(box, p.orientation);
    if (!(dx > 0 && dy > 0 && dz > 0)) {
      continue;
    }
    const vol = dx * dy * dz;
    for (const layer of placementLayers(p, [dx, dy, dz])) {
      const k = key(layer.z);
      const cur = groups.get(k);
      if (!cur) {
        groups.set(k, {
          zMin: layer.z,
          zMax: layer.z + layer.dz,
          count: layer.count,
          volume: vol * layer.count,
          boxId: p.boxId,
          orientation: p.orientation,
        });
      } else {
        cur.zMax = Math.max(cur.zMax, layer.z + layer.dz);
        cur.count += layer.count;
        cur.volume += vol * layer.count;
      }
    }
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc], i) => ({
      level: i + 1,
      zMin: acc.zMin,
      zMax: acc.zMax,
      orientation: acc.orientation,
      count: acc.count,
      volume: acc.volume,
      boxId: acc.boxId,
    }));
}
