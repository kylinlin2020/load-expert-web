/**
 * 共享资料库（只读的远程参考数据）
 *
 * ## 解决什么问题
 *
 * 静态版每台设备是一个孤岛（数据在本浏览器 IndexedDB）。
 * 于是"办公室录好的柜型/货物规格，手机上查不到"。
 *
 * 本模块提供最小可行解：**一个放在网盘/对象存储上的 JSON，多台设备都去读它**。
 * 只解决「查」的问题，不解决「多端协同录入」—— 后者需要认证、冲突合并、
 * 删除墓碑同步一整套，复杂度与收益不成比例。
 *
 * ## 三条硬规则（决定了这个设计为什么简单）
 *
 * 1. **本地优先**：同 id 时本地那条覆盖库里那条。所以编辑库里的条目
 *    ＝ 以同一个 id 存进本地，从此它就是"你的"了。
 * 2. **绝不反向覆盖**：库里的数据永远不会写进本地存储、不会动本地数据。
 *    拉取失败、文件被传错、库被清空 —— 最坏结果是"看不到共享资料"，
 *    绝不会变成"我的数据没了"。这是整个设计里最重要的一条。
 * 3. **同 id 空间**：库里的条目 id 与本地同一套 id，不加前缀、不做映射表。
 *    代价是"库里的 X"和"本地的 X"在编辑/删除上语义要靠墓碑区分（见下）。
 *
 * ## 为什么要墓碑
 *
 * 用户删掉一条**库里**的条目时，本地并没有这条记录 —— 不记下来的话，
 * 下次拉取它又原样出现，删除"看起来没生效"。
 * 所以本地记一个很小的 id 名单（`deletedLibIds`），过滤掉它们。
 * 只有几十个 id 的量级，localStorage 足够，不必占 IndexedDB。
 *
 * ## 文件格式 = 现有备份格式
 *
 * 共享库文件**就是一个方案为空的备份文件**（复用 `parseBackup` 的严格校验）。
 * 这样「导出参考数据」几乎是现有导出逻辑裁一刀，且用户已有的备份文件
 * 可以直接当共享库用，不必转换。
 */
import type { Box, Container } from '../types/index.js';

/** 从共享库读到的内容（已通过备份格式校验） */
export interface ReferencePayload {
  boxes: Box[];
  containers: Container[];
  /** 源文件的导出时间，用于界面显示"这份资料是什么时候的" */
  exportedAt?: string;
  appVersion?: string;
}

/** 合并结果。`libIds` 是"只存在于库里、本地没有"的那些 id */
export interface Merged<T> {
  items: T[];
  libIds: Set<string>;
}

function idOf(x: { id: string }): string {
  return String(x.id);
}

/**
 * 把"可能不是数组"的值归一为空数组
 *
 * 共享库是**下载来的外部文件** —— 被手改坏、被截断、字段名打错都很常见。
 * 没有这道防线，一个坏文件会让 `for...of` 抛 `is not iterable`，
 * **整个柜型/货物页白屏**。宁可少显示几条，也不能整页打不开。
 */
function asList<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * 合并本地与共享库
 *
 * @param local    本地条目（可读写，排在前面）
 * @param lib      库里的条目（只读来源）
 * @param deleted  墓碑：用户删掉过的库条目 id
 *
 * @returns 本地条目 + 库里多出来的条目；`libIds` 标出后者
 *
 * ## 为什么按本地顺序排、库里的接在后面
 *
 * 用户日常编辑的是本地那份。让本地条目保持在原位置（列表/下拉的顺序稳定），
 * 库里的条目追加在后面并带标记 —— 不会因为拉了一次远程就把手边的条目顶走。
 */
export function mergeWithLib<T extends { id: string }>(
  local: T[],
  lib: T[],
  deleted: ReadonlySet<string>,
): Merged<T> {
  const localIds = new Set(asList<T>(local).map(idOf));
  const items: T[] = asList<T>(local).slice();
  const libIds = new Set<string>();

  for (const item of asList<T>(lib)) {
    const id = idOf(item);
    // 本地已有同 id → 本地优先，不加入
    if (localIds.has(id)) continue;
    // 墓碑命中 → 用户明确删过，不再出现
    if (deleted.has(id)) continue;
    items.push(item);
    libIds.add(id);
  }

  return { items, libIds };
}

/**
 * 判断一条是否只存在于库里
 *
 * 视图层用它决定"这条能不能编辑/删除"，以及要不要显示标记。
 * **从独立模块导出而不是塞进对象**，是为了不给 `Box` / `Container`
 * 这两个领域类型塞进一个只在列表页用得上的标记字段 —— 那会一路渗进
 * 存储层、备份文件、案例分享的脱敏逻辑。
 */
export function isFromLib(id: string, libIds: ReadonlySet<string>): boolean {
  return libIds.has(String(id));
}

/**
 * 合并柜型与货物两组的标记
 *
 * 视图分别要"哪些柜型来自库""哪些货物来自库"，这里一次算好两组。
 */
export interface LibMarks {
  containerIds: Set<string>;
  boxIds: Set<string>;
}

export function mergeAll(
  local: { boxes: Box[]; containers: Container[] },
  lib: ReferencePayload,
  deleted: { boxIds: ReadonlySet<string>; containerIds: ReadonlySet<string> },
): { boxes: Box[]; containers: Container[]; marks: LibMarks } {
  // 四处都过 asList：任何一侧被改坏都只丢那几条，不能抛异常
  const c = mergeWithLib(asList<Container>(local?.containers), asList<Container>(lib?.containers), deleted.containerIds);
  const b = mergeWithLib(asList<Box>(local?.boxes), asList<Box>(lib?.boxes), deleted.boxIds);
  return {
    boxes: b.items,
    containers: c.items,
    marks: { containerIds: c.libIds, boxIds: b.libIds },
  };
}
