/**
 * 静态版 API 客户端：数据在 IndexedDB，算法在浏览器里跑
 *
 * ## 关键前提（已实测验证）
 *
 * `src/algorithm/**` **零 Node 依赖** —— 只 import 同目录模块与 `src/types` 的类型。
 * 所以 `load()` / `planMultiContainer()` 可以原样在浏览器里执行，
 * **不需要服务端，也不需要 Worker**（单次计算 6ms 量级，主线程足够，
 * 真要大批量再考虑挪 Worker）。
 *
 * 也就是说静态版与服务端版**跑的是同一份算法代码**，
 * 不存在"两套实现算出不同装载率"的风险 —— 这比把算法重写一遍可靠得多。
 *
 * ## 校验口径
 *
 * `calculate` / `calculateMulti` 照抄 server/app.ts 的参数校验与错误文案，
 * 让两个版本在同样的错误输入下报同样的错（前端只弹 `e.message`）。
 */
import type { Box, Container, LoadOptions, MultiPlanResult, PackResult } from '../../types/index.js';
import { load, planMultiContainer } from '../../algorithm/load.js';
import { exportBackup, importBackup } from '../../model/backupApply.js';
import { appVersion } from '../../version.js';
import { createIdbStore } from './idbAdapter.js';
import { LocalStore, numId } from './localStore.js';
import type { RowStore } from './rowStore.js';
import type { ApiShape, CalculateMultiPayload, CalculatePayload, PlanRecord } from './types.js';

export class LocalApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function newStore(db: RowStore): LocalStore {
  return new LocalStore(db);
}

/** 版本号只用于写进备份文件头给人看，取静态字符串避免多一次 import 副作用 */
const APP_VERSION: string = appVersion.version;

/** 默认实例：真实 IndexedDB（浏览器） */
let singleton: ApiShape | null = null;

export function getLocalApi(): ApiShape {
  if (!singleton) {
    singleton = createLocalApi();
  }
  return singleton;
}

/**
 * 构造一个静态版 API 实现
 * @param db 存储适配器；不传则用真实 IndexedDB。
 *             传内存适配器即可在 Node 测试里跑**完全相同的代码路径**。
 */
export function createLocalApi(db?: RowStore): ApiShape {
  const store = newStore(db ?? createIdbStore());
  let seeded: Promise<void> | null = null;
  /** 首次使用时确保种子已写入（并发调用只跑一次） */
  function ensureSeeded(): Promise<void> {
    if (!seeded) {
      seeded = store.seedIfEmpty();
    }
    return seeded;
  }

  async function getContainerOrThrow(id: string | number): Promise<Container> {
    const c = await store.getContainer(id);
    if (!c) {
      throw new LocalApiError(404, 'container not found');
    }
    return c;
  }

  /** items → Box[]（quantity 取本次请求值），与 server/app.ts 同逻辑 */
  async function resolveItems(items: CalculatePayload['items']): Promise<Box[]> {
    const out: Box[] = [];
    for (const item of items) {
      const box = await store.getBox(item.boxId);
      if (!box) {
        throw new LocalApiError(400, `box not found: ${item.boxId}`);
      }
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new LocalApiError(400, `invalid qty for box ${item.boxId}`);
      }
      out.push({ ...box, quantity: qty });
    }
    return out;
  }

  function optionsOf(payload: { options?: LoadOptions }): LoadOptions | undefined {
    return payload.options;
  }

  return {
    baseURL: 'local',
    isLocal: true,

    async health() {
      return { status: 'ok', service: 'local (IndexedDB)' };
    },

    // -------------------------------------------------------------------------
    // 货物
    // -------------------------------------------------------------------------
    async listBoxes() {
      await ensureSeeded();
      return store.listBoxes();
    },
    async createBox(b) {
      await ensureSeeded();
      return store.insertBox(b);
    },
    async updateBox(id, b) {
      const r = await store.updateBox(id, b);
      if (!r) {
        throw new LocalApiError(404, 'box not found');
      }
      return r;
    },
    async deleteBox(id) {
      await store.deleteBox(id);
    },

    // -------------------------------------------------------------------------
    // 柜型
    // -------------------------------------------------------------------------
    async listContainers() {
      await ensureSeeded();
      return store.listContainers();
    },
    async createContainer(c) {
      await ensureSeeded();
      return store.insertContainer(c);
    },
    async updateContainer(id, c) {
      const r = await store.updateContainer(id, c);
      if (!r) {
        throw new LocalApiError(404, 'container not found');
      }
      return r;
    },
    async deleteContainer(id) {
      await store.deleteContainer(id);
    },

    // -------------------------------------------------------------------------
    // 装柜计算（算法在浏览器里跑）
    // -------------------------------------------------------------------------
    async calculate(payload: CalculatePayload): Promise<PackResult> {
      if (payload.containerId == null) {
        throw new LocalApiError(400, 'containerId is required');
      }
      if (!Array.isArray(payload.items) || payload.items.length === 0) {
        throw new LocalApiError(400, 'items are required');
      }
      const container = await getContainerOrThrow(payload.containerId);
      const boxes = await resolveItems(payload.items);
      const strategy = Number.isInteger(payload.strategy) ? (payload.strategy as number) : 3;
      return load({ boxes, container, strategy, options: optionsOf(payload) });
    },

    async calculateMulti(payload: CalculateMultiPayload): Promise<MultiPlanResult> {
      if (payload.containerId == null) {
        throw new LocalApiError(400, 'containerId is required');
      }
      if (!Array.isArray(payload.items) || payload.items.length === 0) {
        throw new LocalApiError(400, 'items are required');
      }
      const container = await getContainerOrThrow(payload.containerId);
      const boxes = await resolveItems(payload.items);
      const strategy = Number.isInteger(payload.strategy) ? (payload.strategy as number) : 3;
      return planMultiContainer({
        boxes,
        container,
        strategy,
        options: optionsOf(payload),
        maxEmptyRounds: Number.isInteger(payload.maxEmptyRounds) && payload.maxEmptyRounds! > 0 ? payload.maxEmptyRounds : undefined,
      });
    },

    // -------------------------------------------------------------------------
    // 方案
    // -------------------------------------------------------------------------
    async listPlans() {
      await ensureSeeded();
      return store.listPlans();
    },
    async getPlan(id) {
      const p = await store.getPlan(id);
      if (!p) {
        throw new LocalApiError(404, 'plan not found');
      }
      return p;
    },
    async createPlan(p) {
      await ensureSeeded();
      // 与 server/app.ts 一致：containerId 必须是已存在的柜型
      await getContainerOrThrow(p.containerId);
      return store.insertPlan(p);
    },
    async deletePlan(id) {
      await store.deletePlan(id);
    },

    // -------------------------------------------------------------------------
    // 备份 / 恢复（数据在 IndexedDB，算法与编排仍是同一份共用代码）
    // -------------------------------------------------------------------------
    async exportBackup(opts) {
      await ensureSeeded();
      return exportBackup(store.asBackupAdapter(), APP_VERSION, opts?.includePlans ?? true);
    },

    async importBackup(file, mode) {
      await ensureSeeded();
      return importBackup(store.asBackupAdapter(), file, mode);
    },

    // -------------------------------------------------------------------------
    // 实测案例（算法反馈）
    // -------------------------------------------------------------------------
    listCases: () => store.listCases(),
    getCase: async (id) => {
      const c = await store.getCase(id);
      if (!c) throw new LocalApiError(404, 'case not found');
      return c;
    },
    createCase: async (c) => store.insertCase(c),
    updateCaseActual: async (id, actual) => {
      const r = await store.updateCaseActual(id, actual);
      if (!r) throw new LocalApiError(404, 'case not found');
      return r;
    },
    deleteCase: async (id) => {
      await store.deleteCase(id);
    },
  };
}

export { numId };
export type { PlanRecord };