/**
 * API 层共享类型：两个实现（服务端 HTTP / 静态版 IndexedDB）共用的契约
 *
 * 视图层只认这个 `ApiShape`。切换数据来源对它们完全透明 ——
 * 这正是"同一个代码库出两个版本"的关键：只有数据层与路由/构建配置不同。
 */
import type { Box, Container, LoadOptions, MultiPlanResult, PackResult } from '../../types/index.js';

/** 装柜方案记录（与后端 plans 表、IndexedDB 的 plans 表都对齐） */
export interface PlanRecord {
  id: number;
  name: string;
  containerId: number;
  boxes: Box[];
  result: PackResult;
  createdAt: string;
}

/** 计算请求体 */
export interface CalculatePayload {
  containerId: string | number;
  items: Array<{ boxId: string | number; qty: number }>;
  strategy?: number;
  options?: LoadOptions;
}

/** 多柜计算请求体 */
export interface CalculateMultiPayload {
  containerId: string | number;
  items: Array<{ boxId: string | number; qty: number }>;
  strategy?: number;
  options?: LoadOptions;
  /** 连续空装柜次数上限（不传则后端默认 3）。见 CalculateMultiBody 处的说明 */
  maxEmptyRounds?: number;
}

/** 错误：带 HTTP 状态码的 ApiError 语义在静态版也有意义（0 = 非网络原因） */
export interface ApiErrorLike extends Error {
  status: number;
}

/** 新增 Box 的入参（不含 id / quantity，quantity 由计算时的 items 决定） */
export type NewBoxInput = Partial<Box>;
export type NewContainerInput = Partial<Container>;

/**
 * 数据访问接口 —— 视图层用到的全部数据操作
 *
 * 刻意做成**全部返回 Promise**：HTTP 实现天然是异步，
 * 静态版即使 IndexedDB 也是异步（localClient 因此可以在 Node 测试里
 * 用内存适配器跑同样的代码，而不必让视图层区分同步/异步）。
 */
export interface ApiShape {
  /** 诊断信息（服务端版是后端地址；静态版是 'local'） */
  baseURL: string;
  /** 是否为"数据全在浏览器"的静态版 */
  readonly isLocal: boolean;

  health: () => Promise<{ status: string; service: string }>;

  listBoxes: () => Promise<Box[]>;
  createBox: (b: NewBoxInput) => Promise<Box>;
  updateBox: (id: string, b: NewBoxInput) => Promise<Box>;
  deleteBox: (id: string) => Promise<void>;

  listContainers: () => Promise<Container[]>;
  createContainer: (c: NewContainerInput) => Promise<Container>;
  updateContainer: (id: string, c: NewContainerInput) => Promise<Container>;
  deleteContainer: (id: string) => Promise<void>;

  calculate: (payload: CalculatePayload) => Promise<PackResult>;
  calculateMulti: (payload: CalculateMultiPayload) => Promise<MultiPlanResult>;

  listPlans: () => Promise<PlanRecord[]>;
  getPlan: (id: number) => Promise<PlanRecord>;
  createPlan: (p: { name: string; containerId: string | number; boxes: Box[]; result: PackResult }) => Promise<PlanRecord>;
  deletePlan: (id: number) => Promise<void>;
}