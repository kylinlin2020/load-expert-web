/**
 * 生成版本信息 → src/version.ts
 *
 * ## 版本号规则：0.1.N，N = git 提交数
 *
 * 用户要求「版本号按 0.1.0 开始，按 GIT 迭代自增」。落地为：
 *
 *   主版本.次版本.修订号  =  package.json 的主.次 + git 提交总数
 *   例：提交 1 次 → 0.1.1，提交 57 次 → 0.1.57
 *
 * 为什么用提交数当修订号，而不是让人手改：
 * - **不会忘记**。手改版本号的必然结果是"改代码忘了改版本"，于是页面上
 *   显示 0.1.0 的东西其实是第 30 次迭代，没人看得出。
 * - 提交数天然单调递增，能直接当"这是第几版"用。
 * - 想手动控制节奏就 `git tag`，本脚本只读提交数，不需要额外的 tag 约定。
 *
 * ## 为什么生成成文件，而不是运行时读 git
 *
 * 部署时目录里通常**没有 .git**（只发 dist/ 和源码包）。若运行时去 shell 调 git，
 * 生产环境会静默退化成"版本未知"。所以：
 * - 构建/启动前跑本脚本，把结果**固化**进 src/version.ts
 * - 前端直接 import 它，不依赖 .git 存在
 * - 生成的 src/version.ts **入库**（不 ignore）：这样即使在无 git 的源码包里
 *   直接构建，也有可读的版本号，而不是崩掉
 *
 * ## 无 git 时怎么办
 *
 * 非 git 仓库（刚拿到一份源码、或临时解包）退回 package.json 的版本号，
 * 并把 `source` 标成 'package.json'，页面会**如实显示"未初始化 git"**，
 * 而不是假装它是个有版本管理的构建。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 跑一条 git 命令；任何异常（非仓库、git 未安装、命令失败）都返回 null，不抛
 *
 * **刻意不对返回值做 `.trim()`**：多行输出（`status --porcelain`）的首行
 * 前面两格是状态列（" M" / "M " / "??"），整体 trim 会把首行的前导空格吃掉，
 * 状态列就错位了，后面按固定列宽 slice 解析必然出错 —— 而且只在**有多个改动**时
 * 才出错（首行恰好是未暂存改动时），非常难查。单行结果由调用方各自 trim。
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

// 去掉可能的 BOM：PowerShell 的 `Out-File -Encoding utf8` / 某些编辑器会写 BOM，
// 而 JSON.parse 见到 BOM 直接抛 SyntaxError，报错信息还指向 package.json，很难查
const pkgText = readFileSync(join(root, 'package.json'), 'utf8').replace(/^﻿/, '');
const pkg = JSON.parse(pkgText);
const [baseMajor, baseMinor] = String(pkg.version ?? '0.1.0').split('.');

/** 本脚本自己产出的文件（相对仓库根，正斜杠） */
const SELF_PATH = 'src/version.ts';

/**
 * 工作区是否有未提交的**源码**改动
 *
 * 刻意把 `src/version.ts` 排除掉，否则会形成反馈死循环：
 * 本文件里存了 `builtAt` 构建时间戳，**每跑一次构建内容都变**
 * → 构建把 version.ts 改掉 → 工作区变脏 → 下次构建报 dirty=true
 * → 于是"有未提交改动"这个警告会永远亮着，而实际上源码一行没改。
 * 那个警告一旦变成常亮的噪音，就等于没有警告了。
 *
 * 注意：本函数与 SELF_PATH 必须声明在调用点之前 ——
 * `const` 有暂时性死区，定义在后面会在调用时抛 ReferenceError。
 */
function hasUncommittedSource() {
  const raw = git(['status', '--porcelain']);
  if (!raw) return false;
  const changed = raw
    // 必须按 /\r?\n/ 切：Windows 上 git 输出的是 CRLF，只按 '\n' 切的话
    // 每行末尾会残留一个 '\r'，于是路径变成 "src/version.ts\r"，
    // 跟 SELF_PATH 比永远不相等 → dirty 恒为 true（这个坑踩过一轮）。
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    // porcelain 每行固定是 "XY PATH"：XY 是两个状态字符 + 一个空格，共 3 字符。
    // 只能从**行首** slice(3)，不能先 trim —— 未暂存改动是 " M path"，
    // trim 掉前导空格后就变成 "M path"，再 slice(3) 会砍掉路径头几个字母。
    .map((line) => {
      const rest = line.slice(3);
      // 重命名行是 "R  old -> new"，路径取 new
      const p = rest.includes('->') ? rest.split('->').pop().trim() : rest.trimEnd();
      // git 会给含特殊字符的路径加引号
      return (p.startsWith('"') ? p.slice(1, -1) : p).replace(/\\/g, '/');
    })
    .filter((p) => p !== SELF_PATH);
  if (process.env.GEN_VERSION_DEBUG) {
    console.log('[debug] raw =', JSON.stringify(raw));
    console.log('[debug] changed =', JSON.stringify(changed));
  }
  return changed.length > 0;
}

const head = (git(['rev-parse', 'HEAD']) ?? '').trim();
let version;
let source;
let commit = null;
let commitShort = null;
let commitDate = null;
let dirty = null;

if (head) {
  const count = Number((git(['rev-list', '--count', 'HEAD']) ?? '').trim() || '0');
  if (Number.isFinite(count)) {
    version = `${baseMajor}.${baseMinor}.${count}`;
    source = 'git';
    commit = count;
    commitShort = head.slice(0, 7);
    commitDate = (git(['log', '-1', '--format=%cI']) ?? '').trim() || null;
    // 有未提交改动要**显式告诉使用者**：页面上显示的版本号对应的其实是
    // 上一次提交的状态，代码可能已经变了 —— 不标注就是误导。
    dirty = hasUncommittedSource();
  }
}

if (!version) {
  version = `${baseMajor}.${baseMinor}.0`;
  source = 'package.json';
}

const info = {
  version,
  source,
  commit,
  commitShort,
  commitDate,
  dirty,
  builtAt: new Date().toISOString(),
};

// 写成 TS 而不是 JSON：直接 import 就有类型，且不用配 resolveJsonModule
const out = `/**
 * 版本信息 —— **本文件由 scripts/gen-version.mjs 自动生成，请勿手改**
 *
 * 重新生成：\`npm run genversion\`（build / dev / server 都会自动先跑一遍）
 * 版本规则：0.1.N，N = git 提交数。详见 scripts/gen-version.mjs 的注释。
 *
 * ## 为什么 \`git status\` 里这个文件总是显示为已修改（正常现象）
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

export const appVersion: AppVersion = ${JSON.stringify(info, null, 2)};

export default appVersion;
`;

writeFileSync(join(root, 'src', 'version.ts'), out, 'utf8');
console.log(
  `[gen-version] ${info.version}  来源=${info.source}` +
    (info.commitShort ? `  提交=${info.commitShort}${info.dirty ? '(有未提交改动)' : ''}` : '  (未初始化 git)'),
);