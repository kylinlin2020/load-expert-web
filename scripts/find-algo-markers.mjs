/**
 * 为 check-static-bundle.mjs 挑选可靠的**正向标记**
 *
 * 目标：能断言"算法引擎确实编进了静态包"。
 * 这很重要 —— 如果哪天 Vite 把静态分支误判成死代码而摇掉算法，
 * 页面照样打得开、列表照样有数据（种子照写），
 * 只有点「开始计算」才会炸。属于**上线后才发现**的那一类故障。
 *
 * ## 踩过的坑（选标记不是随便挑个字符串就行）
 *
 * 第一版挑的是 `这个空间压在谁的头上`、`顶面高度恰好对齐` 这类**调试文案**，
 * 检查却报"算法被摇掉了"。查下来发现是标记选错了：
 * 这些字符串所在的函数从未被入口调用，属于死代码，被摇掉是**正确行为**。
 * 静态包里本来就不该有它们 —— 我的断言反而在报假警。
 *
 * 所以标记必须取自**每次计算都必然执行**的路径。候选里最稳的是
 * 「未装原因码」这类字面量：它由算法在装不下时产出，前端必须认识才能显示。
 *
 * 筛选标准：
 *  1. 是字符串字面量（压缩器只改标识符，不改字符串）
 *  2. 只出现在算法里，src/web 下任何文件都没有（否则前端也带了它，区分不了）
 *  3. 位于每次计算都会走到的代码路径上（不是调试分支）
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录：从脚本位置往上找带 package.json 的那一层（换机器/换 CI 也不会失效） */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`从 ${startDir} 往上找不到 package.json`);
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** 收集目录下所有文件的文本（顺带处理子目录） */
function collect(relDir, out = []) {
  for (const name of readdirSync(join(ROOT, relDir))) {
    const rel = `${relDir}/${name}`;
    try {
      out.push({ path: rel, txt: readFileSync(join(ROOT, rel), 'utf8') });
    } catch {
      collect(rel, out);
    }
  }
  return out;
}

const algoFiles = readdirSync(join(ROOT, 'src/algorithm')).filter((f) => f.endsWith('.ts'));
const webFiles = collect('src/web');

// 候选：算法里出现过的、看起来像"原因码/事件名"的小写连字符字符串
const candidates = new Map();
for (const f of algoFiles) {
  const txt = readFileSync(join(ROOT, 'src/algorithm', f), 'utf8');
  for (const m of txt.matchAll(/(['"`])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\1/g)) {
    if (!candidates.has(m[2])) candidates.set(m[2], new Set());
    candidates.get(m[2]).add(f);
  }
}

console.log(`算法里的连字符标识符候选：${candidates.size} 个\n`);
const usable = [];
for (const [marker, files] of candidates) {
  const inWeb = webFiles.filter((w) => w.txt.includes(marker)).map((w) => w.path);
  const isReasonCode = /^(space|stack|support|weight|overload|direction|count)/.test(marker);
  const ok = inWeb.length === 0;
  const tag = ok ? (isReasonCode ? '✓ 优选' : '✓ 可用') : '✗ web 层也有';
  console.log(`  ${tag}  ${marker.padEnd(24)} 源:${[...files].join(',')}  web:${inWeb.length ? inWeb.join(',') : '无'}`);
  if (ok) usable.push(marker);
}

console.log(`\n可用：${usable.length} 个`);
usable.forEach((m) => console.log('  ' + JSON.stringify(m)));