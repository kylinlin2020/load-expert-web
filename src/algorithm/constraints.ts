/**
 * 约束判定
 *
 * 对齐逆向文档约束处理：
 *  - 堆码级别 STACK_CLASS（cargo +0x11c）：上层货物堆码级别不得高于下层承载级别
 *  - 承托级别 / 底部承托比例：放置位置与下层接触面积 >= SUPPORT_PCT（0x490c6b 承托判定）
 *  - 重量容量：CON.WEIGHT_CAPACITY
 *  - PCS_COUNT：输出件数 = 箱数 * 每箱小件数
 *
 * 原程序"重量/承托比例字段到代码的完整映射"未还原，以下为业务等价实现，
 * 标注 TODO/UNCERTAIN 的细节以文档为准。
 */
import type { Box, Container, Placement, SpaceBlock } from '../types/index.js';

export interface ConstraintCheckInput {
  box: Box;
  container: Container;
  /** 已用重量（kg） */
  usedWeight: number;
  /** 已用体积（mm^3） */
  usedVolume: number;
  /** 尝试放入的箱数 */
  count: number;
  /** 放置原点与尺寸（用于承托面积计算） */
  placement?: Pick<Placement, 'x' | 'y' | 'z' | 'dims'>;
  /** 目标空间（用于承托/尺寸判定） */
  space?: SpaceBlock;
  /** 下方承托放置（用于承托级别/堆码级别判定） */
  below?: Placement;
  /** 候选块底面与下方承托放置的 xy 接触面积（mm^2），由调用方按实际重叠计算 */
  contactArea?: number;
  /** 候选块自身底面积（mm^2），contactArea / footprintArea 即底部承托比例 */
  footprintArea?: number;
  /** 规则开关（stackRulesEnabled / supportRulesEnabled，缺省 true） */
  enabled?: { stack?: boolean; support?: boolean };
}

export interface ConstraintCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * 体积容量：新放置体积不超柜内容积（含已用）
 */
export function checkVolumeCapacity(input: ConstraintCheckInput): ConstraintCheckResult {
  const { box, container, usedVolume, count, placement } = input;
  const dims = placement?.dims ?? [box.length, box.width, box.height];
  const vol = dims[0] * dims[1] * dims[2] * count;
  const containerVolume = container.innerLength * container.innerWidth * container.innerHeight;
  if (usedVolume + vol > containerVolume + 1e-9) {
    return { ok: false, reason: 'volume-exceed' };
  }
  return { ok: true };
}

/**
 * 重量容量：已用重量 + 新箱重量 <= 柜载重
 */
export function checkWeightCapacity(input: ConstraintCheckInput): ConstraintCheckResult {
  const { box, container, usedWeight, count } = input;
  const addWeight = box.weight * count;
  if (usedWeight + addWeight > container.weightCapacity + 1e-9) {
    return { ok: false, reason: 'weight-exceed' };
  }
  return { ok: true };
}

/**
 * 堆码级别（STACK_CLASS，cargo +0x11c）：
 * 上层货物的堆码级别不得超过下方承托放置的承托级别。
 * 底层放置（z=0，容器地板）视为无限承托，允许任何级别。
 */
export function checkStackClass(input: ConstraintCheckInput): ConstraintCheckResult {
  const { box, placement, below } = input;
  if (!placement || placement.z <= 1e-9) {
    return { ok: true };
  }
  if (below && box.stackClass > below.supportClass) {
    return { ok: false, reason: 'stack-class-exceed' };
  }
  return { ok: true };
}

/**
 * 承托级别 / 底部承托比例（0x490c6b 语义近似）
 * 规则：
 *  1. 若下方有货物，则下方货物的承托级别（该方向 supportClasses）必须 >= 当前货物堆码级别
 *     —— 该判定由 checkStackClass 承担；
 *  2. 底部承托比例：接触面积 / 候选块底面积 >= supportPct[2]。
 *     比例上限为 1，>1 视为字段非法。
 *  未找到下方承托（悬空）且字段要求承托时拒绝。
 *  TODO/UNCERTAIN：原程序按"方向承托字节 0x68"逐方向判定，
 *  且 SUPPORT_PCT_* 三个轴向（x/y/z）的精确换算未完全还原；
 *  此处按货物 z 轴（承托面法向）取 supportPct[2] 作为底部承托比例。
 */
export function checkSupport(input: ConstraintCheckInput): ConstraintCheckResult {
  const { box, placement, contactArea, footprintArea } = input;
  if (!placement) {
    return { ok: true };
  }
  if (placement.z <= 1e-9) {
    // 直接放在容器地板上，无需承托判定
    return { ok: true };
  }
  const required = box.supportPct?.[2] ?? 0;
  if (required <= 1e-9) {
    // 未要求底部承托
    return { ok: true };
  }
  if (required > 1 + 1e-9) {
    // 若要求超过 1.0 视为不可承托
    return { ok: false, reason: 'support-pct-invalid' };
  }
  if (footprintArea === undefined || footprintArea <= 0 || contactArea === undefined) {
    // 离地放置但找不到任何承托 → 悬空
    return { ok: false, reason: 'no-support' };
  }
  const ratio = contactArea / footprintArea;
  if (ratio < required - 1e-6) {
    return { ok: false, reason: 'support-pct-exceed' };
  }
  return { ok: true };
}

/**
 * 统一约束入口：体积、重量、堆码、承托
 * enabled 开关缺省全部开启；stackRulesEnabled=false 跳过堆码判定，
 * supportRulesEnabled=false 跳过承托判定（体积/重量始终生效）。
 */
export function checkConstraints(input: ConstraintCheckInput): ConstraintCheckResult {
  const checks: Array<(i: ConstraintCheckInput) => ConstraintCheckResult> = [checkVolumeCapacity, checkWeightCapacity];
  if (input.enabled?.stack !== false) {
    checks.push(checkStackClass);
  }
  if (input.enabled?.support !== false) {
    checks.push(checkSupport);
  }
  for (const check of checks) {
    const r = check(input);
    if (!r.ok) {
      return r;
    }
  }
  return { ok: true };
}

/** 计算件数（PCS_COUNT 语义）：箱数 * 每箱小件数 */
export function countPieces(box: Box, cartons: number): number {
  return cartons * box.pcsCount;
}
