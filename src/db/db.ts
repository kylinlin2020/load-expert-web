/**
 * 数据层：SQLite 初始化、迁移与仓储函数
 *
 * 表结构对齐原软件语义（逆向文档 load_expert_algorithm_analysis.md）：
 * - BOX 表：REAL_/LOAD_ 三维尺寸、STACK_CLASS、A~F_SUPPORT_STACK_CLASS（六向承托级别）、
 *   SUPPORT_PCT_ 三维、NET/GROSS_WEIGHT、PCS_COUNT
 * - CON 表：内尺寸 + WEIGHT_CAPACITY
 * - SET 表（方案）：SET_ID/SET_NAME/DESCRIPTION（Web 版以 plans 表承载）
 *
 * 使用 Node 内置 node:sqlite（DatabaseSync），无需原生编译依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import type { Box, Container, PackResult } from '../types/index.js';
import {
  parseBoolArr,
  parseNumArr,
  rowToBox,
  rowToContainer,
  rowToPlan,
  SEED_CONTAINERS,
  type BoxRow,
  type ContainerRow,
  type PlanRow,
} from '../model/rowMapping.js';

/**
 * 行↔领域对象的映射（`rowToBox` / `rowToContainer` / `rowToPlan`）与种子数据
 * 都放在 `src/model/rowMapping.ts`，**与静态版（IndexedDB）共用**。
 * 原因见那个文件的注释 —— 尤其是 `parseBoolArr` 那条脏数据修正规则，
 * 两边各写一份迟早分叉，且分叉后装载率会静默算错。
 */
export { parseBoolArr, parseNumArr, rowToBox, rowToContainer, rowToPlan };

/** 数据库文件默认位置：项目根 data/load-expert.db */
export function defaultDbPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/src/db -> 项目根
  const root = path.resolve(here, '..', '..', '..');
  return process.env.DB_PATH || path.join(root, 'data', 'load-expert.db');
}

/** 打开数据库（自动建目录、迁移、写种子数据） */
export function openDatabase(dbPath?: string): DatabaseSync {
  const file = dbPath ?? defaultDbPath();
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  seed(db);
  return db;
}

/** 建表迁移（幂等，IF NOT EXISTS） */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT,
      batch TEXT,
      unit_price REAL,
      unit TEXT,
      group_name TEXT,
      description TEXT,
      net_weight REAL,
      color TEXT,
      dimension_unit TEXT DEFAULT 'mm',
      weight_unit TEXT DEFAULT 'kg',
      length REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      deform_factor REAL DEFAULT 1,
      deform_tolerance REAL DEFAULT 0,
      allow_directions TEXT NOT NULL DEFAULT '[1,1,1,1,1,1]',
      max_place_depth TEXT NOT NULL DEFAULT '[0,0,0,0,0,0]',
      support_faces TEXT NOT NULL DEFAULT '[1,1,1,1,1,1]',
      stack_class INTEGER NOT NULL DEFAULT 1,
      support_stack_class TEXT NOT NULL DEFAULT '[5,5,5,5,5,5]',
      support_pct TEXT NOT NULL DEFAULT '[1,1,1]',
      pcs_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      length REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      weight_capacity REAL NOT NULL DEFAULT 0,
      label TEXT,
      description TEXT,
      corner_dims TEXT,
      door_dims TEXT,
      empty_weight REAL,
      cost REAL,
      unit TEXT,
      dimension_unit TEXT DEFAULT 'mm',
      weight_unit TEXT DEFAULT 'kg',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      container_id INTEGER NOT NULL REFERENCES containers(id),
      boxes_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // 老库迁移：缺失的列补充（幂等容错，逐个 ADD COLUMN）
  // 注：SQLite 的 ADD COLUMN 一次仅能添加一列，列已存在时抛异常，捕获忽略
  const boxColumns: Array<[string, string]> = [
    ['sku', 'TEXT'],
    ['batch', 'TEXT'],
    ['unit_price', 'REAL'],
    ['unit', 'TEXT'],
    ['group_name', 'TEXT'],
    ['description', 'TEXT'],
    ['net_weight', 'REAL'],
    ['color', 'TEXT'],
    ['dimension_unit', "TEXT DEFAULT 'mm'"],
    ['weight_unit', "TEXT DEFAULT 'kg'"],
    ['deform_factor', 'REAL DEFAULT 1'],
    ['deform_tolerance', 'REAL DEFAULT 0'],
    ['allow_directions', "TEXT NOT NULL DEFAULT '[1,1,1,1,1,1]'"],
    ['max_place_depth', "TEXT NOT NULL DEFAULT '[0,0,0,0,0,0]'"],
    ['support_faces', "TEXT NOT NULL DEFAULT '[1,1,1,1,1,1]'"],
  ];
  for (const [col, type] of boxColumns) {
    try {
      db.exec(`ALTER TABLE boxes ADD COLUMN ${col} ${type}`);
    } catch {
      // 列已存在则忽略
    }
  }

  const containerColumns: Array<[string, string]> = [
    ['description', 'TEXT'],
    ['corner_dims', 'TEXT'],
    ['door_dims', 'TEXT'],
    ['empty_weight', 'REAL'],
    ['cost', 'REAL'],
    ['unit', 'TEXT'],
    ['dimension_unit', "TEXT DEFAULT 'mm'"],
    ['weight_unit', "TEXT DEFAULT 'kg'"],
  ];
  for (const [col, type] of containerColumns) {
    try {
      db.exec(`ALTER TABLE containers ADD COLUMN ${col} ${type}`);
    } catch {
      // 列已存在则忽略
    }
  }
}

/**
 * 种子数据：内置 20GP / 40GP / 40HQ 三个标准柜型
 *
 * 具体数值放在 `SEED_CONTAINERS`（src/model/rowMapping.ts），与静态版共用同一份，
 * 避免"两个版本的初始柜型不一样"这种无法解释的差异。
 */
export function seed(db: DatabaseSync): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM containers').get() as { c: number };
  if ((count?.c ?? 0) > 0) {
    return;
  }
  const ins = db.prepare(
    `INSERT INTO containers (name, length, width, height, weight_capacity, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const s of SEED_CONTAINERS) {
    ins.run(s.name, s.length, s.width, s.height, s.weightCapacity, s.label);
  }
}

/**
 * ~~已知错误种子值的定点校正~~ —— 已删除（2026-10-02）
 *
 * 原本自动把 label='40HQ' 的柜型改写成 ISO 值 13556×2352×2698。
 * **这是个错误的设计决定，已撤销**：
 *
 * 1. ISO 668 规定的 40HC 内尺寸确实是 13556×2352×2698，但**现实中大量集装箱并非严格按 ISO**。
 *    用户实测其实际柜型为 **11900×2340×2680**，并明确指出该柜能装下 630+330。
 *    程序不该凭一个标准去覆盖用户的实际设备参数 —— 这是"以我的假设夺走用户的数据"。
 * 2. 柜型是可编辑的主数据，程序**没有任何理由**在启动时静默改写它。
 *    即便旧值确实有错，也应该由用户在「柜型管理」里改，而不是后台偷偷 UPDATE。
 *
 * 保留的只有种子里 40HQ 的默认值（13556），并在界面上提示"请按实际柜型修改"。
 */

// ---------------------------------------------------------------------------
// 行 <-> 领域对象映射
// ---------------------------------------------------------------------------




export interface NewBox {
  name: string;
  sku?: string;
  batch?: string;
  unitPrice?: number;
  unit?: string;
  groupName?: string;
  description?: string;
  netWeight?: number;
  color?: string;
  dimensionUnit?: string;
  weightUnit?: string;
  length: number;
  width: number;
  height: number;
  weight?: number;
  deformFactor?: number;
  deformTolerance?: number;
  allowDirections?: readonly boolean[];
  maxPlaceDepth?: readonly number[];
  supportFaces?: readonly boolean[];
  stackClass?: number;
  supportClasses?: readonly number[];
  supportPct?: readonly [number, number, number];
  pcsCount?: number;
}

export interface NewContainer {
  name: string;
  length: number;
  width: number;
  height: number;
  weightCapacity?: number;
  label?: string;
  description?: string;
  cornerDims?: readonly [number, number, number];
  doorDims?: readonly [number, number];
  emptyWeight?: number;
  cost?: number;
  unit?: string;
  dimensionUnit?: string;
  weightUnit?: string;
}

// ---------------------------------------------------------------------------
// 货物 CRUD
// ---------------------------------------------------------------------------

export function listBoxes(db: DatabaseSync): Box[] {
  const rows = db.prepare('SELECT * FROM boxes ORDER BY id').all() as unknown as BoxRow[];
  return rows.map(rowToBox);
}

export function getBox(db: DatabaseSync, id: number): Box | null {
  const row = db.prepare('SELECT * FROM boxes WHERE id = ?').get(id) as BoxRow | undefined;
  return row ? rowToBox(row) : null;
}

/**
 * 内部：按列数组插入一行，返回落库后的 id
 *
 * ## 为什么要抽出来
 *
 * 备份恢复需要「以指定 id 插入」——`PackResult` 里到处是 `boxId` 引用
 * （`placements[].boxId`、`CartonPlacement.boxId`、`SpaceBlock.baseBoxId`、
 * `rejected[].boxId`），`PlanRecord.containerId` 也指向柜型。
 * 若导入时重新分配 id 而漏改某处引用，界面不会报错，只会**默默显示错货名**。
 *
 * 早先的写法是每个 `insert*` 各写一份列清单，加 id 支持就得把 24 个列名抄两遍 ——
 * 抄漏一列不会编译报错，只会静默丢字段。所以改成列数组拼 SQL，加 id 只是多一个元素。
 *
 * @param id 省略时由自增分配；指定时按该 id 写入（仅备份恢复用）
 * @note `table` / `cols` 全部来自本文件的字面量，**不接受外部输入**，无注入面。
 */
function insertRow(
  db: DatabaseSync,
  table: string,
  cols: string[],
  vals: unknown[],
  id?: number,
): number {
  const allCols = id === undefined ? cols : ['id', ...cols];
  const allVals = id === undefined ? vals : [id, ...vals];
  const placeholders = allVals.map(() => '?').join(', ');
  const r = db.prepare(`INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders})`).run(...(allVals as never[]));
  return id === undefined ? Number(r.lastInsertRowid) : id;
}

/** 货物表的列顺序（insertBox / 备份恢复共用） */
const BOX_COLS = [
  'name', 'sku', 'batch', 'unit_price', 'unit', 'group_name', 'description', 'net_weight', 'color',
  'dimension_unit', 'weight_unit',
  'length', 'width', 'height', 'weight', 'deform_factor', 'deform_tolerance',
  'allow_directions', 'max_place_depth', 'support_faces',
  'stack_class', 'support_stack_class', 'support_pct', 'pcs_count',
];

function boxVals(b: NewBox): unknown[] {
  return [
    b.name,
    b.sku ?? null,
    b.batch ?? null,
    b.unitPrice ?? null,
    b.unit ?? null,
    b.groupName ?? null,
    b.description ?? null,
    b.netWeight ?? null,
    b.color ?? null,
    b.dimensionUnit ?? 'mm',
    b.weightUnit ?? 'kg',
    b.length,
    b.width,
    b.height,
    b.weight ?? 0,
    b.deformFactor ?? 1,
    b.deformTolerance ?? 0,
    JSON.stringify(b.allowDirections ?? [true, true, true, true, true, true]),
    JSON.stringify(b.maxPlaceDepth ?? [0, 0, 0, 0, 0, 0]),
    JSON.stringify(b.supportFaces ?? [true, true, true, true, true, true]),
    b.stackClass ?? 1,
    JSON.stringify(b.supportClasses ?? [5, 5, 5, 5, 5, 5]),
    JSON.stringify(b.supportPct ?? [1, 1, 1]),
    b.pcsCount ?? 1,
  ];
}

export function insertBox(db: DatabaseSync, b: NewBox): Box {
  return getBox(db, insertRow(db, 'boxes', BOX_COLS, boxVals(b)))!;
}

/**
 * 以指定 id 新增货物（**仅备份恢复用**）
 *
 * 常规新增请用 `insertBox`。id 冲突时由调用方先判断 —— 这里不做 upsert，
 * 免得"到底覆盖了没有"变成一个要靠读日志才知道的事。
 */
export function insertBoxWithId(db: DatabaseSync, id: number, b: NewBox): Box {
  return getBox(db, insertRow(db, 'boxes', BOX_COLS, boxVals(b), id))!;
}

export function updateBox(db: DatabaseSync, id: number, b: Partial<NewBox>): Box | null {
  const cur = getBox(db, id);
  if (!cur) {
    return null;
  }
  const next: NewBox = {
    name: b.name ?? cur.name,
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
  db.prepare(
    `UPDATE boxes SET name=?, sku=?, batch=?, unit_price=?, unit=?, group_name=?, description=?, net_weight=?, color=?, dimension_unit=?, weight_unit=?,
                      length=?, width=?, height=?, weight=?, deform_factor=?, deform_tolerance=?,
                      allow_directions=?, max_place_depth=?, support_faces=?,
                      stack_class=?, support_stack_class=?, support_pct=?, pcs_count=? WHERE id=?`,
  ).run(
    next.name,
    next.sku ?? null,
    next.batch ?? null,
    next.unitPrice ?? null,
    next.unit ?? null,
    next.groupName ?? null,
    next.description ?? null,
    next.netWeight ?? null,
    next.color ?? null,
    next.dimensionUnit ?? 'mm',
    next.weightUnit ?? 'kg',
    next.length,
    next.width,
    next.height,
    next.weight ?? 0,
    next.deformFactor ?? 1,
    next.deformTolerance ?? 0,
    JSON.stringify(next.allowDirections ?? [true, true, true, true, true, true]),
    JSON.stringify(next.maxPlaceDepth ?? [0, 0, 0, 0, 0, 0]),
    JSON.stringify(next.supportFaces ?? [true, true, true, true, true, true]),
    next.stackClass ?? 1,
    JSON.stringify(next.supportClasses ?? [5, 5, 5, 5, 5, 5]),
    JSON.stringify(next.supportPct ?? [1, 1, 1]),
    next.pcsCount ?? 1,
    id,
  );
  return getBox(db, id);
}

export function deleteBox(db: DatabaseSync, id: number): boolean {
  const r = db.prepare('DELETE FROM boxes WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}

// ---------------------------------------------------------------------------
// 柜型 CRUD
// ---------------------------------------------------------------------------

export function listContainers(db: DatabaseSync): Container[] {
  const rows = db.prepare('SELECT * FROM containers ORDER BY id').all() as unknown as ContainerRow[];
  return rows.map(rowToContainer);
}

export function getContainer(db: DatabaseSync, id: number): Container | null {
  const row = db.prepare('SELECT * FROM containers WHERE id = ?').get(id) as ContainerRow | undefined;
  return row ? rowToContainer(row) : null;
}

/** 柜型表的列顺序（insertContainer / 备份恢复共用） */
const CONTAINER_COLS = [
  'name', 'length', 'width', 'height', 'weight_capacity', 'label', 'description',
  'corner_dims', 'door_dims', 'empty_weight', 'cost', 'unit', 'dimension_unit', 'weight_unit',
];

function containerVals(c: NewContainer): unknown[] {
  return [
    c.name,
    c.length,
    c.width,
    c.height,
    c.weightCapacity ?? 0,
    c.label ?? null,
    c.description ?? null,
    c.cornerDims ? JSON.stringify(c.cornerDims) : null,
    c.doorDims ? JSON.stringify(c.doorDims) : null,
    c.emptyWeight ?? null,
    c.cost ?? null,
    c.unit ?? null,
    c.dimensionUnit ?? 'mm',
    c.weightUnit ?? 'kg',
  ];
}

export function insertContainer(db: DatabaseSync, c: NewContainer): Container {
  return getContainer(db, insertRow(db, 'containers', CONTAINER_COLS, containerVals(c)))!;
}

/** 以指定 id 新增柜型（**仅备份恢复用**） */
export function insertContainerWithId(db: DatabaseSync, id: number, c: NewContainer): Container {
  return getContainer(db, insertRow(db, 'containers', CONTAINER_COLS, containerVals(c), id))!;
}

export function updateContainer(db: DatabaseSync, id: number, c: Partial<NewContainer>): Container | null {
  const cur = getContainer(db, id);
  if (!cur) {
    return null;
  }
  const next: NewContainer = {
    name: c.name ?? cur.name,
    length: c.length ?? cur.innerLength,
    width: c.width ?? cur.innerWidth,
    height: c.height ?? cur.innerHeight,
    weightCapacity: c.weightCapacity ?? cur.weightCapacity,
    label: c.label !== undefined ? c.label : cur.label,
    description: c.description !== undefined ? c.description : cur.description,
    cornerDims: c.cornerDims !== undefined ? c.cornerDims : cur.cornerDims,
    doorDims: c.doorDims !== undefined ? c.doorDims : cur.doorDims,
    emptyWeight: c.emptyWeight !== undefined ? c.emptyWeight : cur.emptyWeight,
    cost: c.cost !== undefined ? c.cost : cur.cost,
    unit: c.unit !== undefined ? c.unit : cur.unit,
    dimensionUnit: c.dimensionUnit !== undefined ? c.dimensionUnit : cur.dimensionUnit,
    weightUnit: c.weightUnit !== undefined ? c.weightUnit : cur.weightUnit,
  };
  db.prepare(
    `UPDATE containers SET name=?, length=?, width=?, height=?, weight_capacity=?, label=?, description=?,
                           corner_dims=?, door_dims=?, empty_weight=?, cost=?, unit=?, dimension_unit=?, weight_unit=? WHERE id=?`,
  ).run(
    next.name,
    next.length,
    next.width,
    next.height,
    next.weightCapacity ?? 0,
    next.label ?? null,
    next.description ?? null,
    next.cornerDims ? JSON.stringify(next.cornerDims) : null,
    next.doorDims ? JSON.stringify(next.doorDims) : null,
    next.emptyWeight ?? null,
    next.cost ?? null,
    next.unit ?? null,
    next.dimensionUnit ?? 'mm',
    next.weightUnit ?? 'kg',
    id,
  );
  return getContainer(db, id);
}

export function deleteContainer(db: DatabaseSync, id: number): boolean {
  const r = db.prepare('DELETE FROM containers WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}

// ---------------------------------------------------------------------------
// 装柜方案 CRUD
// ---------------------------------------------------------------------------

export interface NewPlan {
  name: string;
  containerId: number;
  boxes: Box[];
  result: PackResult;
}

export interface Plan {
  id: number;
  name: string;
  containerId: number;
  boxes: Box[];
  result: PackResult;
  createdAt: string;
}

export function listPlans(db: DatabaseSync): Plan[] {
  const rows = db.prepare('SELECT * FROM plans ORDER BY id DESC').all() as unknown as PlanRow[];
  return rows.map(rowToPlan);
}

export function getPlan(db: DatabaseSync, id: number): Plan | null {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
  return row ? rowToPlan(row) : null;
}

/**
 * 新增方案
 * @param id 省略时由自增分配；指定时按该 id 写入（**仅备份恢复用**）。
 *            `createdAt` 同理 —— 备份恢复必须保住原创建时间，
 *            否则方案列表的排序与"何时算的"会全部失真。
 */
export function insertPlan(db: DatabaseSync, p: NewPlan, id?: number, createdAt?: string): Plan {
  const id2 = insertRow(
    db,
    'plans',
    createdAt === undefined ? ['name', 'container_id', 'boxes_json', 'result_json'] : ['name', 'container_id', 'boxes_json', 'result_json', 'created_at'],
    createdAt === undefined
      ? [p.name, p.containerId, JSON.stringify(p.boxes), JSON.stringify(p.result)]
      : [p.name, p.containerId, JSON.stringify(p.boxes), JSON.stringify(p.result), createdAt],
    id,
  );
  return getPlan(db, id2)!;
}

/**
 * 清空全部业务数据（**仅备份恢复的覆盖模式用**）
 * @returns 删除的行数（按 表:行数 汇总的明细）
 *
 * 顺序：**先 plans 后 boxes/containers**。
 * plans 有 `container_id REFERENCES containers(id)`，虽然本项目没开
 * `PRAGMA foreign_keys`（SQLite 默认 OFF，那条子句目前只是文档说明），
 * 但清空顺序按依赖倒过来写，将来谁打开了外键强制也不会立刻炸。
 */
export function clearAll(db: DatabaseSync): { boxes: number; containers: number; plans: number } {
  const plans = Number(db.prepare('DELETE FROM plans').run().changes);
  const boxes = Number(db.prepare('DELETE FROM boxes').run().changes);
  const containers = Number(db.prepare('DELETE FROM containers').run().changes);
  return { boxes, containers, plans };
}

export function deletePlan(db: DatabaseSync, id: number): boolean {
  const r = db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}
