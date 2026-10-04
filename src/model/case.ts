/**
 * 实测案例（算法反馈的载体）
 *
 * ## 为什么是这个东西
 *
 * 这个软件最有价值的反馈**不是**"界面点不动"，而是：
 * > 同样的柜型 + 同样的货物，算法算出 966 箱，现场实际只装到 900 箱。
 *
 * 这类数据能直接改进算法 —— 而算法是这个软件的核心竞争力。
 * 但它目前只能靠用户口头讲，讲完就丢了。
 * 所以把它变成**一条可累积的记录**：输入快照 + 算法输出 + 现场实测 + 差异。
 *
 * ## 三个设计要点
 *
 * 1. **柜型存快照，不存 id 引用。**
 *    用户事后调整了柜型尺寸，这条案例仍应反映"当时算的时候用的柜子"。
 *    存 id 引用会悄悄改写历史。
 *
 * 2. **`computed`（算法输出）与 `actual`（现场实测）分开存。**
 *    前者由程序填、不可改；后者由用户填、可随时补。
 *    分开才能算出"差多少"这个最关键的指标。
 *
 * 3. **差异是自动算的，不让用户手填。**
 *    手填的差异一定会和实际对不上。存原始数字，差异在读取时算。
 */
import type { Box, Container, LoadOptions, PackResult } from '../types/index.js';

/** 算法输出（程序填，不可改） */
export interface CaseComputed {
  /** 算出装了多少箱 */
  pieces: number;
  /** 装载率 0~1 */
  loadRate: number;
  /** 用了几���柜（单柜模式恒为 1） */
  containers: number;
  /** 总重量 kg */
  totalWeight: number;
  /** 占用体积 mm³ */
  usedVolume: number;
  /** 是否全部装完（false 表示有剩余，多柜模式下尤其要看） */
  allPacked: boolean;
  /** 剩余未装的货物（用于诊断"是没货还是装不下"） */
  remaining: Array<{ boxId: string; qty: number }>;
}

/** 现场实测（用户填，可后补） */
export interface CaseActual {
  /** 现场实际装了多少箱 */
  pieces?: number;
  /** 现场实际用了几个柜 */
  containers?: number;
  /** 备注：为什么不一样 */
  note?: string;
}

export interface LoadCase {
  id: number;
  name: string;
  createdAt: string;
  /** 柜型快照 */
  container: Container;
  /** 货物清单（含本次数量） */
  boxes: Box[];
  strategy: number;
  options?: LoadOptions;
  computed: CaseComputed;
  actual: CaseActual;
}

/** 由 PackResult 填出算法输出 */
export function computedFromResult(result: PackResult, containers: number): CaseComputed {
  return {
    pieces: result.pieces,
    loadRate: result.loadRate,
    containers,
    totalWeight: result.totalWeight,
    usedVolume: result.usedVolume,
    allPacked: (result.rejected?.length ?? 0) === 0,
    remaining: (result.rejected ?? []).map((r) => ({ boxId: r.boxId, qty: 0 })),
  };
}

/**
 * 差异分析 —— 案例列表与详情页的核心指标
 *
 * `piecesDelta > 0`（算出比现场多）意味着**算法高估了装柜能力**，
 * 这是最需要警惕的方向：现场装不下的方案，给出去是要出事的。
 */
export interface CaseDelta {
  /** 算法算出的箱数 */
  computedPieces: number;
  /** 现场实际箱数（未填则为 undefined） */
  actualPieces?: number;
  /** 算得比现场多多少（正数=高估） */
  piecesDelta?: number;
  /** 偏差百分比（相对现场实际） */
  piecesDeltaPct?: number;
  /** 算法算的柜数 */
  computedContainers: number;
  actualContainers?: number;
  containersDelta?: number;
  /** 是否全部装完 */
  allPacked: boolean;
  /** 是否已填实测 */
  hasActual: boolean;
}

export function analyzeCase(c: LoadCase): CaseDelta {
  const actualPieces = c.actual.pieces;
  const actualContainers = c.actual.containers;
  const piecesDelta = actualPieces === undefined ? undefined : c.computed.pieces - actualPieces;
  return {
    computedPieces: c.computed.pieces,
    actualPieces,
    piecesDelta,
    piecesDeltaPct:
      piecesDelta === undefined || !actualPieces ? undefined : (piecesDelta / actualPieces) * 100,
    computedContainers: c.computed.containers,
    actualContainers,
    containersDelta:
      actualContainers === undefined ? undefined : c.computed.containers - actualContainers,
    allPacked: c.computed.allPacked,
    hasActual: actualPieces !== undefined || actualContainers !== undefined || Boolean(c.actual.note),
  };
}

/**
 * 案例排序权重：需要跟进的排前面
 *
 * 排序依据是「偏差大小」而不是时间 —— 偏差越大越该先看。
 * 没有实测数据的排中间（还没价值），全对的排最后。
 */
export function casePriority(c: LoadCase): number {
  const d = analyzeCase(c);
  if (d.piecesDelta === undefined && d.containersDelta === undefined) return 1;
  const mag = Math.abs(d.piecesDelta ?? 0) + Math.abs(d.containersDelta ?? 0) * 100;
  return mag > 0 ? 0 : 2; // 有偏差=0（吻合）排最后
}

/** 汇总：给案例页顶部一个总览 */
export interface CaseSummary {
  total: number;
  withActual: number;
  /** 算法高估装柜能力的案例数（最需要警惕） */
  overestimated: number;
  underestimated: number;
  /** 平均偏差百分比（仅统计已填实测且实际箱数>0 的） */
  avgDeltaPct?: number;
  worst?: LoadCase;
}

export function summarizeCases(list: LoadCase[]): CaseSummary {
  let over = 0;
  let under = 0;
  let sum = 0;
  let n = 0;
  let worst: LoadCase | undefined;
  let worstMag = -1;

  for (const c of list) {
    const d = analyzeCase(c);
    if (!d.hasActual) continue;
    if (d.piecesDelta === undefined) continue;
    if (d.piecesDelta > 0) over++;
    else if (d.piecesDelta < 0) under++;
    if (d.actualPieces && d.piecesDeltaPct !== undefined) {
      sum += d.piecesDeltaPct;
      n++;
    }
    const mag = Math.abs(d.piecesDelta ?? 0) + Math.abs(d.containersDelta ?? 0) * 100;
    if (mag > 0 && mag > worstMag) {
      worstMag = mag;
      worst = c;
    }
  }

  return {
    total: list.length,
    withActual: list.filter((c) => analyzeCase(c).hasActual).length,
    overestimated: over,
    underestimated: under,
    avgDeltaPct: n > 0 ? sum / n : undefined,
    worst,
  };
}

// ---------------------------------------------------------------------------
// 行结构（与 SQLite 列名 / IndexedDB 字段名一一对应）
// ---------------------------------------------------------------------------

export interface CaseRow {
  id: number;
  name: string;
  created_at: string;
  /** Container 快照 */
  container_json: string;
  /** Box[]，含本次数量 */
  boxes_json: string;
  strategy: number;
  options_json: string | null;
  computed_json: string;
  actual_json: string;
}

/** 缺省值容忍：JSON 坏了不能让整条记录读不出来（否则一条脏数据毁掉整个列表） */
function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToCase(row: CaseRow): LoadCase {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    // 柜型快照是必填项；真损坏时给一个明确占位而不是 null ——
    // 让上层能显示"（数据损坏）"而不是在渲染时炸掉
    container: safeParse<Container>(row.container_json, {
      id: '0',
      name: '（柜型数据损坏）',
      innerLength: 0,
      innerWidth: 0,
      innerHeight: 0,
      weightCapacity: 0,
    } as Container),
    boxes: safeParse<Box[]>(row.boxes_json, []),
    strategy: row.strategy,
    options: safeParse<LoadOptions | undefined>(row.options_json, undefined),
    computed: safeParse<CaseComputed>(row.computed_json, {
      pieces: 0,
      loadRate: 0,
      containers: 1,
      totalWeight: 0,
      usedVolume: 0,
      allPacked: false,
      remaining: [],
    }),
    actual: safeParse<CaseActual>(row.actual_json, {}),
  };
}