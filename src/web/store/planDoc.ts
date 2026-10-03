/**
 * 待打印的装柜单据（跨路由传递）
 *
 * 打印/报表是**独立路由**（/report），而计算结果住在 CalculateView 的组件状态里，
 * `router.push` 不会带着组件状态走。故用这个模块级 store 交接：
 *
 * - CalculateView 算出结果后 `setPlanDoc(...)` 再跳转到 /report
 * - PlansView 打印历史方案时同样 `setPlanDoc(...)`
 * - ReportView 读它渲染报表并调 `window.print()`
 *
 * 内存里刻意**不做深拷贝**：PackResult / Box 体积不小，复制一份纯属浪费；
 * 交接后源视图不会再修改这些对象（一次计算的结果是冻结的）。
 *
 * ## 但要落一份到 sessionStorage
 * 纯内存版有个明显的坑：**在 /report 上按 F5 或复制链接给别人，单据就空了**
 * （只看到"没有可打印的装柜结果"）。现场拿着链接重开页面是很常见的操作，
 * 所以序列化一份存 sessionStorage，模块初始化时读回来。
 * 用 sessionStorage 而非 localStorage：单据是"当前这一票货"的临时产物，
 * 关掉标签页就该清掉，不该留到下次开工还看见上一次的方案。
 */
import { reactive } from 'vue';
import type { Box, PackResult } from '../types';

export interface PlanDocPayload {
  /** 计算结果（装柜单据的数据源） */
  result: PackResult;
  /** 货物元数据（名称/SKU/尺寸/重量），打印报表必需 */
  boxes: Box[];
  /** 方案名称（PDF 文件名与页眉用） */
  planName: string;
  /** 柜门在哪一端：true = x 最大端。容器模型未记录门位（只有门尺寸），故显式传递 */
  doorAtMaxX: boolean;
  /**
   * 每种货物本次**申请**的数量（boxId → 件数）
   *
   * 刻意与 `boxes[].quantity` 分开：货物管理里 Box.quantity 是货物主档的默认数量
   * （实测库里就是 1），**不是**本次要装多少。报表要对比"申请 vs 装入"
   * 才能看出少装了哪一档，所以单独传。
   *
   * 值为 `null` = 用户**没填数量**，语义是「不限，塞满柜子为止」，
   * 报表上要显示成"不限"而不是某个由几何容量算出来的假数。
   */
  requested: Record<string, number | null>;
  /** 单柜 / 多柜循环。多柜时柜号从 1 起 */
  multi?: boolean;
  /** 多柜循环时，这是第几号柜（1 起）；单柜为 undefined */
  containerIndex?: number;
  /** 多柜循环时的柜总数 */
  containerTotal?: number;
}

const STORE_KEY = 'load_expert_plan_doc';

/** 从 sessionStorage 恢复单据；数据损坏时静默放弃（宁可没单据，也不要渲染出错的单据） */
function restore(): PlanDocPayload | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as PlanDocPayload;
    // 最小可用性校验：报表完全依赖 result.placements / result.container
    if (!v || !v.result || !Array.isArray(v.result.placements) || !v.result.container) return null;
    return v;
  } catch {
    return null;
  }
}

export const planDoc = reactive<{ current: PlanDocPayload | null }>({ current: restore() });

export function setPlanDoc(payload: PlanDocPayload): void {
  planDoc.current = payload;
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式/配额不足时不该让"出单据"整个失败 —— 内存里那份仍然可用
  }
}

/** 离开报表页时清掉，避免下次直接打开 /report 看到上一次的旧单据 */
export function clearPlanDoc(): void {
  planDoc.current = null;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 容器显示名（含自定义标签），两处报表/CSV 共用同一口径 */
export function containerLabel(result: PackResult): string {
  const c = result.container;
  return `${c.label ? c.label + ' · ' : ''}${c.name}`.trim();
}