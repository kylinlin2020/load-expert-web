/**
 * 内存版 RowStore（仅供 Node 测试）
 *
 * Node 的测试运行器没有 IndexedDB，所以 `localStore` / `localClient` 用这个适配器跑
 * **完全相同的代码路径** —— 这样静态版的数据层才真的能被测到，
 * 而不是只能靠手工点页面（§9.29 的教训：`.vue` 里的逻辑就是这么漏掉三个 bug 的）。
 *
 * ## 关键：这里刻意**复现** IndexedDB 的一个坑
 *
 * IndexedDB 的 autoIncrement 只在 keyPath 属性**缺失**时生成键；
 * `{ id: undefined, ... }` 会被判为"求值出非法键"而抛 DataError。
 * 若这个适配器宽容地接受 `id: undefined`，测试就永远测不出该 bug
 * （而真实浏览器里会直接失败）。所以这里照抄那条语义。
 */
import type { Row, RowStore, StoreName } from '../../src/web/api/rowStore.js';

export function createMemStore(): RowStore {
  const data = new Map<StoreName, Map<number, Row>>();
  const nextId = new Map<StoreName, number>();
  for (const s of ['boxes', 'containers', 'plans'] as StoreName[]) {
    data.set(s, new Map());
    nextId.set(s, 1);
  }

  const bucket = (s: StoreName): Map<number, Row> => {
    const b = data.get(s);
    if (!b) {
      throw new Error(`未知的表：${s}`);
    }
    return b;
  };

  return {
    async all<T extends Row>(store: StoreName): Promise<T[]> {
      return [...bucket(store).values()].sort((a, b) => a.id - b.id) as T[];
    },

    async get<T extends Row>(store: StoreName, id: number): Promise<T | undefined> {
      return bucket(store).get(id) as T | undefined;
    },

    async put<T extends Row>(store: StoreName, row: Omit<T, 'id'> & { id?: number }): Promise<T> {
      // 复现 IndexedDB：id 键存在且为 undefined → 非法键（与真实浏览器一致）
      if ('id' in row && row.id === undefined) {
        throw new Error(
          "DataError: Evaluating the object store's key path yielded a value that is not a valid key. " +
            '（内存适配器刻意复现 IndexedDB 行为：新增时不能写 id 键，哪怕值是 undefined）',
        );
      }
      const id = row.id ?? nextId.get(store)!;
      if (row.id === undefined) {
        nextId.set(store, id + 1);
      }
      const rec = { ...(row as object), id } as T;
      bucket(store).set(id, rec);
      return rec;
    },

    async remove(store: StoreName, id: number): Promise<boolean> {
      return bucket(store).delete(id);
    },

    async count(store: StoreName): Promise<number> {
      return bucket(store).size;
    },

    async flush(): Promise<void> {
      // 内存实现无需落盘
    },
  };
}