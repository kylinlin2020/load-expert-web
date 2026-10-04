/**
 * 真实 IndexedDB 适配器（浏览器）
 *
 * 原生 IndexedDB 是 callback 风格且相当啰嗦，这里包成 Promise。
 * 刻意**不引第三方库**（如 idb）：本项目定位是"扔到任何能发文件的地方就能跑"，
 * 多一个依赖就多一份供应链与体积负担，而这层封装总共不到 100 行。
 */
import type { Row, RowStore, StoreName } from './rowStore.js';

const DB_NAME = 'load-expert';
/**
 * 版本 2：新增 `cases` 表（实测案例）。
 *
 * IndexedDB 的版本**只能往上升**，所以新增表必须 +1。
 * 好消息是 `onupgradeneeded` 只创建**不存在**的表，
 * 已有的 boxes/containers/plans 数据**不受影响** —— 不需要写数据迁移。
 */
const DB_VERSION = 2;
const STORE_NAMES: StoreName[] = ['boxes', 'containers', 'plans', 'cases'];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORE_NAMES) {
        // keyPath 'id' + autoIncrement：与 SQLite 的 INTEGER PRIMARY KEY AUTOINCREMENT 对齐，
        // 插入后由浏览器分配自增 id，调用方不传 id 即可
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用，请关闭其它本页后重试'));
  });
  return dbPromise;
}

/** 把 IDBRequest 包成 Promise */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
  });
}

export function createIdbStore(): RowStore {
  return {
    async all<T extends Row>(store: StoreName): Promise<T[]> {
      const db = await openDb();
      const tx = db.transaction(store, 'readonly');
      const rows = await reqToPromise(tx.objectStore(store).getAll() as IDBRequest<T[]>);
      // IndexedDB 的 getAll 按主键升序返回，与 SQLite 的 ORDER BY id 一致
      return rows;
    },

    async get<T extends Row>(store: StoreName, id: number): Promise<T | undefined> {
      const db = await openDb();
      const tx = db.transaction(store, 'readonly');
      const row = await reqToPromise(tx.objectStore(store).get(id) as IDBRequest<T | undefined>);
      return row ?? undefined;
    },

    async put<T extends Row>(store: StoreName, row: Omit<T, 'id'> & { id?: number }): Promise<T> {
      const db = await openDb();
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      // autoIncrement **只在 keyPath 属性缺失时**才生成键；
      // 属性存在但值为 undefined 会被当成"求值出非法键"而抛 DataError
      //（探针实测报错：Evaluating the object store's key path yielded a value that is not a valid key）
      // 所以这里必须真的把 id 键**删掉**，而不是传 id: undefined。
      const rec = { ...row } as Record<string, unknown>;
      if (rec.id === undefined) {
        delete rec.id;
      }
      const key = await reqToPromise(os.put(rec as unknown as T) as IDBRequest<IDBValidKey>);
      // put 不会把生成的键回填到传入对象上，需自行组装返回值
      return { ...(rec as T), id: rec.id ?? Number(key) };
    },

    async remove(store: StoreName, id: number): Promise<boolean> {
      const db = await openDb();
      const tx = db.transaction(store, 'readwrite');
      const existing = await reqToPromise(tx.objectStore(store).getKey(id) as IDBRequest<IDBValidKey | undefined>);
      if (existing === undefined) {
        return false;
      }
      await reqToPromise(tx.objectStore(store).delete(id) as unknown as IDBRequest<undefined>);
      return true;
    },

    async clear(store: StoreName): Promise<number> {
      const db = await openDb();
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      // 必须先 await count 再 clear：IDB 事务会在事件循环里没有待处理请求时自动提交，
      // 中途 await 会让事务有机会被提前提交掉。实测把两者串行 await 即可，
      // 因为 count 的请求是在同一个任务里发出的，事务还活着。
      const n = await reqToPromise(os.count());
      await reqToPromise(os.clear() as unknown as IDBRequest<undefined>);
      return n;
    },

    async count(store: StoreName): Promise<number> {
      const db = await openDb();
      const tx = db.transaction(store, 'readonly');
      return reqToPromise(tx.objectStore(store).count());
    },

    async flush(): Promise<void> {
      // IndexedDB 的事务自动提交，无需显式 flush
    },
  };
}

/** 供测试/诊断：丢弃缓存的连接（浏览器里切换 origin 或调试时用） */
export function resetIdbConnection(): void {
  dbPromise = null;
}