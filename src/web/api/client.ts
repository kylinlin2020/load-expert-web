import type { Box, Container, LoadOptions, MultiPlanResult, PackResult } from '../../types';

/** 装柜方案记录（与后端 plans 表对齐） */
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

// 默认走同源相对路径（Vite 代理转发到后端），避免 localhost IPv6 解析差异；
// 部署时可通过 VITE_API_BASE 覆盖为完整后端地址
const BASE_URL: string = import.meta.env.VITE_API_BASE || '';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, `无法连接后端服务（${BASE_URL}），请确认已运行 npm run server`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | undefined)?.error ?? `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  baseURL: BASE_URL,

  // 健康检查
  health: () => request<{ status: string; service: string }>('GET', '/api/health'),

  // 货物 CRUD
  listBoxes: () => request<{ items: Box[] }>('GET', '/api/boxes').then((r) => r.items),
  createBox: (b: Partial<Box>) => request<Box>('POST', '/api/boxes', b),
  updateBox: (id: string, b: Partial<Box>) => request<Box>('PUT', `/api/boxes/${id}`, b),
  deleteBox: (id: string) => request<void>('DELETE', `/api/boxes/${id}`),

  // 柜型 CRUD
  listContainers: () => request<{ items: Container[] }>('GET', '/api/containers').then((r) => r.items),
  createContainer: (c: Partial<Container>) => request<Container>('POST', '/api/containers', c),
  updateContainer: (id: string, c: Partial<Container>) => request<Container>('PUT', `/api/containers/${id}`, c),
  deleteContainer: (id: string) => request<void>('DELETE', `/api/containers/${id}`),

  // 装柜计算
  calculate: (payload: CalculatePayload) => request<PackResult>('POST', '/api/plans/calculate', payload),
  // 多柜自动装载
  calculateMulti: (payload: CalculateMultiPayload) => request<MultiPlanResult>('POST', '/api/plans/calculate-multi', payload),

  // 方案 CRUD
  listPlans: () => request<{ items: PlanRecord[] }>('GET', '/api/plans').then((r) => r.items),
  getPlan: (id: number) => request<PlanRecord>('GET', `/api/plans/${id}`),
  createPlan: (p: { name: string; containerId: string | number; boxes: Box[]; result: PackResult }) =>
    request<PlanRecord>('POST', '/api/plans', p),
  deletePlan: (id: number) => request<void>('DELETE', `/api/plans/${id}`),
};

export default api;
