/**
 * 备份 / 恢复的**共用编排**（存储无关）
 *
 * 两种存储（SQLite / IndexedDB）提供同一组语义，本文件把它们编排成
 * API 层唯一需要的东西：`exportBackup` / `importBackup`。
 * 各自的数据层（`src/db/backup.ts` / `src/web/api/localStore.ts`）
 * 只需提供一个 `BackupStoreAdapter`。
 *
 * ## 为什么编排必须只有一份
 *
 * 导入顺序不是随便定的：**必须 boxes → containers → plans**，
 * 因为 plans 要引用 `container_id`，柜型得先就位。
 * 这种"顺序错了不报错、只会让方案列表全空"的约定若各写一份，
 * 迟早只在一边写对 —— 与其指望 review 发现，不如结构上不给它机会。
 *
 * ## id 必须原样保留
 *
 * 存下来的 `PackResult` 里到处是 `boxId` 引用（`placements[].boxId`、
 * `CartonPlacement.boxId`、`SpaceBlock.baseBoxId`、`rejected[].boxId`），
 * `PlanRecord.containerId` 也指向柜型。导入时若重新分配 id 而漏改某处引用，
 * 界面不会报错，只会**默默显示错货名**。
 * 所以适配器的 `put*` 负责按 id 写回，由 round-trip 测试锁住：
 * 「导出 → 导入 → 再导出」必须完全相等。
 */
import { buildBackup, type BackupFile, type ImportMode, type BackupPlan } from './backup.js';
import type { LoadCase } from './case.js';
import type { Box, Container } from '../types/index.js';

export interface RecordCounts {
  boxes: number;
  containers: number;
  plans: number;
  cases?: number;
}

export interface ImportOutcome {
  mode: ImportMode;
  /** 实际写入（含覆盖）的条数 */
  written: RecordCounts;
  /** 覆盖模式下被清掉的原有条数 */
  removed: RecordCounts;
}

/** 两种存储都要满足的最小接口 */
export interface BackupStoreAdapter {
  listBoxes(): Promise<Box[]>;
  listContainers(): Promise<Container[]>;
  listPlans(): Promise<BackupPlan[]>;
  /** 实测案例。老适配器可能没实现，故设为可选 */
  listCases?(): Promise<LoadCase[]>;
  putBox(box: Box): Promise<void>;
  putContainer(container: Container): Promise<void>;
  putPlan(plan: BackupPlan): Promise<void>;
  putCase?(c: LoadCase): Promise<void>;
  deletePlan(id: number): Promise<boolean>;
  deleteCase?(id: number): Promise<boolean>;
  /** 清空全部业务数据（覆盖模式用），返回被清掉的行数 */
  clearAll(): Promise<RecordCounts>;
}

export async function exportBackup(
  store: BackupStoreAdapter,
  appVersion: string,
  includePlans = true,
): Promise<BackupFile> {
  return buildBackup({
    boxes: await store.listBoxes(),
    containers: await store.listContainers(),
    // 方案里存着完整计算结果，是文件里最占体积的部分，故可单独排除
    plans: includePlans ? (await store.listPlans()) : [],
    // 案例必须带 —— 它是算法反馈的载体，丢了就等于把用户积累的实测数据扔了
    cases: store.listCases ? await store.listCases() : [],
    appVersion,
  });
}

/**
 * 导入备份
 * @param mode
 *  - `merge`   按 id 对齐：文件里有的覆盖/新增，**文件里没有的现有记录一律保留**。
 *              备份里没有的种子柜型会活下来 —— 这正是"补数据/恢复"想要的
 *  - `replace` 先清空全部数据，再按文件原样写入（真正的"恢复到备份时状态"）
 */
export async function importBackup(
  store: BackupStoreAdapter,
  file: BackupFile,
  mode: ImportMode,
): Promise<ImportOutcome> {
  const removed: RecordCounts =
    mode === 'replace' ? await store.clearAll() : { boxes: 0, containers: 0, plans: 0 };

  // 顺序固定：boxes → containers → plans（plans 引用 container_id）
  let boxes = 0;
  for (const b of file.data.boxes) {
    await store.putBox(b);
    boxes++;
  }

  let containers = 0;
  for (const c of file.data.containers) {
    await store.putContainer(c);
    containers++;
  }

  let plans = 0;
  for (const p of file.data.plans) {
    // 方案是不可变快照，没有"更新"语义；先删后插 = 覆盖，且保住原 id 与创建时间。
    // 直接 put 同 id 在 SQLite 侧会撞主键，所以统一走删+插。
    await store.deletePlan(p.id);
    await store.putPlan(p);
    plans++;
  }

  // 案例同方案：不可变快照（computed 不可改），先删后插
  let cases = 0;
  if (file.data.cases && store.putCase) {
    for (const c of file.data.cases) {
      if (store.deleteCase) await store.deleteCase(c.id);
      await store.putCase(c);
      cases++;
    }
  }

  return {
    mode,
    written: { boxes, containers, plans, ...(store.putCase ? { cases } : {}) },
    removed,
  };
}