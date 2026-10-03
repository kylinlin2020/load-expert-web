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

/** 种子数据：内置 20GP / 40GP / 40HQ 三个标准柜型 */
export function seed(db: DatabaseSync): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM containers').get() as { c: number };
  if ((count?.c ?? 0) > 0) {
    return;
  }
  const ins = db.prepare(
    `INSERT INTO containers (name, length, width, height, weight_capacity, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // 种子只是**默认参考值**（ISO 668）。现实中同一型号的柜型尺寸差异很大，
  // 用户实测其 40HQ 就是 11900×2340×2680 而非 ISO 的 13556×2352×2698。
  // 因此这里不做任何"自动校正" —— 柜型尺寸必须由用户按实际设备在「柜型管理」里维护。
  const seeds: Array<[string, number, number, number, number, string]> = [
    ['20 尺干货柜', 5898, 2352, 2393, 21770, '20GP'],
    ['40 尺干货柜', 12032, 2352, 2393, 26800, '40GP'],
    ['40 尺高柜', 13556, 2352, 2698, 26800, '40HQ'],
  ];
  for (const s of seeds) {
    ins.run(...s);
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

interface BoxRow {
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

interface ContainerRow {
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

/**
 * 安全解析 JSON 数组列
 * @param raw     数据库里的原始字符串
 * @param len     期望长度（数组类字段的长度是语义的一部分：六向=6、承托比例=3）
 * @returns 解析结果；非法 JSON / 非数组 / 长度不符时返回 null
 */
function tryParseArr(raw: string | null, len: number): unknown[] | null {
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
function parseBoolArr(raw: string | null, fallback: boolean[]): boolean[] {
  const v = tryParseArr(raw, fallback.length);
  if (!v) {
    return fallback;
  }
  return v.map((x) => !(x === false || x === 0 || x === null || x === ''));
}

/** 数字数组列的强制归一化（非有限数退回 0） */
function parseNumArr(raw: string | null, fallback: number[]): number[] {
  const v = tryParseArr(raw, fallback.length);
  if (!v) {
    return fallback;
  }
  return v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0));
}

interface PlanRow {
  id: number;
  name: string;
  container_id: number;
  boxes_json: string;
  result_json: string;
  created_at: string;
}

function rowToBox(row: BoxRow): Box {
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

function rowToContainer(row: ContainerRow): Container {
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

export function insertBox(db: DatabaseSync, b: NewBox): Box {
  const r = db
    .prepare(
      `INSERT INTO boxes (name, sku, batch, unit_price, unit, group_name, description, net_weight, color, dimension_unit, weight_unit,
                          length, width, height, weight, deform_factor, deform_tolerance,
                          allow_directions, max_place_depth, support_faces,
                          stack_class, support_stack_class, support_pct, pcs_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
  return getBox(db, Number(r.lastInsertRowid))!;
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

export function insertContainer(db: DatabaseSync, c: NewContainer): Container {
  const r = db
    .prepare(
      `INSERT INTO containers (name, length, width, height, weight_capacity, label, description,
                               corner_dims, door_dims, empty_weight, cost, unit, dimension_unit, weight_unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
  return getContainer(db, Number(r.lastInsertRowid))!;
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

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    containerId: row.container_id,
    boxes: JSON.parse(row.boxes_json) as Box[],
    result: JSON.parse(row.result_json) as PackResult,
    createdAt: row.created_at,
  };
}

export function insertPlan(db: DatabaseSync, p: NewPlan): Plan {
  const r = db
    .prepare(`INSERT INTO plans (name, container_id, boxes_json, result_json) VALUES (?, ?, ?, ?)`)
    .run(p.name, p.containerId, JSON.stringify(p.boxes), JSON.stringify(p.result));
  return getPlan(db, Number(r.lastInsertRowid))!;
}

export function deletePlan(db: DatabaseSync, id: number): boolean {
  const r = db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}
