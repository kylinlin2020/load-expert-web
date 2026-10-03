/**
 * 行记录 ↔ 领域对象的映射（**纯模块，不依赖任何存储实现**）
 *
 * ## 为什么要抽出来
 *
 * 映射里有一段**有实际价值的脏数据修正**：`parseBoolArr`
 * （库里曾出现 `allow_directions = [true,true,1,1,1,1]`，布尔数组里混进数字；
 *  方向判定用 `=== false`，`0 !== false` → 该方向被误当成"未禁止"，
 *  **装载率被静默算错且无任何报错**）。
 *
 * 静态版（IndexedDB）要与服务端版（SQLite）**共用同一份映射**：
 * 一旦各写一份，这条修正规则迟早只在一边存在，两边行为分叉且极难发现。
 * 所以把它连同 `rowToBox` / `rowToContainer` / `rowToPlan` 一起提到本模块，
 * 两侧数据层都从这里取。
 */
import type { Box, Container, PackResult } from '../types/index.js';

// ---------------------------------------------------------------------------
// 行结构（与 SQLite 列名一一对应；IndexedDB 侧复用同样的字段名）
// ---------------------------------------------------------------------------

export interface BoxRow {
  id: number;
  name: string;
  sku: string | null;
  batch: string | null;
  unit_price: number | null;
  unit: string | null;
  group_name: string | null;
  description: string | null;
  net_weight: number | null;
  color: string | null;
  dimension_unit: string | null;
  weight_unit: string | null;
  length: number;
  width: number;
  height: number;
  weight: number;
  deform_factor: number | null;
  deform_tolerance: number | null;
  allow_directions: string;
  max_place_depth: string;
  support_faces: string;
  stack_class: number;
  support_stack_class: string;
  support_pct: string;
  pcs_count: number;
  created_at: string;
}

export interface ContainerRow {
  id: number;
  name: string;
  length: number;
  width: number;
  height: number;
  weight_capacity: number;
  label: string | null;
  description: string | null;
  corner_dims: string | null;
  door_dims: string | null;
  empty_weight: number | null;
  cost: number | null;
  unit: string | null;
  dimension_unit: string | null;
  weight_unit: string | null;
  created_at: string;
}

export interface PlanRow {
  id: number;
  name: string;
  container_id: number;
  boxes_json: string;
  result_json: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 安全解析
// ---------------------------------------------------------------------------

/**
 * 安全解析 JSON 数组列
 * @param raw     数据库里的原始字符串
 * @param len     期望长度（数组类字段的长度是语义的一部分：六向=6、承托比例=3）
 * @returns 解析结果；非法 JSON / 非数组 / 长度不符时返回 null
 */
export function tryParseArr(raw: string | null, len: number): unknown[] | null {
  if (!raw) {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length !== len) {
      return null;
    }
    return v as unknown[];
  } catch {
    return null;
  }
}

/**
 * 布尔数组列的强制归一化
 *
 * 背景：库里出现过 `allow_directions = [true,true,1,1,1,1]` 这种
 * 「布尔数组里混进数字」的脏数据。JSON.parse 不会报错，数字会原样进入算法；
 * 方向判定用 `=== false` 判断，`0` 不等于 `false` → 该方向被误当成"未禁止"，
 * **装载率被静默算错且没有任何报错**。
 *
 * 故统一归一化：只有显式的 false / 0 / null / '' 才算"禁止"，其余一律算允许。
 */
export function parseBoolArr(raw: string | null, fallback: boolean[]): boolean[] {
  const v = tryParseArr(raw, fallback.length);
  if (!v) {
    return fallback;
  }
  return v.map((x) => !(x === false || x === 0 || x === null || x === ''));
}

/** 数字数组列的强制归一化（非有限数退回 0） */
export function parseNumArr(raw: string | null, fallback: number[]): number[] {
  const v = tryParseArr(raw, fallback.length);
  if (!v) {
    return fallback;
  }
  return v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0));
}

// ---------------------------------------------------------------------------
// 行 -> 领域对象
// ---------------------------------------------------------------------------

export function rowToBox(row: BoxRow): Box {
  return {
    id: String(row.id),
    name: row.name,
    sku: row.sku ?? undefined,
    batch: row.batch ?? undefined,
    unitPrice: row.unit_price ?? undefined,
    unit: row.unit ?? undefined,
    groupName: row.group_name ?? undefined,
    description: row.description ?? undefined,
    netWeight: row.net_weight ?? undefined,
    color: row.color ?? undefined,
    dimensionUnit: row.dimension_unit ?? 'mm',
    weightUnit: row.weight_unit ?? 'kg',
    length: row.length,
    width: row.width,
    height: row.height,
    weight: row.weight,
    deformFactor: row.deform_factor ?? 1,
    deformTolerance: row.deform_tolerance ?? 0,
    stackClass: row.stack_class,
    allowDirections: parseBoolArr(row.allow_directions, [true, true, true, true, true, true]),
    maxPlaceDepth: parseNumArr(row.max_place_depth, [0, 0, 0, 0, 0, 0]),
    supportFaces: parseBoolArr(row.support_faces, [true, true, true, true, true, true]),
    supportClasses: parseNumArr(row.support_stack_class, [5, 5, 5, 5, 5, 5]),
    supportPct: parseNumArr(row.support_pct, [1, 1, 1]) as [number, number, number],
    pcsCount: row.pcs_count,
    // 主数据不含数量，quantity 由装柜计算的 items 提供；默认 1 供算法可用
    quantity: 1,
  };
}

export function rowToContainer(row: ContainerRow): Container {
  return {
    id: String(row.id),
    name: row.name,
    innerLength: row.length,
    innerWidth: row.width,
    innerHeight: row.height,
    weightCapacity: row.weight_capacity,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    cornerDims: row.corner_dims
      ? (parseNumArr(row.corner_dims, [0, 0, 0]) as [number, number, number])
      : undefined,
    doorDims: row.door_dims ? (parseNumArr(row.door_dims, [0, 0]) as [number, number]) : undefined,
    emptyWeight: row.empty_weight ?? undefined,
    cost: row.cost ?? undefined,
    unit: row.unit ?? undefined,
    dimensionUnit: row.dimension_unit ?? 'mm',
    weightUnit: row.weight_unit ?? 'kg',
  };
}

export function rowToPlan(row: PlanRow): {
  id: number;
  name: string;
  containerId: number;
  boxes: Box[];
  result: PackResult;
  createdAt: string;
} {
  return {
    id: row.id,
    name: row.name,
    containerId: row.container_id,
    boxes: JSON.parse(row.boxes_json) as Box[],
    result: JSON.parse(row.result_json) as PackResult,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// 种子数据（SQLite 与 IndexedDB 两边**必须一致**）
// ---------------------------------------------------------------------------

/**
 * 内置 20GP / 40GP / 40HQ 三个标准柜型
 *
 * 种子只是**默认参考值**（ISO 668）。现实中同一型号的柜型尺寸差异很大，
 * 用户实测其 40HQ 就是 11900×2340×2680 而非 ISO 的 13556×2352×2698。
 * 因此这里不做任何"自动校正" —— 柜型尺寸必须由用户按实际设备在「柜型管理」里维护。
 *
 * 这份数据原先硬编码在 db.ts 的 `seed()` 里。静态版要有一份自己的种子，
 * 放两处必然漂移（用户会看到"服务端版三个柜型、静态版四个"这种怪事），
 * 故提到本模块由两边共用。
 */
export const SEED_CONTAINERS: ReadonlyArray<{
  name: string;
  length: number;
  width: number;
  height: number;
  weightCapacity: number;
  label: string;
}> = [
  { name: '20 尺干货柜', length: 5898, width: 2352, height: 2393, weightCapacity: 21770, label: '20GP' },
  { name: '40 尺干货柜', length: 12032, width: 2352, height: 2393, weightCapacity: 26800, label: '40GP' },
  { name: '40 尺高柜', length: 13556, width: 2352, height: 2698, weightCapacity: 26800, label: '40HQ' },
];