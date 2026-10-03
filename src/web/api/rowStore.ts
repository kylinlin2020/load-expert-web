/**
 * 静态版的存储抽象：一层极窄的"行存取"接口
 *
 * ## 为什么要抽象
 *
 * Node 的测试运行器里**没有 IndexedDB**。若把 IndexedDB 调用直接写在业务逻辑里，
 * 这部分逻辑就只能靠手工点页面验证 —— 而本项目吃过"视图层没测试"的亏
 * （见 §9.29：三个 bug 全是因为逻辑写在 .vue 里）。
 *
 * 所以这里只暴露 5 个方法（all / get / put / remove / count），
 * 提供两个实现：
 * - `idbAdapter.ts`：真实 IndexedDB（浏览器）
 * - `test/helpers/memAdapter.ts`：内存 Map（Node 测试）
 *
 * 业务逻辑（`localStore.ts` + `localClient.ts`）只依赖这个接口，
 * 于是**整个静态版数据层都能在 Node 里跑真实测试**。
 *
 * 之所以够用：三个表的数据量都是人工录入的量级（几十~几百行），
 * 全量读进内存再过滤毫无压力，不需要索引或游标。
 */

/** 表名（与 SQLite / IndexedDB 的 object store 同名） */
export type StoreName = 'boxes' | 'containers' | 'plans';

export const STORE_NAMES: readonly StoreName[] = ['boxes', 'containers', 'plans'];

/** 带自增数值 id 的行 */
export interface Row {
  id: number;
}

/**
 * 行存取接口
 *
 * 注意 `put` 接受**不带 id** 的行：由实现方补自增 id 并返回完整行。
 * 两边（SQLite AUTOINCREMENT / IndexedDB autoIncrement）都是这个语义。
 */
export interface RowStore {
  /** 全量读取，按 id 升序 */
  all<T extends Row>(store: StoreName): Promise<T[]>;
  /** 按 id 取单条；不存在返回 undefined */
  get<T extends Row>(store: StoreName, id: number): Promise<T | undefined>;
  /**
   * 新增或按 id 覆盖；返回落库后的完整行（含 id）
   *
   * 传**不带 id 键**的行表示新增；带 id 则表示覆盖。
   *
   * ## ⚠️ 这里有个真踩过的坑
   *
   * IndexedDB 的 autoIncrement **只在 keyPath 属性缺失时**才生成键。
   * 写成 `put({ id: undefined, ... })` 会抛：
   * `Evaluating the object store's key path yielded a value that is not a valid key`
   * —— 属性「存在但为 undefined」与「不存在」是两回事。
   *
   * 调用方（localStore）与实现方（idbAdapter）都已改为**不写 id 键**，
   * 并且内存适配器**刻意复现这个行为**（见 test/helpers/memAdapter.ts）——
   * 否则测试用一个「宽容」的假实现就永远测不出这个问题。
   */
  put<T extends Row>(store: StoreName, row: Omit<T, 'id'> & { id?: number }): Promise<T>;
  /** 删除；返回是否真的删掉了一条 */
  remove(store: StoreName, id: number): Promise<boolean>;
  /** 清空整张表，返回删除行数（**备份恢复的覆盖模式用**） */
  clear(store: StoreName): Promise<number>;
  /** 行数（用于"是否首次运行、要不要写种子"的判断） */
  count(store: StoreName): Promise<number>;
  /** 把内存中的改动落盘（IndexedDB 无需处理；内存适配器也无需。保留接口以便将来加导出/导入） */
  flush(): Promise<void>;
}