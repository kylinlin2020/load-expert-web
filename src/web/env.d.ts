/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基础地址，可通过 .env 中的 VITE_API_BASE 覆盖，默认 http://localhost:3000 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
