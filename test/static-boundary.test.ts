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
 * 写死 `D:/output/load-expert-web` 在本机能跑，**换到 Linux / GitHub Actions 立刻失败** ——
 * 而这三条边界检查恰恰必须在 CI 里跑（它们守的正是"静态产物能不能独立部署"）。
 * 往上找 package.json 与 cwd、tsc 输出布局（源码在 test/、编译后�� dist/test/）、
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

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|vue|mjs)$/.test(name)) {
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

  const required = [
    'health', 'listBoxes', 'createBox', 'updateBox', 'deleteBox',
    'listContainers', 'createContainer', 'updateContainer', 'deleteContainer',
    'calculate', 'calculateMulti',
    'listPlans', 'getPlan', 'createPlan', 'deletePlan',
  ] as const;

  const local = createLocalApi(createMemStore());
  const missingHttp = required.filter((m) => typeof (httpApi as never)[m] !== 'function');
  const missingLocal = required.filter((m) => typeof (local as never)[m] !== 'function');
  assert.deepEqual(missingHttp, [], 'httpApi 缺少方法');
  assert.deepEqual(missingLocal, [], 'localApi 缺少方法');
  assert.equal(httpApi.isLocal, false);
  assert.equal(local.isLocal, true);
});