/**
 * 版本信息 —— **本文件由 scripts/gen-version.mjs 自动生成，请勿手改**
 *
 * 重新生成：`npm run genversion`（build / dev / server 都会自动先跑一遍）
 * 版本规则：0.1.N，N = git 提交数。详见 scripts/gen-version.mjs 的注释。
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
  "version": "0.1.7",
  "source": "git",
  "commit": 7,
  "commitShort": "7a110d8",
  "commitDate": "2026-10-03T16:12:17+08:00",
  "dirty": true,
  "builtAt": "2026-10-03T08:18:23.206Z"
};

export default appVersion;
