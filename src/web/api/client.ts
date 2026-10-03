/**
 * API 入口：按构建模式在「服务端」与「纯静态」之间二选一
 *
 * 视图层只 import 本文件，**对数据存在哪里完全无感**。
 *
 * ## 两种构建
 *
 * | 命令 | 数据来源 | 算法在哪跑 | 路由 | 产物 |
 * |---|---|---|---|---|
 * | `npm run build:web` | 服务端 SQLite（经 /api） | 服务端 | history | 需配后端 |
 * | `npm run build:web:static` | 浏览器 IndexedDB | **浏览器** | hash | 纯静态，扔哪都能跑 |
 *
 * 用 Vite 的 `--mode static` 而不是 `VITE_XXX=1 vite build`：
 * 前者在 PowerShell / cmd 下都能用，后者要额外引 cross-env。
 *
 * ## 为什么静态版要 hash 路由
 *
 * GitHub Pages（以及大多数对象存储 / 静态托管）把 `/仓库名/装柜计算` 这种路径请求
 * 直接返回 404 —— 它们不做 SPA 的 history fallback。
 * `createWebHashHistory()` 把路由放进 `#` 之后，服务器只需回一个 index.html，
 * 于是同一份产物在 GitHub Pages 项目站、用户站、子目录、U 盘里都能跑。
 *
 * ## 已知取舍：两个实现都会进包
 *
 * 这里用静态 import 把两个实现都引进来，再按构建期常量挑一个。
 * 代价：**服务端版的包里也会带上 localClient + IndexedDB 适配器 + 算法引擎**
 * （实测约 30 KB，占 1.68 MB 的 1.8%，gzip 后更小），永远不会被执行。
 *
 * 换掉它需要在 Vite 里做虚拟模块或 alias（按 mode 替换本文件），
 * 复杂度与 30 KB 不成比例，所以**刻意保持现状**。
 * 换句话说：为了"构建配置零耦合"这点确定性，接受一份几乎察觉不到的冗余。
 *
 * 若将来要彻底去掉，正确的做法是把这一层做成 `virtual:data-api` 虚拟模块
 * 由 vite.config.ts 按 mode 提供 —— 但那会让"改构建方式"变成一件需要读 Vite 配置的事。
 */
import { httpApi } from './httpClient.js';
import { getLocalApi } from './localClient.js';
import { IS_STATIC_BUILD } from './buildEnv.js';
import type { ApiShape } from './types.js';

export { IS_STATIC_BUILD };

export const api: ApiShape = IS_STATIC_BUILD ? getLocalApi() : httpApi;

/**
 * 统一错误类型：两个实现都提供带 status 的 Error
 *
 * 这不是装饰 —— 视图层统一按 `e.status` 判断是不是 404。
 * 跨类 `instanceof` 在两个实现各自定义错误类时不可靠，故在此做鸭子类型转换。
 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 把任意实现抛出的错误规整成带 status 的 ApiError */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) {
    return e;
  }
  const st = (e as { status?: unknown } | null)?.status;
  return new ApiError(typeof st === 'number' ? st : 0, e instanceof Error ? e.message : String(e));
}

// 保持既有 import 路径不变：视图里写的是 `from '../api/client'`
export type { PlanRecord, CalculatePayload, CalculateMultiPayload, ApiShape } from './types.js';

export default api;