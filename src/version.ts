/**
 * 版本信息 —— **本文件由 scripts/gen-version.mjs 自动生成，请勿手改**
 *
 * 重新生成：`npm run genversion`（build / dev / server 都会自动先跑一遍）
 * 版本规则：0.1.N，N = git 提交数。详见 scripts/gen-version.mjs 的注释。
 *
 * ## 为什么 `git status` 里这个文件总是显示为已修改（正常现象）
 *
 * 文件里的 commit 数取决于"当前提交数"，而**提交这个文件本身会让提交数 +1** ——
 * 于是永远差一拍：入库的是 0.1.7，重新生成后是 0.1.8。
 * 这不是不一致，是数学上的死结（没有不动点）。
 *
 * 实际发布的版本号始终正确，因为 build/dev 每次都会先重新生成。
 * 入库的目的只是给"没有 .git 的源码包"留一个可读的兜底版本。
 * 所以看到这一个文件长期 modified，直接忽略即可。
 */
export interface AppVersion {
  /** 完整版本号，如 0.1.12 */
  version: string;
  /** 版本号来源：git = 由提交数推算；package.json = 无 git 时的回退 */
  source: 'git' | 'package.json';
  /** git 提交总数（无 git 时为 null） */
  commit: number | null;
  /** 短提交号，如 3bf6c75 */
  commitShort: string | null;
  /** 最后一次提交时间（ISO 8601） */
  commitDate: string | null;
  /** 构建时工作区是否有未提交改动；true 表示页上版本号对应的其实是上一次提交 */
  dirty: boolean | null;
  /** 本次构建时间（ISO 8601） */
  builtAt: string;
}

export const appVersion: AppVersion = {
  "version": "0.1.19",
  "source": "git",
  "commit": 19,
  "commitShort": "c70e2cd",
  "commitDate": "2026-10-04T00:51:37+08:00",
  "dirty": true,
  "builtAt": "2026-10-03T17:07:43.874Z"
};

export default appVersion;
