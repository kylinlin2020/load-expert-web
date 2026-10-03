/**
 * 服务层：Fastify 应用（REST API）
 *
 * 端点一览：
 *   GET    /api/health                健康检查
 *   GET    /api/boxes                 货物列表
 *   POST   /api/boxes                 新增货物
 *   PUT    /api/boxes/:id             更新货物
 *   DELETE /api/boxes/:id             删除货物
 *   GET    /api/containers            柜型列表
 *   POST   /api/containers            新增柜型
 *   PUT    /api/containers/:id        更新柜型
 *   DELETE /api/containers/:id        删除柜型
 *   POST   /api/plans/calculate       执行装柜计算（调用算法引擎 load()）
 *   GET    /api/plans                 方案列表
 *   GET    /api/plans/:id             方案详情
 *   POST   /api/plans                 保存方案
 *   DELETE /api/plans/:id             删除方案
 *   GET    /api/backup/export         导出备份（?includePlans=0 可排除方案）
 *   POST   /api/backup/import         导入备份（?mode=merge|replace）
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { DatabaseSync } from 'node:sqlite';
import { load, planMultiContainer } from '../algorithm/index.js';
import {
  openDatabase,
  listBoxes,
  getBox,
  insertBox,
  updateBox,
  deleteBox,
  listContainers,
  getContainer,
  insertContainer,
  updateContainer,
  deleteContainer,
  listPlans,
  getPlan,
  insertPlan,
  deletePlan,
  type NewBox,
  type NewContainer,
} from '../db/index.js';
import { exportBackupSqlite, importBackupSqlite } from '../db/backup.js';
import { validateBackup, type BackupFile } from '../model/backup.js';
import { appVersion } from '../version.js';
import type { Box, Container, LoadOptions } from '../types/index.js';

export interface CalculateBody {
  containerId: number | string;
  items: Array<{ boxId: number | string; qty: number }>;
  strategy?: number;
  options?: LoadOptions;
}

export interface CalculateMultiBody {
  containerId: number | string;
  items: Array<{ boxId: number | string; qty: number }>;
  strategy?: number;
  options?: LoadOptions;
  /**
   * 连续多少个"空装柜"后判定该柜型已装尽（后端 `planMultiContainer` 默认 3）
   *
   * 前端多柜型循环装载时会显式传 1：一种柜型一旦装不进东西就该立刻换下一种，
   * 按默认的 3 会在每种柜型上白跑 3 次完整计算（多柜型下这个开销要乘以柜型数）。
   */
  maxEmptyRounds?: number;
}

export interface AppDeps {
  db?: DatabaseSync;
  dbPath?: string;
}

/** 构建 Fastify 应用（工厂，便于测试注入 :memory: 数据库） */
export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const db = deps.db ?? openDatabase(deps.dbPath);
  const app = Fastify({ logger: false });

  void app.register(cors, { origin: true });

  // 统一错误处理
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    void reply.status(e.statusCode ?? 500).send({ error: e.message ?? 'internal error' });
  });

  // 工具函数：解析数字 ID
  function parseId(raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('invalid id');
    }
    return n;
  }

  function numId(v: number | string | undefined): number {
    const n = typeof v === 'string' ? Number(v) : v;
    if (n === undefined || !Number.isFinite(n)) {
      return 0;
    }
    return n;
  }

  /**
   * 可选数字解析：字段**缺省**时返回 undefined（不改动原值）
   *
   * 修复的 bug：`numId(undefined)` 返回 0，导致部分更新（PUT 只带部分字段）
   * 会把未提供的数值字段**清零** —— 例如 `PUT /api/containers/4 {"cost":2800}`
   * 会把该柜型的内长/内宽/内高/载重全部写成 0。
   */
  function numIdOpt(v: number | string | null | undefined): number | undefined {
    if (v === undefined || v === null || v === '') {
      return undefined;
    }
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) ? n : undefined;
  }

  // ---------- 健康检查 ----------
  app.get('/api/health', async () => {
    return { status: 'ok', time: new Date().toISOString(), service: 'load-expert-web' };
  });

  // ---------- 货物 CRUD ----------
  app.get('/api/boxes', async () => {
    return { items: listBoxes(db) };
  });

  app.post('/api/boxes', async (request, reply) => {
    const b = request.body as Partial<NewBox>;
    if (!b || typeof b.name !== 'string' || !b.name.trim() || !Number.isFinite(Number(b.length)) || !Number.isFinite(Number(b.width)) || !Number.isFinite(Number(b.height))) {
      return reply.status(400).send({ error: 'name/length/width/height are required' });
    }
    const box = insertBox(db, {
      name: b.name.trim(),
      sku: typeof b.sku === 'string' ? b.sku.trim() || undefined : undefined,
      batch: typeof b.batch === 'string' ? b.batch.trim() || undefined : undefined,
      unitPrice: b.unitPrice !== undefined ? numId(b.unitPrice) : undefined,
      unit: typeof b.unit === 'string' ? b.unit.trim() || undefined : undefined,
      groupName: typeof b.groupName === 'string' ? b.groupName.trim() || undefined : undefined,
      description: typeof b.description === 'string' ? b.description.trim() || undefined : undefined,
      netWeight: b.netWeight !== undefined ? numId(b.netWeight) : undefined,
      color: typeof b.color === 'string' ? b.color.trim() || undefined : undefined,
      dimensionUnit: typeof b.dimensionUnit === 'string' ? b.dimensionUnit.trim() || 'mm' : 'mm',
      weightUnit: typeof b.weightUnit === 'string' ? b.weightUnit.trim() || 'kg' : 'kg',
      length: numId(b.length),
      width: numId(b.width),
      height: numId(b.height),
      weight: numId(b.weight),
      deformFactor: b.deformFactor !== undefined ? numId(b.deformFactor) : 1,
      deformTolerance: b.deformTolerance !== undefined ? numId(b.deformTolerance) : 0,
      allowDirections: b.allowDirections,
      maxPlaceDepth: b.maxPlaceDepth,
      supportFaces: b.supportFaces,
      stackClass: numId(b.stackClass) || 1,
      supportClasses: b.supportClasses,
      supportPct: b.supportPct,
      pcsCount: numId(b.pcsCount) || 1,
    });
    return reply.status(201).send(box);
  });

  app.put('/api/boxes/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const b = request.body as Partial<NewBox>;
    const updated = updateBox(db, id, {
      name: b?.name,
      sku: b ? (typeof b.sku === 'string' ? b.sku.trim() || undefined : undefined) : undefined,
      batch: b ? (typeof b.batch === 'string' ? b.batch.trim() || undefined : undefined) : undefined,
      unitPrice: b ? (b.unitPrice !== undefined ? numIdOpt(b.unitPrice) : undefined) : undefined,
      unit: b ? (typeof b.unit === 'string' ? b.unit.trim() || undefined : undefined) : undefined,
      groupName: b ? (typeof b.groupName === 'string' ? b.groupName.trim() || undefined : undefined) : undefined,
      description: b ? (typeof b.description === 'string' ? b.description.trim() || undefined : undefined) : undefined,
      netWeight: numIdOpt(b?.netWeight),
      color: b ? (typeof b.color === 'string' ? b.color.trim() || undefined : undefined) : undefined,
      dimensionUnit: b && typeof b.dimensionUnit === 'string' ? b.dimensionUnit.trim() || 'mm' : undefined,
      weightUnit: b && typeof b.weightUnit === 'string' ? b.weightUnit.trim() || 'kg' : undefined,
      length: numIdOpt(b?.length),
      width: numIdOpt(b?.width),
      height: numIdOpt(b?.height),
      weight: numIdOpt(b?.weight),
      deformFactor: numIdOpt(b?.deformFactor),
      deformTolerance: numIdOpt(b?.deformTolerance),
      allowDirections: b?.allowDirections,
      maxPlaceDepth: b?.maxPlaceDepth,
      supportFaces: b?.supportFaces,
      stackClass: numIdOpt(b?.stackClass),
      supportClasses: b?.supportClasses,
      supportPct: b?.supportPct,
      pcsCount: numIdOpt(b?.pcsCount),
    });
    if (!updated) {
      return reply.status(404).send({ error: 'box not found' });
    }
    return updated;
  });

  app.delete('/api/boxes/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const ok = deleteBox(db, id);
    if (!ok) {
      return reply.status(404).send({ error: 'box not found' });
    }
    return reply.status(204).send();
  });

  // ---------- 柜型 CRUD ----------
  app.get('/api/containers', async () => {
    return { items: listContainers(db) };
  });

  app.post('/api/containers', async (request, reply) => {
    // 领域字段名（innerLength/…），与 `ApiShape` 声明一致。
    // 见 db.ts 的 NewContainer 注释：为什么这里不用 SQLite 列名。
    const c = request.body as Partial<NewContainer>;
    if (!c || typeof c.name !== 'string' || !c.name.trim() || !Number.isFinite(numId(c.innerLength)) || !Number.isFinite(numId(c.innerWidth)) || !Number.isFinite(numId(c.innerHeight))) {
      return reply.status(400).send({ error: 'name/innerLength/innerWidth/innerHeight are required' });
    }
    const container = insertContainer(db, {
      name: c.name.trim(),
      innerLength: numId(c.innerLength),
      innerWidth: numId(c.innerWidth),
      innerHeight: numId(c.innerHeight),
      weightCapacity: numId(c.weightCapacity),
      label: c.label,
      description: typeof c.description === 'string' ? c.description.trim() || undefined : undefined,
      cornerDims: c.cornerDims,
      doorDims: c.doorDims,
      emptyWeight: c.emptyWeight !== undefined ? numId(c.emptyWeight) : undefined,
      cost: c.cost !== undefined ? numId(c.cost) : undefined,
      unit: typeof c.unit === 'string' ? c.unit.trim() || undefined : undefined,
      dimensionUnit: typeof c.dimensionUnit === 'string' ? c.dimensionUnit.trim() || 'mm' : 'mm',
      weightUnit: typeof c.weightUnit === 'string' ? c.weightUnit.trim() || 'kg' : 'kg',
    });
    return reply.status(201).send(container);
  });

  app.put('/api/containers/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const c = request.body as Partial<NewContainer>;
    const updated = updateContainer(db, id, {
      name: c?.name,
      innerLength: numIdOpt(c?.innerLength),
      innerWidth: numIdOpt(c?.innerWidth),
      innerHeight: numIdOpt(c?.innerHeight),
      weightCapacity: numIdOpt(c?.weightCapacity),
      label: c ? c.label : undefined,
      description: c ? (typeof c.description === 'string' ? c.description.trim() || undefined : undefined) : undefined,
      cornerDims: c?.cornerDims,
      doorDims: c?.doorDims,
      emptyWeight: numIdOpt(c?.emptyWeight),
      cost: numIdOpt(c?.cost),
      unit: c ? (typeof c.unit === 'string' ? c.unit.trim() || undefined : undefined) : undefined,
      dimensionUnit: c && typeof c.dimensionUnit === 'string' ? c.dimensionUnit.trim() || 'mm' : undefined,
      weightUnit: c && typeof c.weightUnit === 'string' ? c.weightUnit.trim() || 'kg' : undefined,
    });
    if (!updated) {
      return reply.status(404).send({ error: 'container not found' });
    }
    return updated;
  });

  app.delete('/api/containers/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const ok = deleteContainer(db, id);
    if (!ok) {
      return reply.status(404).send({ error: 'container not found' });
    }
    return reply.status(204).send();
  });

  // ---------- 装柜计算 ----------
  app.post('/api/plans/calculate', async (request, reply) => {
    const body = request.body as CalculateBody;
    if (!body || !body.containerId || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({ error: 'containerId and items are required' });
    }
    const container = getContainer(db, numId(body.containerId));
    if (!container) {
      return reply.status(404).send({ error: 'container not found' });
    }
    const boxes: Box[] = [];
    for (const item of body.items) {
      const box = getBox(db, numId(item.boxId));
      if (!box) {
        return reply.status(400).send({ error: `box not found: ${item.boxId}` });
      }
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty <= 0) {
        return reply.status(400).send({ error: `invalid qty for box ${item.boxId}` });
      }
      boxes.push({ ...box, quantity: qty });
    }
    const strategy = Number.isInteger(body.strategy) ? (body.strategy as number) : 3;
    const result = load({
      boxes,
      container: container as Container,
      strategy,
      options: body.options,
    });
    return result;
  });

  // ---------- 多柜自动装载 ----------
  app.post('/api/plans/calculate-multi', async (request, reply) => {
    const body = request.body as CalculateMultiBody;
    if (!body || !body.containerId || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({ error: 'containerId and items are required' });
    }
    const container = getContainer(db, numId(body.containerId));
    if (!container) {
      return reply.status(404).send({ error: 'container not found' });
    }
    const boxes: Box[] = [];
    for (const item of body.items) {
      const box = getBox(db, numId(item.boxId));
      if (!box) {
        return reply.status(400).send({ error: `box not found: ${item.boxId}` });
      }
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty <= 0) {
        return reply.status(400).send({ error: `invalid qty for box ${item.boxId}` });
      }
      boxes.push({ ...box, quantity: qty });
    }
    const strategy = Number.isInteger(body.strategy) ? (body.strategy as number) : 3;
    const result = planMultiContainer({
      boxes,
      container: container as Container,
      strategy,
      options: body.options,
      maxEmptyRounds: Number.isInteger(body.maxEmptyRounds) && body.maxEmptyRounds! > 0 ? body.maxEmptyRounds : undefined,
    });
    return result;
  });

  // ---------- 装柜方案 CRUD ----------
  app.get('/api/plans', async () => {
    return { items: listPlans(db) };
  });

  app.get('/api/plans/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const plan = getPlan(db, id);
    if (!plan) {
      return reply.status(404).send({ error: 'plan not found' });
    }
    return plan;
  });

  app.post('/api/plans', async (request, reply) => {
    const b = request.body as { name?: string; containerId?: number | string; boxes?: Box[]; result?: unknown };
    if (!b || typeof b.name !== 'string' || !b.name.trim() || b.containerId === undefined || !Array.isArray(b.boxes) || !b.result) {
      return reply.status(400).send({ error: 'name/containerId/boxes/result are required' });
    }
    const plan = insertPlan(db, {
      name: b.name.trim(),
      containerId: numId(b.containerId),
      boxes: b.boxes as Box[],
      result: b.result as never,
    });
    return reply.status(201).send(plan);
  });

  app.delete('/api/plans/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const ok = deletePlan(db, id);
    if (!ok) {
      return reply.status(404).send({ error: 'plan not found' });
    }
    return reply.status(204).send();
  });

  // ── 备份 / 恢复 ────────────────────────────────────────────────────────────
  // 格式与校验在 src/model/backup.ts，编排在 src/model/backupApply.ts，
  // 与静态版（IndexedDB）**共用同一份** —— 两边数据因此可以互相迁移。
  app.get('/api/backup/export', async (request, reply) => {
    const q = request.query as { includePlans?: string };
    const includePlans = q.includePlans !== '0';
    const file = await exportBackupSqlite(db, appVersion.version, includePlans);
    return reply.send(file);
  });

  app.post('/api/backup/import', async (request, reply) => {
    const q = request.query as { mode?: string };
    const mode = q.mode === 'replace' ? 'replace' : 'merge';
    // 前端已经把文件读成对象了，这里**再校验一遍**（validateBackup 与 parseBackup
    // 共用同一套规则），而不是信任"前端已经验过了" —— 两套规则迟早会分叉。
    let file: BackupFile;
    try {
      file = validateBackup(request.body);
    } catch (e) {
      // 格式错误要**原样把中文消息回给前端**（界面直接显示它），不要包成通用报错
      return reply.status(400).send({ error: e instanceof Error ? e.message : '备份文件无效' });
    }
    const outcome = await importBackupSqlite(db, file, mode);
    return reply.send(outcome);
  });

  return app;
}
