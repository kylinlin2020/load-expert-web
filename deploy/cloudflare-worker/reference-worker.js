/**
 * 装柜专家 · 共享资料库 Worker（Cloudflare Workers）
 *
 * ## 它解决什么
 *
 * 静态版的数据只在本浏览器里。想让多台设备查到同一份柜型/货物规格，
 * 就需要一个「放 JSON 的地方」。这个 Worker 就是那个地方。
 *
 * ## 为什么不是网盘 / 公开仓库里的文件
 *
 * - **网盘**（百度盘 / 阿里云盘 / Google Drive…）：`fetch` 跨域读文件要求响应带
 *   `Access-Control-Allow-Origin`，这些都不带 —— 浏览器直接拦下响应。
 *   另外 Google Drive 的 `/file/d/<ID>/view` 返回的是 **HTML 预览页**，
 *   根本不是文件内容，就算跨域通了也解析不了。
 * - **公开仓库里的文件**：能用（GitHub Pages 确实返回 `ACAO=*`），
 *   但仓库是公开的，任何人翻一下就能读到你的货物规格 ——
 *   那不叫「URL 不公开」。
 *
 * Worker 的好处：免费额度足够（每天 10 万次请求，你一天大概十几次）、
 * 响应头自己说了算、地址带一段你自己设的随机路径。
 *
 * ## 部署（一次性，五步）
 *
 * 1. Cloudflare Dashboard → Workers & Pages → Create → Worker，起个名字
 * 2. 部署（会生成 `https://<名字>.<你的子域>.workers.dev`）
 * 3. 把本文件内容整个替换进编辑器 → Deploy
 * 4. **Settings → Variables and Secrets → Add → secret，名字填 `LIB_TOKEN`，
 *    值填你自己的一段随机串**（生成方法见下）
 * 5. 把 `LIB_TOKEN` 那一串拼到路径后面访问：
 *    `https://<名字>.<你的子域>.workers.dev/lib/<你的串>`
 *
 * 随机串生成：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
 *
 * 然后在装柜专家的「数据备份 → 共享资料库」里填第 5 步那个地址。
 *
 * ## 为什么 token 用 secret 而不是写在代码里
 *
 * **本仓库是公开的。** token 一旦写进这个文件，任何人读到源码就知道资料库地址 ——
 * 那等于没有「URL 不公开」这回事。所以代码里**没有、也不能有** token，
 * 只从 `env.LIB_TOKEN` 读。没配 secret 时 Worker 直接返回 500 并说明该做什么，
 * 而不是用某个默认值兜底（默认值一旦被提交就等于公开）。
 *
 * ## 更新资料库内容（两种方式）
 *
 * **方式 A：改源码里的 `DEFAULT_JSON` 再 Deploy。**
 * 适合极少改动的情况 —— 柜型尺寸本来就固定，货物规格变动很慢。
 *
 * **方式 B：绑一个 KV 命名空间（内容多时更方便，优先于 DEFAULT_JSON）**
 *
 *   npx wrangler kv namespace create LIB          # 把返回的 id 填进 wrangler.toml
 *   npx wrangler kv put LIB reference.json --path reference.json --local=false
 *
 * 用自己的 Cloudflare 账号执行即可，**不需要把密钥交给任何人**。
 *
 * ## 安全性说明（如实讲清，别误以为它是 airtight）
 *
 * - 读：路径里的 `LIB_TOKEN` 就是唯一凭据。这属于** obscurity，不是鉴权** ——
 *   别人拿到 token 就能读。token 够长（48 位十六进制）的话没人猜得到，
 *   但别把它当真正的访问控制。
 * - 写：**本 Worker 不提供任何写入接口**。内容只能通过 Cloudflare 控制台 /
 *   `wrangler kv put` 改，也就是只有你能改。这是刻意的 ——
 *   一旦加一个带 token 的 PUT 接口，那个 token 就得存进某个客户端，
 *   而本地存储里的密钥挡不住 XSS。为了少一次手动粘贴而暴露可写入口，不值得。
 */

/** 没配 secret 时的兜底内容（一般不会走到，除非部署时忘了配 LIB_TOKEN） */
const DEFAULT_JSON = {
  format: 'load-expert-backup',
  version: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  appVersion: 'initial',
  counts: { boxes: 0, containers: 0, plans: 0 },
  data: { boxes: [], containers: [], plans: [] },
};

/**
 * CORS 头
 *
 * 固定 `*` 而不是回显 Origin：这个 Worker 本来就是公开可读的，
 * 回显只会让人误以为有来源限制。
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match, Content-Type',
  // 暴露 ETag：客户端要能看到它才能用 If-None-Match 做条件请求
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};

/**
 * 用 WebCrypto 算 ETag
 *
 * 客户端（referenceStore.ensureLib）会带 `If-None-Match` 做条件请求，
 * 内容没变返回 304，省流量也省一次 JSON.parse。所以这不是装饰。
 *
 * **必须用 SHA-256 而不是 MD5** —— WebCrypto 只支持 SHA 系列，
 * `digest('MD5', …)` 会抛 `NotSupportedError: Unrecognized algorithm name`，
 * Worker 每次请求都 500。（这个 bug 是被 deploy/cloudflare-worker/test-worker.mjs 抓出来的。）
 *
 * 取前 16 字节（32 位十六进制）做 ETag：够短，且碰撞概率对这个用途可忽略。
 */
async function etagOf(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `"${hex.slice(0, 32)}"`;
}

/**
 * 处理函数
 *
 * 刻意导出成独立函数（而不是只在 default.fetch 里写）——
 * 这样能在 Node 里直接 import 它做测试，不必真的部署一个 Worker。
 */
export async function handleRequest(request, env) {
  const url = new URL(request.url);

  // 预检。客户端的简单 GET 其实用不到，但带上更稳（将来若加自定义头就需要）
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...CORS, Allow: 'GET, HEAD, OPTIONS', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // token 从 secret 读。**绝不在源码里给默认值** ——
  // 这个仓库是公开的，任何写进代码的默认值都会成为公开的 token。
  const token = env?.LIB_TOKEN;
  if (!token) {
    return new Response(
      'LIB_TOKEN secret 未配置。\n' +
        '请到 Cloudflare Dashboard → 这个 Worker → Settings → Variables and Secrets → Add，\n' +
        '类型选 Secret，名字填 LIB_TOKEN，值填你自己生成的随机串，然后 Deploy。\n' +
        '（之所以不写在代码里：本仓库是公开的，写进去就等于公开了。）',
      { status: 500, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  // 路径里必须带 token，否则不给内容
  if (!url.pathname.includes(`/${token}`)) {
    return new Response('Not Found', {
      status: 404,
      headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 内容来源：优先 KV，其次源码里的 DEFAULT_JSON
  let text;
  let from = 'source';
  if (env?.LIB) {
    const stored = await env.LIB.get('reference.json', 'json');
    if (stored) {
      text = JSON.stringify(stored);
      from = 'kv';
    }
  }
  if (!text) text = JSON.stringify(DEFAULT_JSON);

  const etag = await etagOf(text);

  // 条件请求命中。**304 也必须带 CORS 头** ——
  // 少了 Access-Control-Allow-Origin，浏览器会把 304 当失败，
  // 于是缓存永远不生效、每次都当没命中。
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ...CORS, ETag: etag } });
  }

  const bytes = new TextEncoder().encode(text);
  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
    ETag: etag,
    // 内容变了要能立刻被客户端发现，所以 CDN 只缓存 5 分钟
    'Cache-Control': 'public, max-age=300',
    'X-Lib-Source': from,
  };

  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(text, { status: 200, headers });
}

export default {
  fetch: handleRequest,
};
