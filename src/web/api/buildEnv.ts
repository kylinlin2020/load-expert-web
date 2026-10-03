/**
 * 构建期环境读取（**对 Node 友好**）
 *
 * `import.meta.env` 是 Vite 在打包时注入的对象，**Node 里根本不存在**。
 * 直接写 `import.meta.env.MODE` 会让本模块在 Node 里一 import 就抛
 * `Cannot read properties of undefined` —— 这意味着带环境依赖的模块
 * 无法写单元测试（本次就是撞上了这个）。
 *
 * 所以这里集中做一次「可缺失」读取，全项目只有这一处碰 `import.meta.env`：
 * - `IS_STATIC_BUILD`：`vite build --mode static` 时为 true
 * - `API_BASE`：服务端版的后端地址，可用 .env 的 VITE_API_BASE 覆盖
 *
 * 类型标注成 `| undefined` 是**刻意的**：它在类型层面如实反映
 * 「Node 里这个值不存在」，TS 才会让我们写出安全的 `?.`。
 */
const env: Partial<ImportMetaEnv> | undefined = import.meta.env;

export const BUILD_MODE: string = env?.MODE ?? 'development';

/** 是否为「纯静态版」（无后端，数据在浏览器 IndexedDB） */
export const IS_STATIC_BUILD: boolean = BUILD_MODE === 'static';

/** 服务端版的后端基地址；默认空串表示同源相对路径（由 Vite 代理转发） */
export const API_BASE: string = env?.VITE_API_BASE ?? '';