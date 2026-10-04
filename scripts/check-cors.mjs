/**
 * 检测一个 URL 能否被浏览器 `fetch` 跨域读取
 *
 * ## 为什么需要这个工具
 *
 * 「统一数据源」最省事的做法是让浏览器去读一个放在网盘 / 对象存储上的 JSON。
 * 但 `fetch` 跨域有个硬门槛：**对方必须返回 `Access-Control-Allow-Origin`**。
 * 缺这个头，浏览器会直接拦掉响应 —— 请求其实发出去了、文件其实拿到了，
 * 只是 JS 拿不到内容，控制台报一条 CORS 错误。**这与服务器无关，纯看响应头。**
 *
 * 很多网盘的分享链接不返回这个头。所以动手做功能之前，先花 10 秒测一下。
 *
 * ## 用法
 *
 *   node scripts/check-cors.mjs <url> [更多 url...]
 *
 * 带引号，避免 shell 把 URL 里的 `&` 当成后台符号。
 *
 * ## 判定标准
 *
 * `fetch(url)` 不带自定义头时属于 **simple request**，**不会**触发预检，
 * 所以只要 GET 的响应里带 ACAO 就能读。故这里只把 GET 的 ACAO 当主判据；
 * OPTIONS 只作参考（将来若要用自定义头 / POST，就得看预检是否放行）。
 */
const UA = 'load-expert-check-cors/1.0';
const PROBE_ORIGIN = 'https://kylinlin2020.github.io';

/** 应用部署在 GitHub Pages 子路径下，所以 Origin 头带子路径才是真实的那个 */
const REAL_ORIGIN = 'https://kylinlin2020.github.io';

async function probe(url) {
  const out = { url, ok: false, reason: '' };

  // ── 主判据：simple GET 带 Origin ──
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Origin: REAL_ORIGIN, 'User-Agent': UA },
      redirect: 'follow',
    });
  } catch (e) {
    out.reason = `请求失败（网络/地址/证书）：${e.message ?? e}`;
    return out;
  }

  out.status = res.status;
  out.acao = res.headers.get('access-control-allow-origin');
  out.contentType = res.headers.get('content-type');
  out.length = res.headers.get('content-length');

  const acao = out.acao;
  if (acao === '*') {
    out.ok = true;
    out.reason = 'ACAO=*，任何来源都能读';
  } else if (acao === REAL_ORIGIN) {
    out.ok = true;
    out.reason = `ACAO 精确匹配本站 origin（${REAL_ORIGIN}）`;
  } else if (acao && acao.toLowerCase().includes(REAL_ORIGIN.toLowerCase())) {
    out.ok = true;
    out.reason = `ACAO 含本站 origin（${acao}）`;
  } else if (res.status >= 400) {
    out.reason = `HTTP ${res.status} —— 地址本身就不通，先解决这个再谈 CORS`;
  } else {
    out.reason = '**没有 Access-Control-Allow-Origin** → 浏览器 fetch 会被拦，JS 拿不到内容';
  }

  // 内容能不能当 JSON 用（另一个独立的坑，跟 CORS 无关）
  if (out.ok && out.contentType && !/json/i.test(out.contentType)) {
    out.reason += `；另：Content-Type 是 ${out.contentType}，不是 JSON（不影响 fetch，但要自己 JSON.parse）`;
  }

  return out;
}

/** 预检：将来若要用 POST / 自定义头才需要，纯 GET 用不到 */
async function preflight(url) {
  try {
    const r = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: REAL_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'User-Agent': UA,
      },
    });
    const allowMethods = r.headers.get('access-control-allow-methods');
    const allowOrigin = r.headers.get('access-control-allow-origin');
    if (!allowOrigin) return '预检不放行（纯 GET 用不到这条）';
    return `预检放行（allow-methods: ${allowMethods ?? '未声明'}）`;
  } catch (e) {
    return `预检请求失败：${e.message ?? e}`;
  }
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('用法：node scripts/check-cors.mjs <url> [更多 url...]');
  console.error('例：  node scripts/check-cors.mjs "https://你的网盘直链/柜型.json"');
  process.exit(2);
}

console.log(`探测 origin: ${REAL_ORIGIN}\n`);
let pass = 0;
for (const raw of urls) {
  const url = raw.trim();
  const r = await probe(url);
  const mark = r.ok ? '可以用  ' : '不能用';
  if (r.ok) pass++;
  console.log(`[${mark}] ${url}`);
  console.log(`         理由：${r.reason}`);
  if (r.status !== undefined) console.log(`         HTTP ${r.status}   Content-Type: ${r.contentType ?? '(无)'}`);
  if (r.ok) console.log(`         预检：${await preflight(url)}`);
  console.log('');
}

console.log(`${pass}/${urls.length} 个地址可被浏览器跨域读取`);
process.exit(pass === urls.length ? 0 : 1);
