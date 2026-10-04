/**
 * 柜型编辑弹窗的表单逻辑（**纯函数，抽出来是为了能单测**）
 *
 * ## 为什么要抽
 *
 * 这段逻辑曾经只存在于 `ContainersView.vue` 里，于是出了一个**两边互相抵消的 bug**：
 *   - `toPayload()` 发的是 SQLite 列名 `length/width/height`
 *   - 服务端数据层 `updateContainer()` 恰好也收列名
 * 两处错误抵消，服务端版一直"正常"；而按接口声明（`Partial<Container>`，领域名
 * `innerLength/…`）实现的静态版就暴露了：
 *   - 改柜型尺寸：**保存提示成功，值却不变**（`c.innerLength` 为 undefined → 回退旧值）
 *   - 新建柜型：**尺寸全是 0**（`c.innerLength ?? 0`）
 *
 * 两者都不报错，只有用户实际操作才暴露。
 *
 * 抽出后 `test/container-payload.test.ts` 直接 import 这里的**真函数**，
 * 而不是手抄一份副本 —— 手抄的副本挡不住回归：视图改了它不会跟着改，
 * 测试就会变成自证清白。
 */
import type { Container } from '../../types/index.js';

/** 表单形状（与领域对象不同名，这里用 length/width/height 更贴近录入习惯） */
export interface ContainerForm {
  name: string;
  label: string;
  description: string;
  length: number;
  width: number;
  height: number;
  weightCapacity: number;
  dimensionUnit: string;
  weightUnit: string;
  cornerLength: number;
  cornerWidth: number;
  cornerHeight: number;
  doorWidth: number;
  doorHeight: number;
  emptyWeight: number;
  cost: number;
  unit: string;
}

export function defaultContainerForm(): ContainerForm {
  return {
    name: '',
    label: '',
    description: '',
    // 与 SEED_CONTAINERS 的 20GP 一致 —— 同一个应用里不该有两个"20GP 尺寸"，
    // 否则用户会问"为什么种子柜是 5800，新增柜型却预填 5898"
    length: 5800,
    width: 2340,
    height: 2380,
    weightCapacity: 21770,
    dimensionUnit: 'mm',
    weightUnit: 'kg',
    cornerLength: 0,
    cornerWidth: 0,
    cornerHeight: 0,
    doorWidth: 0,
    doorHeight: 0,
    emptyWeight: 0,
    cost: 0,
    unit: '',
  };
}

/**
 * 表单 → API 载荷
 *
 * **字段名必须是领域名**（`innerLength/innerWidth/innerHeight`），
 * 与 `ApiShape.createContainer` 声明的 `Partial<Container>` 一致。
 * 表单内部用 length/width/height 没问题，但**跨出这个函数前必须转成领域名**。
 */
export function containerFormToPayload(f: ContainerForm): Partial<Container> {
  const hasCorner = f.cornerLength > 0 || f.cornerWidth > 0 || f.cornerHeight > 0;
  const hasDoor = f.doorWidth > 0 || f.doorHeight > 0;
  return {
    name: f.name.trim(),
    label: f.label.trim() || undefined,
    description: f.description.trim() || undefined,
    innerLength: f.length,
    innerWidth: f.width,
    innerHeight: f.height,
    weightCapacity: f.weightCapacity,
    dimensionUnit: f.dimensionUnit,
    weightUnit: f.weightUnit,
    cornerDims: hasCorner ? ([f.cornerLength, f.cornerWidth, f.cornerHeight] as [number, number, number]) : undefined,
    doorDims: hasDoor ? ([f.doorWidth, f.doorHeight] as [number, number]) : undefined,
    emptyWeight: f.emptyWeight,
    cost: f.cost,
    unit: f.unit.trim() || undefined,
  };
}

/** 领域对象 → 表单（打开编辑弹窗时用） */
export function containerToForm(c: Container): ContainerForm {
  return {
    name: c.name,
    label: c.label ?? '',
    description: c.description ?? '',
    length: c.innerLength,
    width: c.innerWidth,
    height: c.innerHeight,
    weightCapacity: c.weightCapacity,
    dimensionUnit: c.dimensionUnit ?? 'mm',
    weightUnit: c.weightUnit ?? 'kg',
    cornerLength: c.cornerDims?.[0] ?? 0,
    cornerWidth: c.cornerDims?.[1] ?? 0,
    cornerHeight: c.cornerDims?.[2] ?? 0,
    doorWidth: c.doorDims?.[0] ?? 0,
    doorHeight: c.doorDims?.[1] ?? 0,
    emptyWeight: c.emptyWeight ?? 0,
    cost: c.cost ?? 0,
    unit: c.unit ?? '',
  };
}