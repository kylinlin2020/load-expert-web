/**
 * 备份 / 恢复（SQLite 版）—— 只负责"怎么读写"，编排交给共用逻辑
 *
 * 编排（导入顺序、merge/replace 语义）在 `src/model/backupApply.ts`，
 * 与 IndexedDB 版共用同一份。文件格式与校验在 `src/model/backup.ts`。
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  clearAll,
  deletePlan,
  getBox,
  getContainer,
  insertBoxWithId,
  insertContainerWithId,
  insertPlan,
  listBoxes,
  listContainers,
  listPlans,
  updateBox,
  updateContainer,
  type NewBox,
  type NewContainer,
} from './db.js';
import {
  exportBackup as applyExport,
  importBackup as applyImport,
  type BackupStoreAdapter,
  type ImportOutcome,
} from '../model/backupApply.js';
import type { BackupFile, ImportMode } from '../model/backup.js';
import type { Box, Container } from '../types/index.js';

/** 领域对象 → 入库参数（去掉 id 与 quantity：前者按 id 单独写入，后者由计算时的 items 决定） */
function toNewBox(b: Box): NewBox {
  return {
    name: b.name,
    sku: b.sku,
    batch: b.batch,
    unitPrice: b.unitPrice,
    unit: b.unit,
    groupName: b.groupName,
    description: b.description,
    netWeight: b.netWeight,
    color: b.color,
    dimensionUnit: b.dimensionUnit ?? 'mm',
    weightUnit: b.weightUnit ?? 'kg',
    length: b.length,
    width: b.width,
    height: b.height,
    weight: b.weight,
    deformFactor: b.deformFactor ?? 1,
    deformTolerance: b.deformTolerance ?? 0,
    allowDirections: b.allowDirections,
    maxPlaceDepth: b.maxPlaceDepth,
    supportFaces: b.supportFaces,
    stackClass: b.stackClass,
    supportClasses: b.supportClasses,
    supportPct: b.supportPct,
    pcsCount: b.pcsCount ?? 1,
  };
}

function toNewContainer(c: Container): NewContainer {
  return {
    name: c.name,
    length: c.innerLength,
    width: c.innerWidth,
    height: c.innerHeight,
    weightCapacity: c.weightCapacity,
    label: c.label,
    description: c.description,
    cornerDims: c.cornerDims,
    doorDims: c.doorDims,
    emptyWeight: c.emptyWeight,
    cost: c.cost,
    unit: c.unit,
    dimensionUnit: c.dimensionUnit ?? 'mm',
    weightUnit: c.weightUnit ?? 'kg',
  };
}

/** SQLite → 备份适配器 */
export function sqliteBackupAdapter(db: DatabaseSync): BackupStoreAdapter {
  return {
    // db.ts 的读写是同步的（node:sqlite），这里包一层 Promise 让两种存储同形
    listBoxes: async () => listBoxes(db),
    listContainers: async () => listContainers(db),
    listPlans: async () => listPlans(db),

    async putBox(box: Box) {
      const id = Number(box.id);
      const nb = toNewBox(box);
      // id 已存在就更新，否则按指定 id 新增。
      // 不用 upsert 是为了"到底覆盖了没有"是显式的，而不是隐含在一条语句里
      if (getBox(db, id)) updateBox(db, id, nb);
      else insertBoxWithId(db, id, nb);
    },

    async putContainer(container: Container) {
      const id = Number(container.id);
      const nc = toNewContainer(container);
      if (getContainer(db, id)) updateContainer(db, id, nc);
      else insertContainerWithId(db, id, nc);
    },

    async putPlan(plan) {
      insertPlan(
        db,
        { name: plan.name, containerId: plan.containerId, boxes: plan.boxes, result: plan.result },
        plan.id,
        plan.createdAt,
      );
    },

    deletePlan: async (id: number) => deletePlan(db, id),
    clearAll: async () => clearAll(db),
  };
}

export function exportBackupSqlite(
  db: DatabaseSync,
  appVersion: string,
  includePlans = true,
): Promise<BackupFile> {
  return applyExport(sqliteBackupAdapter(db), appVersion, includePlans);
}

export function importBackupSqlite(
  db: DatabaseSync,
  file: BackupFile,
  mode: ImportMode,
): Promise<ImportOutcome> {
  return applyImport(sqliteBackupAdapter(db), file, mode);
}