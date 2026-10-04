/**
 * 诊断包导出（单个 JSON 文件）
 *
 * ## 为什么要有这个文件形态
 *
 * 让用户"截图 + 打字描述"会把关键信息丢在截图的分辨率和用户的措辞里。
 * 一个 JSON 文件是**无损的**：版本、构建模式、浏览器、错误堆栈、数据条数
 * 全部原样带过来，用户只要把文件发过来即可。
 *
 * ## 不含业务数据
 *
 * 刻意只放**条数**，不放货物名 / 尺寸 / 柜型等内容。
 * 用户若确实要附带业务数据，那是另一件事 —— 由用户在「数据备份」页
 * 主动导出自己决定，而不是诊断包替他做主。
 */
import { buildReport, reportToText, type DiagnosticsReport } from './diagnostics.js';

export interface DiagnosticFile {
  kind: 'load-expert-diagnostics';
  version: 1;
  generatedAt: string;
  report: DiagnosticsReport;
  /** 纯文本版也一并带上 —— 对方未必想解析 JSON */
  reportText: string;
}

/**
 * 组装可下载的诊断包
 * @param dataCount 由调用方提供（要 await API 才能拿到）
 */
export function buildDiagnosticFile(dataCount: Record<string, number | string> = {}): DiagnosticFile {
  const report = buildReport(dataCount);
  return {
    kind: 'load-expert-diagnostics',
    version: 1,
    generatedAt: new Date().toISOString(),
    report,
    reportText: reportToText(report),
  };
}

/** 文件名：含版本号与时间戳，方便对方分辨是哪一份 */
export function diagnosticFileName(appVersion: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}`;
  return `装柜专家诊断_v${appVersion}_${stamp}.json`;
}

/** 通用下载（两套版本都在浏览器里跑，这段代码通用） */
export function downloadText(content: string, filename: string, mime = 'application/json;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻 revoke 会让部分浏览器来不及开始下载，等一拍更稳
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}