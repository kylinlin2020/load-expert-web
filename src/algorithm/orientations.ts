/**
 * 六方向姿态枚举与轴序映射
 *
 * 对齐逆向文档：6 方向姿态查表 0x5f8ac0（18 字节），轴序：
 *   0: (0,1,2)  1: (1,0,2)  2: (0,2,1)  3: (2,0,1)  4: (2,1,0)  5: (1,2,0)
 * 轴序含义：以货物原始 (L=index0, W=index1, H=index2) 为输入，
 * 映射到容器坐标系 (x=index0, y=index1, z=index2)。
 *
 * 不使用 TS enum（保持 node:test 原生 type-stripping 兼容），采用 const 对象。
 */
import type { Box, OrientationAxisOrder } from '../types/index.js';

export const ORIENTATION_COUNT = 6;

/** 0x5f8ac0 查表语义（轴序映射） */
export const ORIENTATION_AXIS_ORDERS: readonly OrientationAxisOrder[] = [
  [0, 1, 2], // dir0: L->x, W->y, H->z（平放，长沿x）
  [1, 0, 2], // dir1: W->x, L->y, H->z（平放，长沿y）
  [0, 2, 1], // dir2: L->x, H->y, W->z（侧立，宽沿z）
  [2, 0, 1], // dir3: H->x, L->y, W->z
  [2, 1, 0], // dir4: H->x, W->y, L->z（立放）
  [1, 2, 0], // dir5: W->x, H->y, L->z
] as const;

/** 方向名称（可读性输出用） */
export const ORIENTATION_NAMES = ['dir0', 'dir1', 'dir2', 'dir3', 'dir4', 'dir5'] as const;

/**
 * 货物有效（型变后）名义尺寸 (L,W,H)
 *
 * 型变系数 DEFORM_FACTOR：实际装柜尺寸 = 名义尺寸 × 该系数。
 * 典型场景是软包装/可压缩货物受压后实际占位小于名义尺寸（系数 < 1）。
 *
 * 注：本函数只改「占位几何」，不改重量与数量口径（件数口径由 PCS_COUNT 决定）。
 */
export function effectiveDims(
  box: Pick<Box, 'length' | 'width' | 'height' | 'deformFactor'>,
): [number, number, number] {
  const k = typeof box.deformFactor === 'number' && Number.isFinite(box.deformFactor) && box.deformFactor > 0 ? box.deformFactor : 1;
  if (k === 1) {
    return [box.length, box.width, box.height];
  }
  return [box.length * k, box.width * k, box.height * k];
}

/**
 * 将货物有效尺寸按方向映射为容器坐标系尺寸 (dx,dy,dz)
 *
 * 这是全项目唯一的名义尺寸 → 实际占位尺寸的换算入口：
 * 候选块生成、放置、3D 渲染、方向有效性判定都经由此处，
 * 因此型变系数只需在此处生效一次即可全链路一致。
 */
export function orientDims(
  box: Pick<Box, 'length' | 'width' | 'height' | 'deformFactor'>,
  orientation: number,
): [number, number, number] {
  const order = ORIENTATION_AXIS_ORDERS[orientation];
  const raw = effectiveDims(box);
  return [raw[order[0]], raw[order[1]], raw[order[2]]];
}

/** 检查方向索引合法性 */
export function isOrientationIndex(orientation: number): boolean {
  return Number.isInteger(orientation) && orientation >= 0 && orientation < ORIENTATION_COUNT;
}

/** 全量方向列表 */
export function allOrientations(): number[] {
  return [0, 1, 2, 3, 4, 5];
}
