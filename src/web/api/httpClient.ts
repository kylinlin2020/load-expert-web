/**
 * 服务端版 API 客户端（fetch → Fastify）
 *
 * 与 `localClient.ts`（静态版：IndexedDB 存数据 + 浏览器内直接跑算法）
 * 实现同一个 `ApiShape`，由 `client.ts` 按构建模式二选一。
 */
import type { Box, Container, MultiPlanResult, PackResult } from '../../types/index.js';
import type { ApiShape, CalculateMultiPayload, CalculatePayload, PlanRecord } from './types.js';
import type { BackupFile } from '../../model/backup.js';
import type { ImportOutcome } from '../../model/backupApply.js';
import { API_BASE as BASE_URL } from './buildEnv.js';

export class HttpApiError extends Error {
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
    throw new HttpApiError(0, `无法连接后端服务（${BASE_URL}），请确认已运行 npm run server`);
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
    throw new HttpApiError(res.status, msg);
  }
  return data as T;
}

export const httpApi: ApiShape = {
  baseURL: BASE_URL,
  isLocal: false,

  // 健康检查
  health: () => request<{ status: string; service: string }>('GET', '/api/health'),

  // 货物 CRUD
  listBoxes: () => request<{ items: Box[] }>('GET', '/api/boxes').then((r) => r.items),
  createBox: (b) => request<Box>('POST', '/api/boxes', b),
  updateBox: (id, b) => request<Box>('PUT', `/api/boxes/${id}`, b),
  deleteBox: (id) => request<void>('DELETE', `/api/boxes/${id}`),

  // 柜型 CRUD
  listContainers: () => request<{ items: Container[] }>('GET', '/api/containers').then((r) => r.items),
  createContainer: (c) => request<Container>('POST', '/api/containers', c),
  updateContainer: (id, c) => request<Container>('PUT', `/api/containers/${id}`, c),
  deleteContainer: (id) => request<void>('DELETE', `/api/containers/${id}`),

  // 装柜计算（服务端跑算法）
  calculate: (payload: CalculatePayload) => request<PackResult>('POST', '/api/plans/calculate', payload),
  calculateMulti: (payload: CalculateMultiPayload) => request<MultiPlanResult>('POST', '/api/plans/calculate-multi', payload),

  // 方案 CRUD
  listPlans: () => request<{ items: PlanRecord[] }>('GET', '/api/plans').then((r) => r.items),
  getPlan: (id) => request<PlanRecord>('GET', `/api/plans/${id}`),
  createPlan: (p) => request<PlanRecord>('POST', '/api/plans', p),
  deletePlan: (id) => request<void>('DELETE', `/api/plans/${id}`),

  // 备份 / 恢复
  exportBackup: async (opts) => {
    const q = opts?.includePlans === false ? '?includePlans=0' : '';
    return request<BackupFile>('GET', `/api/backup/export${q}`);
  },
  importBackup: (file, mode) => request<ImportOutcome>('POST', `/api/backup/import?mode=${mode}`, file),
};