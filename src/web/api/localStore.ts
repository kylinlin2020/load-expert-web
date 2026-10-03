/**
 * 静态版的业务数据层（IndexedDB 上的 CRUD + 种子）
 *
 * 与 `src/db/db.ts`（SQLite 版）**逐条对齐**语义：
 * - 三张表同名同字段（boxes / containers / plans）
 * - 行↔领域对象的映射走同一个 `src/model/rowMapping.ts`
 * - 种子柜型走同一个 `SEED_CONTAINERS`
 * - `created_at` 用本地时间格式，与 SQLite 的 `datetime('now')` 语义一致
 * - 列表排序：boxes/containers 按 id 升序，plans 按 id 倒序（最近在前）
 *
 * 之所以能这样对齐：二者共用 `RowStore` 这个 5 方法的窄接口，
 * 差别只在"怎么存字节"，不在"存什么、怎么解释"。
 */
import type { Box, Container, PackResult } from '../../types/index.js';
import {
  rowToBox,
  rowToContainer,
  rowToPlan,
  SEED_CONTAINERS,
  type BoxRow,
  type ContainerRow,
  type PlanRow,
} from '../../model/rowMapping.js';
import type { RowStore, StoreName } from './rowStore.js';
import type { BackupStoreAdapter } from '../../model/backupApply.js';
import type { PlanRecord } from './types.js';

/** 与 SQLite `datetime('now')` 同格式（YYYY-MM-DD HH:MM:SS，本地时间） */
function nowSql(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** SQLite 侧 `numId` 的等价物：把 string / number 的 id 解析为正整数 */
export function numId(v: string | number | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === undefined || !Number.isFinite(n)) {
    return 0;
  }
  return n;
}

export class LocalStore {
  constructor(private readonly db: RowStore) {}

  /**
   * 首次运行时写入种子柜型
   *
   * 与 db.ts 的 `seed()` 同规则：**containers 表非空就跳过**。
   * 用户删光了柜型后不会再被塞回种子（否则"删掉 20GP"永远删不掉）。
   */
  async seedIfEmpty(): Promise<void> {
    if ((await this.db.count('containers')) > 0) {
      return;
    }
    for (const s of SEED_CONTAINERS) {
      // SEED_CONTAINERS 用的是 **SQLite 列名**（length/width/height），
      // 而 insertContainer 收的是 **领域字段名**（innerLength/…），这里做一次转换
      await this.insertContainer({
        name: s.name,
        innerLength: s.length,
        innerWidth: s.width,
        innerHeight: s.height,
        weightCapacity: s.weightCapacity,
        label: s.label,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 货物
  // -------------------------------------------------------------------------

  async listBoxes(): Promise<Box[]> {
    const rows = await this.db.all<BoxRow>('boxes');
    return rows.map(rowToBox);
  }

  async getBox(id: string | number): Promise<Box | null> {
    const row = await this.db.get<BoxRow>('boxes', numId(id));
    return row ? rowToBox(row) : null;
  }

  async insertBox(b: Partial<Box>): Promise<Box> {
    // 领域对象的 id 是**字符串**（rowToBox 用 String(row.id)），
    // 而存储主键是自增**数字**。直接把字符串回传会让 "1" 与 1 成为两条不同记录 ——
    // 实测：更新一次后列表出现重复行，删除也删不掉（`all()` 里 `1 !== "1"`）。
    // 这与 §9.29 里 containerIds 的 string/number 不匹配是同一类问题。
    // 且 id 为空时必须让键**缺失**（不能是 undefined，见 put 的注释）。
    const id = b.id !== undefined && b.id !== '' ? numId(b.id) : undefined;
    const row = await this.db.put<BoxRow>('boxes', {
      ...(id === undefined ? {} : { id }),
      name: b.name ?? '',
      sku: b.sku ?? null,
      batch: b.batch ?? null,
      unit_price: b.unitPrice ?? null,
      unit: b.unit ?? null,
      group_name: b.groupName ?? null,
      description: b.description ?? null,
      net_weight: b.netWeight ?? null,
      color: b.color ?? null,
      dimension_unit: b.dimensionUnit ?? 'mm',
      weight_unit: b.weightUnit ?? 'kg',
      length: b.length ?? 0,
      width: b.width ?? 0,
      height: b.height ?? 0,
      weight: b.weight ?? 0,
      deform_factor: b.deformFactor ?? 1,
      deform_tolerance: b.deformTolerance ?? 0,
      allow_directions: JSON.stringify(b.allowDirections ?? [true, true, true, true, true, true]),
      max_place_depth: JSON.stringify(b.maxPlaceDepth ?? [0, 0, 0, 0, 0, 0]),
      support_faces: JSON.stringify(b.supportFaces ?? [true, true, true, true, true, true]),
      stack_class: b.stackClass ?? 1,
      support_stack_class: JSON.stringify(b.supportClasses ?? [5, 5, 5, 5, 5, 5]),
      support_pct: JSON.stringify(b.supportPct ?? [1, 1, 1]),
      pcs_count: b.pcsCount ?? 1,
      created_at: nowSql(),
    });
    return rowToBox(row);
  }

  async updateBox(id: string | number, b: Partial<Box>): Promise<Box | null> {
    const cur = await this.getBox(id);
    if (!cur) {
      return null;
    }
    // 与 db.ts 的 updateBox 同一套「nullish 回退」语义：
    // 未提供的字段保持原值，显式 null 则写 null
    const next = {
      ...cur,
      ...b,
      id: cur.id,
      sku: b.sku !== undefined ? b.sku : cur.sku,
      batch: b.batch !== undefined ? b.batch : cur.batch,
      unitPrice: b.unitPrice !== undefined ? b.unitPrice : cur.unitPrice,
      unit: b.unit !== undefined ? b.unit : cur.unit,
      groupName: b.groupName !== undefined ? b.groupName : cur.groupName,
      description: b.description !== undefined ? b.description : cur.description,
      netWeight: b.netWeight !== undefined ? b.netWeight : cur.netWeight,
      color: b.color !== undefined ? b.color : cur.color,
      dimensionUnit: b.dimensionUnit !== undefined ? b.dimensionUnit : cur.dimensionUnit,
      weightUnit: b.weightUnit !== undefined ? b.weightUnit : cur.weightUnit,
      length: b.length ?? cur.length,
      width: b.width ?? cur.width,
      height: b.height ?? cur.height,
      weight: b.weight ?? cur.weight,
      deformFactor: b.deformFactor !== undefined ? b.deformFactor : cur.deformFactor,
      deformTolerance: b.deformTolerance !== undefined ? b.deformTolerance : cur.deformTolerance,
      allowDirections: b.allowDirections ?? cur.allowDirections,
      maxPlaceDepth: b.maxPlaceDepth ?? cur.maxPlaceDepth,
      supportFaces: b.supportFaces ?? cur.supportFaces,
      stackClass: b.stackClass ?? cur.stackClass,
      supportClasses: b.supportClasses ?? cur.supportClasses,
      supportPct: b.supportPct ?? cur.supportPct,
      pcsCount: b.pcsCount ?? cur.pcsCount,
    };
    return this.insertBox(next);
  }

  async deleteBox(id: string | number): Promise<boolean> {
    return this.db.remove('boxes', numId(id));
  }

  // -------------------------------------------------------------------------
  // 柜型
  // -------------------------------------------------------------------------

  async listContainers(): Promise<Container[]> {
    const rows = await this.db.all<ContainerRow>('containers');
    return rows.map(rowToContainer);
  }

  async getContainer(id: string | number): Promise<Container | null> {
    const row = await this.db.get<ContainerRow>('containers', numId(id));
    return row ? rowToContainer(row) : null;
  }

  async insertContainer(c: Partial<Container>): Promise<Container> {
    // 同 insertBox：领域 id 是字符串，存储主键是数字，必须归一
    const id = c.id !== undefined && c.id !== '' ? numId(c.id) : undefined;
    const row = await this.db.put<ContainerRow>('containers', {
      ...(id === undefined ? {} : { id }),
      name: c.name ?? '',
      length: c.innerLength ?? 0,
      width: c.innerWidth ?? 0,
      height: c.innerHeight ?? 0,
      weight_capacity: c.weightCapacity ?? 0,
      label: c.label ?? null,
      description: c.description ?? null,
      corner_dims: c.cornerDims ? JSON.stringify(c.cornerDims) : null,
      door_dims: c.doorDims ? JSON.stringify(c.doorDims) : null,
      empty_weight: c.emptyWeight ?? null,
      cost: c.cost ?? null,
      unit: c.unit ?? null,
      dimension_unit: c.dimensionUnit ?? 'mm',
      weight_unit: c.weightUnit ?? 'kg',
      created_at: nowSql(),
    });
    return rowToContainer(row);
  }

  async updateContainer(id: string | number, c: Partial<Container>): Promise<Container | null> {
    const cur = await this.getContainer(id);
    if (!cur) {
      return null;
    }
    const next = {
      ...cur,
      label: c.label !== undefined ? c.label : cur.label,
      description: c.description !== undefined ? c.description : cur.description,
      innerLength: c.innerLength ?? cur.innerLength,
      innerWidth: c.innerWidth ?? cur.innerWidth,
      innerHeight: c.innerHeight ?? cur.innerHeight,
      weightCapacity: c.weightCapacity ?? cur.weightCapacity,
      cornerDims: c.cornerDims !== undefined ? c.cornerDims : cur.cornerDims,
      doorDims: c.doorDims !== undefined ? c.doorDims : cur.doorDims,
      emptyWeight: c.emptyWeight !== undefined ? c.emptyWeight : cur.emptyWeight,
      cost: c.cost !== undefined ? c.cost : cur.cost,
      unit: c.unit !== undefined ? c.unit : cur.unit,
      dimensionUnit: c.dimensionUnit !== undefined ? c.dimensionUnit : cur.dimensionUnit,
      weightUnit: c.weightUnit !== undefined ? c.weightUnit : cur.weightUnit,
      // id 保持不变（下面覆盖）
    } as Partial<Container> & { id: string };
    next.id = cur.id;
    return this.insertContainer(next);
  }

  async deleteContainer(id: string | number): Promise<boolean> {
    return this.db.remove('containers', numId(id));
  }

  // -------------------------------------------------------------------------
  // 方案
  // -------------------------------------------------------------------------

  /** 按 id 倒序（最近新建在前），与 SQLite 的 ORDER BY id DESC 一致 */
  async listPlans(): Promise<PlanRecord[]> {
    const rows = await this.db.all<PlanRow>('plans');
    return rows.sort((a, b) => b.id - a.id).map(rowToPlan);
  }

  async getPlan(id: number): Promise<PlanRecord | null> {
    const row = await this.db.get<PlanRow>('plans', numId(id));
    return row ? rowToPlan(row) : null;
  }

  /**
   * 新增方案
   * @param id 省略时由自增分配；指定时按该 id 写入（**仅备份恢复用**）。
   *            `createdAt` 同理 —— 备份恢复必须保住原创建时间，
   *            否则方案列表排序与"何时算的"全部失真。
   */
  async insertPlan(
    p: { name: string; containerId: string | number; boxes: Box[]; result: PackResult },
    id?: number,
    createdAt?: string,
  ): Promise<PlanRecord> {
    const row = await this.db.put<PlanRow>('plans', {
      ...(id === undefined ? {} : { id }),
      name: p.name,
      container_id: numId(p.containerId),
      boxes_json: JSON.stringify(p.boxes),
      result_json: JSON.stringify(p.result),
      created_at: createdAt ?? nowSql(),
    });
    return rowToPlan(row);
  }

  async deletePlan(id: number): Promise<boolean> {
    return this.db.remove('plans', numId(id));
  }

  /** 覆盖式恢复用：清空全部业务数据，返回被清掉的行数 */
  async clearAll(): Promise<{ boxes: number; containers: number; plans: number }> {
    // 顺序与 SQLite 版一致：**先 plans**，将来若启用外键强制也不会立刻炸
    const plans = await this.db.clear('plans');
    const boxes = await this.db.clear('boxes');
    const containers = await this.db.clear('containers');
    return { boxes, containers, plans };
  }

  // -------------------------------------------------------------------------
  // 备份适配器
  // -------------------------------------------------------------------------

  /**
   * 暴露为备份模块需要的最小接口
   *
   * 与 SQLite 版（`sqliteBackupAdapter`）一一对应，编排逻辑共用
   * `src/model/backupApply.ts`，所以两边的导入语义不可能走偏。
   *
   * `put*` 内部已经会把 id 归一为数字（见本文件开头的说明），
   * 因此"按备份里的 id 写回"在这里是天然成立的。
   */
  asBackupAdapter(): BackupStoreAdapter {
    return {
      listBoxes: () => this.listBoxes(),
      listContainers: () => this.listContainers(),
      listPlans: () => this.listPlans(),
      putBox: async (box: Box) => {
        await this.insertBox(box);
      },
      putContainer: async (c: Container) => {
        await this.insertContainer(c);
      },
      putPlan: async (p) => {
        await this.insertPlan({ name: p.name, containerId: p.containerId, boxes: p.boxes, result: p.result }, p.id, p.createdAt);
      },
      deletePlan: (id: number) => this.deletePlan(id),
      clearAll: () => this.clearAll(),
    };
  }

  /** 暴露底层存储（将来做其它存储级功能时用） */
  raw(): RowStore {
    return this.db;
  }
}

export type { StoreName };