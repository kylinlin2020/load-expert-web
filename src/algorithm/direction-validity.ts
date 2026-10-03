/**
 * 方向有效性判定（对齐逆向 0x490c30）
 *
 * 原程序对方向 0..5 逐一调用有效性判定（调用指纹 55/175 次），判定依据：
 *  - 方向标志数组（对象 +0x18 每方向一字节）→ 对应 A~F_ALLOW「六向允许摆放」
 *  - 六向承托字节（+0x68 每方向一字节，A~F_SUPPORT_STACK_CLASS）
 *  - STACK_CLASS（cargo +0x11c）
 * 具体位运算语义未能完全还原，此处采用可复现的业务等价判定，TODO/UNCERTAIN 见函数注释。
 */
import type { Box, Container, SpaceBlock } from '../types/index.js';
import { orientDims, ORIENTATION_COUNT } from './orientations.js';

export interface DirectionValidityInput {
  box: Box;
  container: Container;
  orientation: number;
  /** 候选空间（不传则用整柜尺寸） */
  space?: SpaceBlock;
}

/**
 * 方向有效性判定
 * 规则（对齐文档 + 推断）：
 *  1. 方向索引合法；
 *  2. A~F_ALLOW「六向允许摆放」allowDirections[orientation] 不为 false
 *     （缺省视为允许；原程序该字段为 +0x18 每方向一字节的方向标志数组）；
 *  3. 六向承托级别 supportClasses[orientation] > 0 才允许该方向放置
 *     （A~F_SUPPORT_STACK_CLASS 为 0 表示该向不允许，UNCERTAIN：原程序位语义可能更复杂）；
 *  4. 该方向映射后三维尺寸均能放入目标空间（<= 空间尺寸），尺寸已含型变系数换算。
 */
export function isDirectionValid(input: DirectionValidityInput): boolean {
  const { box, container, orientation, space } = input;
  if (!Number.isInteger(orientation) || orientation < 0 || orientation >= ORIENTATION_COUNT) {
    return false;
  }
  // 规则 2：六向允许摆放（allowDirections 缺省时全部允许）
  if (box.allowDirections?.[orientation] === false) {
    return false;
  }
  // 规则 3：六向承托级别
  const support = box.supportClasses[orientation] ?? 0;
  if (support <= 0) {
    // TODO/UNCERTAIN: 原程序对 0x68 承托字节的具体判定可能包含"能否承托自身"等附加条件
    return false;
  }
  // 规则 4：型变后尺寸可容纳（orientDims 已统一做型变换算）
  const [dx, dy, dz] = orientDims(box, orientation);
  const sx = space ? space.dx : container.innerLength;
  const sy = space ? space.dy : container.innerWidth;
  const sz = space ? space.dz : container.innerHeight;
  return dx <= sx && dy <= sy && dz <= sz;
}

/** 返回某货物在整柜中所有有效方向（按 0..5 顺序） */
export function validOrientations(box: Box, container: Container, space?: SpaceBlock): number[] {
  const result: number[] = [];
  for (let o = 0; o < ORIENTATION_COUNT; o++) {
    if (isDirectionValid({ box, container, orientation: o, space })) {
      result.push(o);
    }
  }
  return result;
}
