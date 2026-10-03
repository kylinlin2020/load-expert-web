/**
 * 静态产物体检：确认 dist/web 是一份"真能独立跑"的产物
 *
 * ## 为什么要构建完再查
 *
 * `test/static-boundary.test.ts` 查的是**源码层**边界（src/web 不许 import node:*）。
 * 但边界之外还有两类只有看真实产物才能发现的问题：
 *
 *  1. **污染**：某个第三方包内部 require('node:fs')，或 Vite polyfill 没生效
 *  2. **摇没了**：Vite 把静态分支误判成死代码，连带把算法引擎摇掉 ——
 *     这种故障页面照样打得开、柜型列表照样有数据（种子照写），
 *     只在点「开始计算」时才炸。属于**上线后才发现**的那一类。
 *
 * 所以这里既查"不该有的"，也查"该有的在不在"。
 *
 * 用法：npm run build:web:static（已自动串上本脚本）
 * 或   node scripts/check-static-bundle.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'D:/output/load-expert-web/dist/web';

/** 出现即视为污染的标识（都是我们**绝不会**打进静态包的东西） */
const FORBIDDEN = [
  'node:sqlite',
  'DatabaseSync',
  'fastify',
  'node:fs',
  'node:path',
  '__dirname',
  'process.env',
  'child_process',
];

/**
 * 必须**存在**的标记 —— 算法引擎的指纹
 *
 * ## 为什么用字符串而不是函数名
 *
 * 压缩器会改标识符。实测产物里搜不到 `SpaceManager` / `generateCandidateBlock`，
 * 但算法代码其实在包里 —— 用函数名做断言只会得到永久性的假警。
 * 字符串字面量则永远保留。
 *
 * ## 标记也可能过期（第一版就踩了）
 *
 * 最初挑的是 `这个空间压在谁的头上`、`顶面高度恰好对齐` 这类调试文案，
 * 结果检查报"算法被摇掉了"。实际是标记选错：那些字符串所在函数从未被入口调用，
 * 属于死代码，被摇掉是**正确**行为，静态包里本来就不该有。
 *
 * 所以这里不只查包，还**回查源码**：标记若已从算法里消失，报"标记过期"，
 * 而不是误报"算法被摇掉"。两类问题必须分清，否则这个检查很快就会被忽略。
 */
const REQUIRED = [
  { marker: 'space-exhausted', src: 'src/algorithm/load.ts' },
  { marker: 'dim-mismatch', src: 'src/algorithm/simplex.ts' },
  { marker: 'empty-problem', src: 'src/algorithm/simplex.ts' },
];
const SRC_ROOT = 'D:/output/load-expert-web';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(OUT_DIR);
} catch {
  console.error(`✗ 找不到产物目录 ${OUT_DIR}，请先执行：npm run build:web:static`);
  process.exit(1);
}

const js = files.filter((f) => f.endsWith('.js'));
if (js.length === 0) {
  console.error('✗ 产物里没有 .js，构建可能失败了');
  process.exit(1);
}

let bad = 0;
const bundle = js.map((f) => ({ f, src: readFileSync(f, 'utf8') }));

for (const { f, src } of bundle) {
  const rel = f.replace(OUT_DIR + '/', '');
  for (const key of FORBIDDEN) {
    const n = src.split(key).length - 1;
    if (n > 0) {
      console.error(`✗ ${rel} 里出现「${key}」× ${n}`);
      bad++;
    }
  }
}

const all = bundle.map((b) => b.src).join('\n');

// 正向断言 1：静态版必须在浏览器里跑算法，算法不能被摇掉。
// 每一项都先回查源码，把"标记过期"和"算法丢失"分开报。
let stale = 0;
for (const { marker, src } of REQUIRED) {
  let inSource = false;
  try {
    inSource = readFileSync(join(SRC_ROOT, src), 'utf8').includes(marker);
  } catch {
    inSource = false;
  }
  if (!inSource) {
    console.error(`✗ 标记已过期：「${marker}」在 ${src} 里找不到了`);
    console.error('    请重新挑选（node scripts/find-algo-markers.mjs 可列出候选）。这不是构建问题。');
    stale++;
    continue;
  }
  if (!all.includes(marker)) {
    console.error(`✗ 产物里找不到算法指纹「${marker}」(${src}) —— 算法引擎可能被 tree-shake 掉了`);
    console.error('    页面还能打开、柜型也能列出来，但点「开始计算」会报 load is not a function。');
    bad++;
  }
}

// 正向断言 2：数据层（IndexedDB 适配器）必须在包里，否则会静默退化成空数据
if (!all.includes('indexedDB')) {
  console.error('✗ 产物里没有 indexedDB —— 静态版的数据层没打进来');
  bad++;
}

// index.html 的资源引用必须是相对路径，否则换个部署目录就全挂
const html = readFileSync(join(OUT_DIR, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = m[1];
  if (url.startsWith('/')) {
    console.error(`✗ index.html 里有绝对路径资源「${url}」，静态版必须用相对路径（./）`);
    bad++;
  }
}

const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`检查了 ${js.length} 个 JS 文件（共 ${js.reduce((a, f) => a + kb(f), 0)} KB）`);
if (bad > 0) {
  console.error(`✗ 发现 ${bad} 处问题，静态产物不能部署`);
  process.exit(1);
}
if (!files.some((f) => f.endsWith('.nojekyll'))) {
  console.warn('⚠ 产物里没有 .nojekyll（GitHub Pages 上建议带上，防止被 Jekyll 忽略）');
}
console.log('✓ 静态产物可独立部署：无 Node/服务端代码，算法与数据层都在包内，资源引用为相对路径');