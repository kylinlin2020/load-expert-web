/**
 * 静态版的架构边界检查
 *
 * 静态版能不能成立，取决于一条硬约束：
 * **`src/web/**` 里不许出现任何 Node / 服务端代码。**
 * 一旦有人从视图层 `import` 了 `node:sqlite` 或 `../db/db.js`，
 * 静态构建就会把 Node 模块打进浏览器 bundle —— 轻则白屏，重则构建期才炸。
 * 这类错误编译期查不出来（.vue 本来就不进 tsc），所以必须自动盯着。
 *
 * 同时验证「算法层可移植」这个前提：静态版在浏览器里跑的就是 `src/algorithm`，
 * 若哪天它引入了 Node 依赖，静态版会当场失效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根目录：从本文件位置往上找带 package.json 的那一层
 *
 * ## 为什么不能写死路径
 *
 * 写死某个开发机的绝对路径在本机能跑，**换到 Linux / GitHub Actions 立刻失败** ——
 * 而这三条边界检查恰恰必须在 CI 里跑（它们守的正是"静态产物能不能独立部署"）。
 * 往上找 package.json 与 cwd、tsc 输出布局（源码在 test/、编译后到 dist/test/）、
 * 操作系统都无关。
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`从 ${startDir} 往上找不到 package.json，无法确定仓库根目录`);
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** 报错信息里用相对路径（Windows 上 backslash 会让 replace 失效） */
function relOf(abs: string): string {
  return abs.replace(ROOT + '/', '').replace(ROOT + '\\', '');
}

/**
 * 递归收集指定扩展名的文件
 *
 * @param ext 扩展名正则片段，默认源码那三种。
 *             编码检查要额外带上 .html（dev-static-check.html 是会被人打开的产物），
 *             故做成参数而不是写死 —— 否则注释与实现会对不上。
 */
function walk(dir: string, ext = /\.(ts|vue|mjs)$/, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, ext, out);
    } else if (ext.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** 抽出文件里所有 import / require 的模块说明符 */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    specs.push(m[1]);
  }
  return specs;
}

test('src/web 不许引用 Node 内置模块或服务端代码', () => {
  const files = walk(join(ROOT, 'src/web'));
  assert.ok(files.length > 0, '应至少扫到一些 web 层文件');
  const offenders: string[] = [];
  for (const f of files) {
    const rel = relOf(f);
    for (const spec of importSpecifiers(readFileSync(f, 'utf8'))) {
      const bad =
        spec.startsWith('node:') ||
        /(^|\/)(db|server)\//.test(spec) ||
        spec === 'node:sqlite';
      if (bad) {
        offenders.push(`${rel} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `web 层出现了服务端依赖：\n${offenders.join('\n')}`);
});

test('src/algorithm 保持零 Node 依赖（静态版在浏览器里就跑它）', () => {
  const files = walk(join(ROOT, 'src/algorithm'));
  const offenders: string[] = [];
  for (const f of files) {
    const rel = relOf(f);
    for (const spec of importSpecifiers(readFileSync(f, 'utf8'))) {
      // 只允许同目录模块与 src/types
      if (spec.startsWith('node:')) {
        offenders.push(`${rel} -> ${spec}`);
        continue;
      }
      if (spec.startsWith('.') && !spec.startsWith('./') && !spec.startsWith('../')) {
        offenders.push(`${rel} -> ${spec}`);
      }
      if (spec.startsWith('../') && !spec.startsWith('../types/')) {
        offenders.push(`${rel} -> ${spec}（只应依赖 ../types/）`);
      }
    }
  }
  assert.deepEqual(offenders, [], `算法层混入了非纯依赖：\n${offenders.join('\n')}`);
});

test('两个数据实现都实现了完整的 ApiShape 方法集', async () => {
  // 少实现一个方法，视图层就会在某个页面报 "api.xxx is not a function"，
  // 而这种错误只有点到那个页面才会暴露
  const { httpApi } = await import('../src/web/api/httpClient.js');
  const { createLocalApi } = await import('../src/web/api/localClient.js');
  const { createMemStore } = await import('./helpers/memAdapter.js');

  // 手工列举：`ApiShape` 是 interface，编译后被擦除，运行时枚举不出来，
  // 所以这份列表只能手写 —— 也因此**每次给 ApiShape 加方法都要同步加到这里**。
  // 忘了的后果正是这条测试要防的：新方法没人实现，页面点过去才报
  // "api.xxx is not a function"，而 CI 一路绿灯。
  const required = [
    'health', 'listBoxes', 'createBox', 'updateBox', 'deleteBox',
    'listContainers', 'createContainer', 'updateContainer', 'deleteContainer',
    'calculate', 'calculateMulti',
    'listPlans', 'getPlan', 'createPlan', 'deletePlan',
    // 实测案例（2026-10 起）
    'listCases', 'getCase', 'createCase', 'updateCaseActual', 'deleteCase',
  ] as const;

  const local = createLocalApi(createMemStore());
  const missingHttp = required.filter((m) => typeof (httpApi as never)[m] !== 'function');
  const missingLocal = required.filter((m) => typeof (local as never)[m] !== 'function');
  assert.deepEqual(missingHttp, [], 'httpApi 缺少方法');
  assert.deepEqual(missingLocal, [], 'localApi 缺少方法');
  assert.equal(httpApi.isLocal, false);
  assert.equal(local.isLocal, true);
});

/**
 * 源码里不许有 U+FFFD 替换字符
 *
 * ## 为什么这条值得单独一条测试
 *
 * U+FFFD 出现的唯一原因是：**某个中文字节的编码在写入时被打乱了**。
 * 它编译得过、测试跑得过、构建也过 —— 所有工具都把它当成一个合法字符，
 * 所以**没有任何环节会拦住它**，只能上线后由用户在界面上看见。
 *
 * 本项目踩过一次：4 个文件里各有一处，其中一处是**用户可见文案**
 * （"界面上那点问题不会" 变成了三个替换字符连在一起的样子）。
 * 如果没有这次人工排查，它会静静躺在 GitHub Pages 上。
 *
 * 故用自动检查兜住 —— 代价极小，覆盖的是一类"其它手段全都漏掉"的缺陷。
 */
test('源码里不许有 U+FFFD 替换字符（编码损坏的哨兵）', () => {
  /**
   * 用码点构造而不是字面字符 —— **哨兵文件不能包含哨兵**。
   *
   * 第一版直接写了字面的 U+FFFD，于是这条测试把自己判成违规（5 处），
   * 自己也一起红了。凡是"扫描某字符是否出现"的检查都得注意这一点：
   * 判定用的那个字符必须以代码点构造出来，否则会自我触发。
   *
   * 也不用 6 字符的转义写法（反斜杠 u F F F D）：它在 JSON / 命令行 / 编辑器之间
   * 反复转手，有可能在某一步被真的解成字符再写回文件，等于绕回同一个坑。
   */
  const BAD = String.fromCharCode(0xfffd);

  // 连 .html 一起扫：dev-static-check.html 也是会被人打开的产物
  const dirs = [join(ROOT, 'src'), join(ROOT, 'test'), join(ROOT, 'scripts')];
  const files = dirs.flatMap((d) => (existsSync(d) ? walk(d, /\.(ts|vue|mjs|html)$/) : []));
  assert.ok(files.length > 0, '应至少扫到一些文件');

  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!text.includes(BAD)) continue;
    // 报出**行号**：否则只给文件名，定位还得靠肉眼翻
    text.split('\n').forEach((line, i) => {
      if (line.includes(BAD)) offenders.push(`${relOf(f)}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `以下位置有 U+FFFD（编码损坏，界面会显示成替换符号）：\n${offenders.join('\n')}`,
  );
});