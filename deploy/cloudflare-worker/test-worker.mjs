/**
 * Worker 逻辑测试（不部署也能跑）
 *
 * ## 为什么单独写、而不是并入 npm test 的 TS 测试
 *
 * `tsconfig.json` 没开 `allowJs`，TS 测试无法 import 这个 `.js`。
 * 硬要并进去只有三条路：开 allowJs（会改变整个构建行为）、
 * 把 Worker 改成 .ts（Workers 部署侧要多一层编译）、或测试里 eval 源码（脆）。
 * 都不是好代价。
 *
 * 所以它是**独立的 node --test**，再由 `npm test` 串起来跑 ——
 * 这样 CI（`npm ci && npm test`）照样会验证它。
 *
 * ## 它守的是什么
 *
 * ① **CORS 头必须齐** —— 少一个 `Access-Control-Allow-Origin`，
 *    浏览器就静默拦下响应，用户只会看到"地址不可用"
 * ② **304 也必须带 CORS 头** —— 这条最容易被忽略。少了它浏览器把 304 当失败，
 *    缓存永远不生效，每次都当没命中（功能仍能用，但白费了条件请求）
 * ③ **token 绝不能有默认值** —— 这个仓库是公开的，
 *    写进源码的默认 token 等于公开的资料库地址
 * ④ **没配 secret 时要 500 并说清怎么做**，而不是悄悄用空库糊弄过去
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './reference-worker.js';

const TOKEN = 'test-token-abc123';
const BASE = 'https://lib.example.workers.dev';

const ENV = { LIB_TOKEN: TOKEN };

/** 造一个请求。默认带上正确 token 的路径 */
function req(path = `/lib/${TOKEN}`, init = {}) {
  return new Request(`${BASE}${path}`, init);
}

const CORS_KEYS = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
];

// ---------------------------------------------------------------------------
// CORS：这是整个功能成立的前提
// ---------------------------------------------------------------------------

test('200 响应带齐 CORS 头', async () => {
  const r = await handleRequest(req(), ENV);
  assert.equal(r.status, 200);
  for (const k of CORS_KEYS) {
    assert.ok(r.headers.get(k), `缺少 CORS 头：${k}`);
  }
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('Content-Type 是 JSON，且能直接被 parseBackup 吃下', async () => {
  const r = await handleRequest(req(), ENV);
  assert.match(r.headers.get('content-type') ?? '', /application\/json/);
  const body = JSON.parse(await r.text());
  assert.equal(body.format, 'load-expert-backup');
  assert.equal(body.version, 1);
  assert.ok(Array.isArray(body.data.boxes));
  assert.ok(Array.isArray(body.data.containers));
});

test('304 响应同样带 CORS 头 —— 少了它浏览器会把 304 当失败', async () => {
  const first = await handleRequest(req(), ENV);
  const etag = first.headers.get('etag');
  assert.ok(etag, '首个响应必须有 ETag，否则客户端无法做条件请求');

  const second = await handleRequest(req('/lib/' + TOKEN, { headers: { 'If-None-Match': etag } }), ENV);
  assert.equal(second.status, 304);
  assert.equal(
    second.headers.get('access-control-allow-origin'),
    '*',
    '304 缺 ACAO 是本测试守着的重点',
  );
  assert.equal(second.headers.get('etag'), etag);
});

test('If-None-Match 命中列表中的任意一个即算命中', async () => {
  const etag = (await handleRequest(req(), ENV)).headers.get('etag');
  const list = `"deadbeef", ${etag}`;
  const r = await handleRequest(req('/lib/' + TOKEN, { headers: { 'If-None-Match': list } }), ENV);
  assert.equal(r.status, 304, '逗号分隔的列表里有一个匹配就该 304');
});

test('If-None-Match 不匹配时返回 200 与新内容', async () => {
  const r = await handleRequest(req('/lib/' + TOKEN, { headers: { 'If-None-Match': '"stale"' } }), ENV);
  assert.equal(r.status, 200);
});

test('预检返回 204 且带 CORS 头', async () => {
  const r = await handleRequest(req('/lib/' + TOKEN, { method: 'OPTIONS' }), ENV);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-methods') ?? '', /GET/);
});

// ---------------------------------------------------------------------------
// token：仓库公开，所以绝不能有默认值
// ---------------------------------------------------------------------------

test('没配 LIB_TOKEN secret 时返回 500 并说明怎么配', async () => {
  const r = await handleRequest(req('/lib/whatever'), {});
  assert.equal(r.status, 500);
  const text = await r.text();
  assert.match(text, /LIB_TOKEN/, '应说出要配什么');
  assert.match(text, /Variables and Secrets|secret/i, '应说出在哪里配');
});

test('路径不带 token 时 404（不泄露内容）', async () => {
  const r = await handleRequest(req('/lib/wrong-token'), ENV);
  assert.equal(r.status, 404);
  assert.ok(!(await r.text()).includes('load-expert-backup'), '404 不应回内容');
});

test('根路径 404', async () => {
  const r = await handleRequest(req('/'), ENV);
  assert.equal(r.status, 404);
});

test('源码里没有硬编码 token —— 这个仓库是公开的，写进去就等于公开地址', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./reference-worker.js', import.meta.url), 'utf8'),
  );
  // 抓形如 `/xxxx...` 的默认 token 用法：LIB_TOKEN 只能是 env.LIB_TOKEN 读出来的
  assert.ok(
    /const token = env\?\.LIB_TOKEN/.test(src),
    '必须从 env.LIB_TOKEN 读取',
  );
  assert.ok(
    !/LIB_TOKEN\s*=\s*['"][0-9a-f]{16,}/i.test(src),
    '不得出现形如 LIB_TOKEN = "长十六进制串" 的硬编码默认值',
  );
});

// ---------------------------------------------------------------------------
// 方法与 KV
// ---------------------------------------------------------------------------

test('写入类方法一律 405 —— 内容只能通过 Cloudflare 控制台改', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await handleRequest(req('/lib/' + TOKEN, { method }), ENV);
    assert.equal(r.status, 405, `${method} 应被拒绝`);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', '405 也要带 CORS 头，否则浏览器报错难懂');
  }
});

test('HEAD 返回头但无正文，且带 Content-Length', async () => {
  const r = await handleRequest(req('/lib/' + TOKEN, { method: 'HEAD' }), ENV);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.ok(Number(r.headers.get('content-length')) > 0);
  assert.equal(await r.text(), '');
});

test('KV 里的内容优先于源码里的 DEFAULT_JSON', async () => {
  const payload = {
    format: 'load-expert-backup',
    version: 1,
    exportedAt: '2026-02-02T00:00:00.000Z',
    appVersion: 'from-kv',
    counts: { boxes: 1, containers: 1, plans: 0 },
    data: { boxes: [{ id: '1', name: 'KV 里的货物' }], containers: [{ id: '1', name: 'KV 里的柜型' }], plans: [] },
  };
  const env = {
    LIB_TOKEN: TOKEN,
    LIB: { get: async (k, t) => (k === 'reference.json' && t === 'json' ? payload : null) },
  };
  const r = await handleRequest(req('/lib/' + TOKEN, { method: 'HEAD' }), env);
  assert.equal(r.headers.get('x-lib-source'), 'kv');

  const body = await (await handleRequest(req('/lib/' + TOKEN), env)).json();
  assert.equal(body.appVersion, 'from-kv');
  assert.equal(body.data.boxes[0].name, 'KV 里的货物');
});

test('KV 取不到内容时回落到源码里的 DEFAULT_JSON', async () => {
  const env = { LIB_TOKEN: TOKEN, LIB: { get: async () => null } };
  const r = await handleRequest(req('/lib/' + TOKEN, { method: 'HEAD' }), env);
  assert.equal(r.headers.get('x-lib-source'), 'source');
});

test('同一内容两次请求的 ETag 相同（否则条件请求永远不命中）', async () => {
  const a = (await handleRequest(req('/lib/' + TOKEN, { method: 'HEAD' }), ENV)).headers.get('etag');
  const b = (await handleRequest(req('/lib/' + TOKEN, { method: 'HEAD' }), ENV)).headers.get('etag');
  assert.equal(a, b);
  assert.match(a ?? '', /^"[0-9a-f]{32}"$/);
});

test('内容不同的两个 Worker 实例 ETag 不同', async () => {
  const envA = { LIB_TOKEN: TOKEN, LIB: { get: async () => ({ format: 'load-expert-backup', data: { boxes: [], containers: [], plans: [] } }) } };
  const envB = { LIB_TOKEN: TOKEN, LIB: { get: async () => ({ format: 'load-expert-backup', data: { boxes: [{ id: '9' }], containers: [], plans: [] } }) } };
  const a = (await handleRequest(req('/lib/' + TOKEN, { method: 'HEAD' }), envA)).headers.get('etag');
  const b = (await handleRequest(req('/lib/' + TOKEN, { method: 'HEAD' }), envB)).headers.get('etag');
  assert.notEqual(a, b);
});
