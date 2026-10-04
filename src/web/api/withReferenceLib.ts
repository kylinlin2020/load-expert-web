/**
 * 「共享资料库」装饰器
 *
 * ## 为什么用装饰器而不是改 localClient
 *
 * `localClient` 被测试直接 import。往里塞远程拉取会让单测依赖网络/时钟，
 * 且把"读本地"和"读远程"两件事混在一个实现里。装饰器把两者分开：
 * 测试继续用干净的 `getLocalApi()`，远程能力只在这个壳上。
 *
 * ## 只改两个读方法
 *
 * `listBoxes` / `listContainers` 之外全部原样转发。这不是省事，
 * 而是**安全边界**：视图层拿到的 `api.createBox()` 一定落到本地存储，
 * 不存在"不小心把资料库改坏了"的路径 —— 它本来就是只读的。
 *
 * ## 服务端版也套这一层吗
 *
 * 套。服务端版的 SQLite 已经在服务端、多个浏览器本来就共享同一份，
 * 再叠一层共享库会造成"库里套库"的困惑。**但**用户的实际用法是静态版，
 * 而这个壳在服务端版下 `libEnabled` 为 false 时是**零行为**的直通转发，
 * 所以套着无害，且将来若想给服务端版也提供资料库不必改这里。
 */
import type { Box, Container } from '../../types/index.js';
import { mergeAll, isFromLib as _isFromLib } from '../../model/referenceLib.js';
import type { ReferencePayload } from '../../model/referenceLib.js';
import { ensureLib, getDeletedIds } from '../lib/referenceStore.js';
import type { ApiShape } from './types.js';

/**
 * 来自共享资料库的 id
 *
 * 模块级单例，视图层用 `isFromLib(id)` 查询。
 * 刻意不做成"给每个对象挂 `fromLib` 字段" —— 那会污染 `Box`/`Container`
 * 两个领域类型，一路渗进存储列、备份文件、以及案例分享的脱敏逻辑。
 */
let boxLibIds = new Set<string>();
let containerLibIds = new Set<string>();
let libPayload: ReferencePayload | null = null;
let libReady = false;

/** 资料库是否已配置（未配置时下面所有查询都返回 false） */
export function libEnabled(): boolean {
  return libPayload !== null;
}

/** 某条是否来自共享资料库（只存在于库里、本地没有） */
export function isFromLib(kind: 'box' | 'container', id: string): boolean {
  if (!libReady) return false;
  const set = kind === 'box' ? boxLibIds : containerLibIds;
  return _isFromLib(String(id), set);
}

/**
 * 启动时预加载
 *
 * 在应用挂载前 `await` 一次，这样首屏的柜型/货物列表就已经含库里的条目，
 * 不需要"先空着、加载完再刷新"的闪烁。失败是静默的（见 referenceStore）。
 *
 * **刻意不在这里算 `boxLibIds` / `containerLibIds`**：
 * 手头没有本地数据，算出来的标记必然不准（会把本地已有的库同 id 条目
 * 也标成"来自库"）。真正的标记由 `listBoxes()` / `listContainers()` 在
 * 拿到本地数据之后重算 —— 那才是准的。视图也是先取列表再渲染，
 * 所以不存在"标记还没算对就显示"的窗口。
 */
export async function preloadLib(): Promise<void> {
  const out = await ensureLib();
  if (out.payload) {
    libPayload = out.payload;
  }
  libReady = true;
}

export function withReferenceLib(inner: ApiShape): ApiShape {
  return {
    ...inner,

    async listBoxes(): Promise<Box[]> {
      const local = await inner.listBoxes();
      if (!libPayload) return local;
      // 墓碑在这里生效：用户删过的库条目不再出现
      const r = mergeAll({ boxes: local, containers: [] }, libPayload, getDeletedIds());
      boxLibIds = r.marks.boxIds;
      return r.boxes;
    },

    async listContainers(): Promise<Container[]> {
      const local = await inner.listContainers();
      if (!libPayload) return local;
      const r = mergeAll({ boxes: [], containers: local }, libPayload, getDeletedIds());
      containerLibIds = r.marks.containerIds;
      return r.containers;
    },
  };
}
