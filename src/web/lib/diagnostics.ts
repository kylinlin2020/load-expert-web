/**
 * 诊断信息采集（内存态，不落盘）
 *
 * ## 为什么先做这个
 *
 * 反馈页本身不难，难的是让它**有诊断价值**。此前应用没有任何前端错误捕获：
 * 用户遇到问题只看到一句 toast，开发侧拿不到任何信息；真正 unhandled 的错误
 * （渲染失败、异步崩溃）甚至只进浏览器 console —— 用户看不见，我们也不知道。
 * 所以先补这一层，反馈页才有东西可附。
 *
 * ## 刻意不做的事
 *
 * **不落盘。** 静态版的数据在浏览器 IndexedDB 里，若错误日志也写进去，
 * 用户浏览器里就多了一份没人会看的东西，还会随「清除站点数据」以外的路径长期堆积。
 * 内存环形缓冲，关页面即消失 —— 而反馈是**用户主动发起**的，那一刻缓冲还在就够了。
 *
 * **不采集业务数据。** 诊断里默认不出现货物名、尺寸、柜型等任何业务内容。
 * 用户若要附带，那是另一件事（见 FeedbackView 的显式勾选项）。
 *
 * ## 隐私边界
 *
 * 采集的只有：应用版本、构建模式、浏览器与屏幕信息、错误与操作轨迹。
 * 这些都不含客户业务数据。报告文本在 FeedbackView 里会先给用户过目再发出去。
 */
import { appVersion } from '../../version.js';
import { IS_STATIC_BUILD, API_BASE } from '../api/buildEnv.js';

// ---------------------------------------------------------------------------
// 环形缓冲（纯逻辑，可单测）
// ---------------------------------------------------------------------------

export interface DiagEntry {
  /** ISO 时间戳 */
  at: string;
  kind: 'error' | 'warn' | 'info' | 'nav' | 'action';
  message: string;
  /** 附加信息（错误堆栈、参数摘要等）。已截断，避免环形缓冲被单个大对象占满 */
  detail?: string;
}

/**
 * 定长环形缓冲
 *
 * 用数组 + shift 的简单实现：条目数只有几十条，性能无关紧要，
 * 但**必须去重** —— 同一个错误在一次操作里可能重复抛十几次，
 * 不去重会把有效信息挤出去。
 */
export class RingBuffer {
  private items: DiagEntry[] = [];

  constructor(private readonly limit: number = 50) {}

  push(entry: DiagEntry): void {
    // 同 kind + 同 message 在 5 秒内重复出现，只更新时间，不新增条目
    const last = this.items[this.items.length - 1];
    if (last && last.kind === entry.kind && last.message === entry.message) {
      const dt = Date.parse(entry.at) - Date.parse(last.at);
      if (dt < 5000) {
        last.at = entry.at;
        return;
      }
    }
    this.items.push(entry);
    while (this.items.length > this.limit) {
      this.items.shift();
    }
  }

  list(): DiagEntry[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }

  /** 某类条目计数（报告里显示"错误 N 条"） */
  countOf(kind: DiagEntry['kind']): number {
    return this.items.filter((x) => x.kind === kind).length;
  }

  get size(): number {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

export const diagLog = new RingBuffer(50);

/** 附加信息统一截断，避免一个巨型错误对象塞满缓冲 */
const MAX_DETAIL = 800;

function trunc(s: string): string {
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…（已截断，共 ${s.length} 字符）` : s;
}

function errText(e: unknown): { message: string; detail?: string } {
  if (e instanceof Error) {
    return {
      message: e.message || e.name || '(无消息)',
      detail: e.stack ? trunc(e.stack) : undefined,
    };
  }
  if (typeof e === 'string') return { message: trunc(e) };
  try {
    return { message: trunc(JSON.stringify(e)) };
  } catch {
    return { message: String(e) };
  }
}

/** 记录一条错误（会被反馈页收集） */
export function recordError(e: unknown, context?: string): void {
  const { message, detail } = errText(e);
  diagLog.push({
    at: new Date().toISOString(),
    kind: 'error',
    message: context ? `${context}：${message}` : message,
    detail,
  });
}

/** 记录一条警告 */
export function recordWarn(message: string, detail?: string): void {
  diagLog.push({ at: new Date().toISOString(), kind: 'warn', message, detail: detail ? trunc(detail) : undefined });
}

/** 记录一条操作轨迹（导航、执行计算、导出…），出问题时用来还原"当时做了什么" */
export function recordAction(message: string, detail?: string): void {
  diagLog.push({ at: new Date().toISOString(), kind: 'action', message, detail: detail ? trunc(detail) : undefined });
}

/** 记录一次路由跳转 */
export function recordNav(path: string): void {
  diagLog.push({ at: new Date().toISOString(), kind: 'nav', message: `跳转 ${path}` });
}

// ---------------------------------------------------------------------------
// 报告生成
// ---------------------------------------------------------------------------

export interface DiagnosticsReport {
  generatedAt: string;
  app: { version: string; build: string; api: string };
  env: Record<string, string | number>;
  data: Record<string, string | number>;
  entries: DiagEntry[];
}

/** 环境信息。全部是非业务数据 */
export function collectEnv(): Record<string, string | number> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const scr = typeof screen === 'undefined' ? undefined : screen;
  return {
    浏览器: nav?.userAgent ?? '(未知)',
    语言: nav?.language ?? '(未知)',
    时区: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '(未知)';
      } catch {
        return '(未知)';
      }
    })(),
    屏幕: scr ? `${scr.width}×${scr.height}` : '(未知)',
    视口: typeof window === 'undefined' ? '(未知)' : `${window.innerWidth}×${window.innerHeight}`,
    像素比: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    逻辑核心: nav?.hardwareConcurrency ?? 0,
    在线: typeof navigator === 'undefined' ? '(未知)' : navigator.onLine ? '是' : '否',
  };
}

/**
 * 组装完整诊断报告
 *
 * @param dataCount 数据条数。由调用方提供（要 await API 才能拿到），
 *        这里不主动发请求 —— 诊断包不该自己制造请求失败。
 */
export function buildReport(dataCount: Record<string, number | string> = {}): DiagnosticsReport {
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: appVersion.version,
      build: IS_STATIC_BUILD ? '纯静态版（浏览器 IndexedDB）' : `服务端版（${API_BASE || '同源 /api'}）`,
      api: API_BASE || '(同源)',
    },
    env: collectEnv(),
    data: dataCount,
    entries: diagLog.list(),
  };
}

/** 纯文本版（给"一键复制"用）—— 只含同样的非业务信息 */
export function reportToText(r: DiagnosticsReport): string {
  const L: string[] = [];
  L.push('===== 装柜专家 诊断信息 =====');
  L.push(`生成时间：${r.generatedAt}`);
  L.push(`应用版本：${r.app.version}`);
  L.push(`构建版本：${r.app.build}`);
  L.push('');
  L.push('--- 运行环境 ---');
  for (const [k, v] of Object.entries(r.env)) L.push(`${k}：${v}`);
  if (Object.keys(r.data).length > 0) {
    L.push('');
    L.push('--- 数据条数 ---');
    for (const [k, v] of Object.entries(r.data)) L.push(`${k}：${v}`);
  }
  L.push('');
  L.push(`--- 错误与操作轨迹（最近 ${r.entries.length} 条）---`);
  if (r.entries.length === 0) {
    L.push('（无）');
  } else {
    for (const e of r.entries) {
      L.push(`[${e.at}] ${e.kind.toUpperCase()} ${e.message}`);
      if (e.detail) L.push(`    ${e.detail.replace(/\n/g, '\n    ')}`);
    }
  }
  L.push('');
  L.push('（本报告不含货物名称、尺寸等业务数据）');
  return L.join('\n');
}