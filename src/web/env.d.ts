/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基础地址，可通过 .env 中的 VITE_API_BASE 覆盖，默认 http://localhost:3000 */
  readonly VITE_API_BASE?: string;
  /**
   * 构建模式：`static` = 纯静态版（无后端，数据存 IndexedDB）
   *
   * 由 `vite build --mode static` 决定，**不需要额外设环境变量**
   * （`VITE_XXX=1 vite build` 这种写法在 Windows 的 PowerShell/cmd 下不通用，
   *  用 Vite 自带的 mode 更省事，也避免为此引入 cross-env 依赖）。
   */
  readonly MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
