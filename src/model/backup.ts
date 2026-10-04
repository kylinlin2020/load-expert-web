/**
 * 备份文件格式（**纯模块，不依赖任何存储实现**）
 *
 * ## 为什么单独抽出来、而且导出的是「领域对象」而不是数据库行
 *
 * 1. **两种存储必须用同一份格式**，否则数据没法在服务端版（SQLite）与
 *    静态版（IndexedDB）之间迁移 —— 而这正是用户最需要备份功能的原因：
 *    静态版的数据只在浏览器里，清掉站点数据就没了。
 * 2. 导出的若是 SQLite 行，就要迁就 `allow_directions TEXT` 这种
 *    "JSON 数组塞进字符串"的存储细节；导领域对象则是干净的业务语义，
 *    人还能直接看懂并手工编辑。
 *
 * ## id 必须原样保留
 *
 * 存下来的 `PackResult` 里到处是 `boxId` 引用（`placements[].boxId`、
 * `CartonPlacement.boxId`、`SpaceBlock.baseBoxId`、`rejected[].boxId`），
 * `PlanRecord.containerId` 也指向柜型。
 * 一旦导入时重新分配 id 而漏改某处引用，界面不会报错，只会**默默显示错货名**。
 * 所以本模块原样保留 id，导入侧负责按 id 写回。
 *
 * 由 `test/backup.test.ts` 的「导出→导入→再导出 必须完全相等」锁住这个不变式。
 */
import type { Box, Container, LoadOptions, PackResult } from '../types/index.js';
import type { LoadCase } from './case.js';

/** 格式标识。改动任何字段语义都必须 +1，否则老备份会被新代码误读。 */
export const BACKUP_FORMAT = 'load-expert-backup';

/** 当前格式版本（读的时候兼容 <= 当前版本） */
export const BACKUP_VERSION = 1;

/** 导入模式：见 BackupView 的说明 */
export type ImportMode = 'merge' | 'replace';

export interface BackupCounts {
  boxes: number;
  containers: number;
  plans: number;
}

/** 备份里的方案记录（与 `PlanRecord` 同形，便于直接落库） */
export interface BackupPlan {
  id: number;
  name: string;
  containerId: number;
  boxes: Box[];
  result: PackResult;
  createdAt: string;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** ISO 时间戳 */
  exportedAt: string;
  /** 导出时的应用版本，仅供人看，不参与解析 */
  appVersion: string;
  counts: BackupCounts;
  data: {
    boxes: Box[];
    containers: Container[];
    plans: BackupPlan[];
    /**
     * 实测案例。**可选** —— 老备份里没有这一项。
     *
     * 刻意**不升格式版本**：cases 是后加的独立表，把它设为可选字段，
     * 旧备份照样能导入（缺的当空数组），不必写 v1→v2 的迁移分支。
     * 反过来，升版本会让**所有**旧备份在新代码下报"版本无法识别"。
     */
    cases?: LoadCase[];
  };
}

/** 格式非法时抛出，消息是给人看的（会直接显示在导入界面上） */
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export function buildBackup(input: {
  boxes: Box[];
  containers: Container[];
  plans: BackupPlan[];
  cases?: LoadCase[];
  appVersion: string;
  exportedAt?: string;
}): BackupFile {
  const { boxes, containers, plans, cases } = input;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    appVersion: input.appVersion,
    counts: { boxes: boxes.length, containers: containers.length, plans: plans.length },
    data: {
      boxes,
      containers,
      plans,
      // 空数组也写出来：让"导出过、确实是 0 条"与"老备份没有这一项"可区分
      ...(cases ? { cases } : {}),
    },
  };
}

/** 文件名：装柜专家数据备份_20261003_2015.json */
export function backupFileName(appVersion: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}`;
  return `装柜专家数据备份_v${appVersion}_${stamp}.json`;
}

// ---------------------------------------------------------------------------
// 解析与校验
//
// 刻意**严格**：任何一条记录不合法就整体拒绝，不做"跳过坏记录"。
// 理由 —— 恢复操作里静默丢记录是最坏的失败方式：
// 用户以为全部恢复了，实际少了几条柜型，几天后才发现。
// 宁可当场报错并说清是哪一条、哪个字段。
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new BackupFormatError(`备份文件无效：${msg}`);
}

/** 取有限数值；缺省用 fallback；非有限数（含字符串/NaN/null）报错 */
function needNum(v: unknown, where: string, fallback?: number): number {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    fail(`${where} 缺少数值`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`${where} 必须是有限数字，实际是 ${JSON.stringify(v)}`);
  }
  return v;
}

function needStr(v: unknown, where: string, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') {
    fail(`${where} 必须是字符串，实际是 ${JSON.stringify(v)}`);
  }
  return v;
}

/** id 既可能是 number 也可能是 string（领域对象里 Box.id 就是 string） */
function needId(v: unknown, where: string): string {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return fail(`${where} 的 id 无效：${JSON.stringify(v)}`);
}

function needObj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(`${where} 必须是对象`);
  }
  return v as Record<string, unknown>;
}

function needArr(v: unknown, where: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    fail(`${where} 必须是数组`);
  }
  return v;
}

/** 定长布尔数组；长度不符就报错而不是"猜" */
function boolArr(v: unknown, len: number, where: string): boolean[] {
  const def = Array.from({ length: len }, () => true);
  if (v === undefined || v === null) return def;
  if (!Array.isArray(v) || v.length !== len) {
    fail(`${where} 必须是长度 ${len} 的布尔数组`);
  }
  return v.map((x) => !(x === false || x === 0 || x === null || x === ''));
}

function numArr(v: unknown, len: number, where: string, def: number): number[] {
  if (v === undefined || v === null) return Array.from({ length: len }, () => def);
  if (!Array.isArray(v) || v.length !== len) {
    fail(`${where} 必须是长度 ${len} 的数字数组`);
  }
  return v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0));
}

/** 把一条货物记录规整成 Box */
function parseBox(raw: unknown, i: number): Box {
  const o = needObj(raw, `货物第 ${i + 1} 条`);
  const at = (k: string) => `货物第 ${i + 1} 条（${needStr(o.name, `货物第 ${i + 1} 条的名称`)}）的 ${k}`;
  return {
    id: needId(o.id, at('id')),
    name: needStr(o.name, at('name')),
    sku: needStr(o.sku, at('sku')) || undefined,
    batch: needStr(o.batch, at('batch')) || undefined,
    unitPrice: o.unitPrice === undefined || o.unitPrice === null ? undefined : needNum(o.unitPrice, at('unitPrice')),
    unit: needStr(o.unit, at('unit')) || undefined,
    groupName: needStr(o.groupName, at('groupName')) || undefined,
    description: needStr(o.description, at('description')) || undefined,
    netWeight: o.netWeight === undefined || o.netWeight === null ? undefined : needNum(o.netWeight, at('netWeight')),
    color: needStr(o.color, at('color')) || undefined,
    dimensionUnit: needStr(o.dimensionUnit, at('dimensionUnit'), 'mm') || 'mm',
    weightUnit: needStr(o.weightUnit, at('weightUnit'), 'kg') || 'kg',
    length: needNum(o.length, at('长 length')),
    width: needNum(o.width, at('宽 width')),
    height: needNum(o.height, at('高 height')),
    weight: needNum(o.weight, at('毛重 weight'), 0),
    deformFactor: needNum(o.deformFactor, at('型变系数'), 1),
    deformTolerance: needNum(o.deformTolerance, at('型变公差'), 0),
    stackClass: needNum(o.stackClass, at('堆码级别'), 1),
    allowDirections: boolArr(o.allowDirections, 6, at('六向允许摆放')),
    maxPlaceDepth: numArr(o.maxPlaceDepth, 6, at('六向最大堆放数'), 0),
    supportFaces: boolArr(o.supportFaces, 6, at('六向可承托')),
    supportClasses: numArr(o.supportClasses, 6, at('六向承托级别'), 5),
    supportPct: numArr(o.supportPct, 3, at('承托比例'), 1) as [number, number, number],
    pcsCount: needNum(o.pcsCount, at('每箱件数'), 1),
    quantity: needNum(o.quantity, at('数量'), 1),
  };
}

function parseContainer(raw: unknown, i: number): Container {
  const o = needObj(raw, `柜型第 ${i + 1} 条`);
  const at = (k: string) => `柜型第 ${i + 1} 条（${needStr(o.name, `柜型第 ${i + 1} 条的名称`)}）的 ${k}`;
  return {
    id: needId(o.id, at('id')),
    name: needStr(o.name, at('name')),
    innerLength: needNum(o.innerLength, at('内长 innerLength')),
    innerWidth: needNum(o.innerWidth, at('内宽 innerWidth')),
    innerHeight: needNum(o.innerHeight, at('内高 innerHeight')),
    weightCapacity: needNum(o.weightCapacity, at('载重'), 0),
    label: needStr(o.label, at('标签')) || undefined,
    description: needStr(o.description, at('描述')) || undefined,
    cornerDims: o.cornerDims === undefined || o.cornerDims === null
      ? undefined
      : (numArr(o.cornerDims, 3, at('角件尺寸'), 0) as [number, number, number]),
    doorDims: o.doorDims === undefined || o.doorDims === null
      ? undefined
      : (numArr(o.doorDims, 2, at('门尺寸'), 0) as [number, number]),
    emptyWeight: o.emptyWeight === undefined || o.emptyWeight === null ? undefined : needNum(o.emptyWeight, at('空柜自重')),
    cost: o.cost === undefined || o.cost === null ? undefined : needNum(o.cost, at('成本')),
    unit: needStr(o.unit, at('计量单位')) || undefined,
    dimensionUnit: needStr(o.dimensionUnit, at('尺寸单位'), 'mm') || 'mm',
    weightUnit: needStr(o.weightUnit, at('重量单位'), 'kg') || 'kg',
  };
}

function parsePlan(raw: unknown, i: number): BackupPlan {
  const o = needObj(raw, `方案第 ${i + 1} 条`);
  const at = (k: string) => `方案第 ${i + 1} 条（${needStr(o.name, `方案第 ${i + 1} 条的名称`)}）的 ${k}`;
  const result = needObj(o.result, at('计算结果'));
  if (!Array.isArray(result.placements)) {
    // placements 为空是合法的（空结果），但类型必须是数组 —— 说明这份数据确实来自本程序
    if (result.placements !== undefined) fail(at('计算结果的 placements 必须是数组'));
  }
  return {
    id: Number(needId(o.id, at('id'))),
    name: needStr(o.name, at('name')),
    containerId: needNum(o.containerId, at('柜型 containerId')),
    boxes: needArr(o.boxes, at('货物清单')).map((b, j) => parseBox(b, j)),
    result: result as unknown as PackResult,
    createdAt: needStr(o.createdAt, at('创建时间')),
  };
}

/**
 * 一条案例记录
 *
 * 案例里的 `container` / `boxes` 已经是**领域对象**（不是行），
 * 所以这里直接复用货物/柜型的解析器，保证格式一致 ——
 * 不要为案例另写一套字段映射，那必然会和主数据层漂移。
 */
function parseCase(raw: unknown, i: number): LoadCase {
  const o = needObj(raw, `案例第 ${i + 1} 条`);
  const at = (k: string) => `案例第 ${i + 1} 条（${needStr(o.name, `案例第 ${i + 1} 条的名称`)}）的 ${k}`;
  const computed = needObj(o.computed, at('算法输出'));
  const actual = o.actual === undefined || o.actual === null ? {} : needObj(o.actual, at('现场实测'));

  return {
    id: Number(needId(o.id, at('id'))),
    name: needStr(o.name, at('name')),
    createdAt: needStr(o.createdAt, at('记录时间')),
    container: parseContainer(o.container, 0),
    boxes: needArr(o.boxes, at('货物清单')).map(parseBox),
    strategy: needNum(o.strategy, at('策略'), 3),
    options: o.options === undefined || o.options === null ? undefined : (o.options as LoadOptions),
    computed: {
      pieces: needNum(computed.pieces, at('算法输出的箱数')),
      loadRate: needNum(computed.loadRate, at('算法输出的装载率'), 0),
      containers: needNum(computed.containers, at('算法输出的柜数'), 1),
      totalWeight: needNum(computed.totalWeight, at('算法输出的总重'), 0),
      usedVolume: needNum(computed.usedVolume, at('算法输出的体积'), 0),
      allPacked: computed.allPacked === true,
      remaining: needArr(computed.remaining, at('剩余清单')).map((r) => needObj(r, at('剩余项')) as never),
    },
    actual: {
      pieces: actual.pieces === undefined ? undefined : needNum(actual.pieces, at('现场实际箱数')),
      containers: actual.containers === undefined ? undefined : needNum(actual.containers, at('现场实际柜数')),
      note: needStr(actual.note, at('备注')) || undefined,
    },
  };
}

/**
 * 解析并校验备份文件**文本**
 * @throws BackupFormatError（消息已面向使用者，可直接显示）
 */
export function parseBackup(text: string): BackupFile {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return fail('不是合法的 JSON 文件（可能选错了文件，或文件已损坏）');
  }
  return validateBackup(root);
}

/**
 * 校验一个**已解析**的备份对象
 *
 * ## 为什么要和 `parseBackup` 分开
 *
 * 服务端版经 HTTP 传过来的是**对象**（JSON 已被框架解析），
 * 静态版是本地读文件读到的**文本**。若只有 `parseBackup`，
 * 服务端就得先把对象 stringify 回文本再 parse 一遍，白白多一次往返。
 *
 * 分开后两边共用**同一套校验规则**，且服务端仍然会再校验一次 ——
 * 不能因为"前端已经验过了"就信任入参，那套规则会慢慢和前端分叉。
 */
export function validateBackup(root: unknown): BackupFile {
  const o = needObj(root, '根节点');

  if (o.format !== BACKUP_FORMAT) {
    fail(`不是本程序的备份文件（format 应为 "${BACKUP_FORMAT}"，实际是 ${JSON.stringify(o.format)}）`);
  }
  const version = needNum(o.version, '版本号');
  if (version < 1 || version > BACKUP_VERSION) {
    fail(
      version > BACKUP_VERSION
        ? `备份文件版本 ${version} 比当前程序（${BACKUP_VERSION}）新，请先升级程序`
        : `备份文件版本 ${version} 无法识别`,
    );
  }

  const data = needObj(o.data, 'data');
  const boxes = needArr(data.boxes, 'data.boxes').map(parseBox);
  const containers = needArr(data.containers, 'data.containers').map(parseContainer);
  const plans = needArr(data.plans, 'data.plans').map(parsePlan);
  // cases 是可选的：老备份没有这一项，按空数组处理
  const cases = data.cases === undefined ? [] : needArr(data.cases, 'data.cases').map(parseCase);

  // id 重复会让「按 id 合并」变成不确定行为，必须提前拦下
  assertUniqueIds(boxes, '货物');
  assertUniqueIds(containers, '柜型');
  assertUniqueIds(plans, '方案');
  assertUniqueIds(cases, '案例');

  return {
    format: BACKUP_FORMAT,
    version,
    exportedAt: needStr(o.exportedAt, '导出时间'),
    appVersion: needStr(o.appVersion, '应用版本', '未知'),
    counts: { boxes: boxes.length, containers: containers.length, plans: plans.length },
    data: { boxes, containers, plans, cases },
  };
}

function assertUniqueIds(list: Array<{ id: string | number }>, label: string): void {
  const seen = new Set<string>();
  for (const it of list) {
    const k = String(it.id);
    if (seen.has(k)) {
      fail(`${label} id=${k} 在文件里重复，无法确定按 id 合并时谁覆盖谁`);
    }
    seen.add(k);
  }
}

/** 界面上给用户看的摘要（先看这个再决定要不要导入） */
export function describeBackup(f: BackupFile): string {
  const at = new Date(f.exportedAt);
  const when = Number.isNaN(at.getTime()) ? f.exportedAt : at.toLocaleString('zh-CN');
  return [
    `导出时间：${when}`,
    `导出程序版本：${f.appVersion}`,
    `货物 ${f.counts.boxes} 种 · 柜型 ${f.counts.containers} 种 · 方案 ${f.counts.plans} 个`,
  ].join('\n');
}