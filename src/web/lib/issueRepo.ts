/**
 * 构建期配置：Issue 仓库地址
 *
 * ## 为什么要走环境变量而不是写死
 *
 * 不同部署可能指向不同的仓库（自己的 fork、内部镜像）。
 * 写死在代码里就得改代码重新构建；而这是**纯配置**，
 * 塞进 `.env`（已被 gitignore）或 CI 的环境变量即可。
 *
 * 没配置时 `ISSUE_URL` 为空串 —— 反馈页会自动把「提交 Issue」按钮置灰，
 * 只保留「复制诊断信息」那条路。功能降级而不是报错。
 */

/** 形如 `https://github.com/<owner>/<repo>`；未配置则为空串 */
export const ISSUE_URL: string = (import.meta.env.VITE_ISSUE_REPO ?? '').replace(/\/+$/, '');