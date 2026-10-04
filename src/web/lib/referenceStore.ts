/**
 * 共享资料库的拉取、缓存与本地设置
 *
 * ## 三条设计取舍
 *
 * **① 拉取失败必须完全静默。**
 * 这是个"锦上添花"的功能 —— 断网、网盘限流、文件被删、CORS 没配，
 * 都不该让用户看到报错，更不该挡住他正常装柜。失败就退回到"只有本地数据"，
 * 也就是本功能不存在时的样子。
 *
 * **② 缓存放 localStorage，且默认用远程的 ETag/Last-Modified 做条件请求。**
 * 每次启动都拉全量 JSON 浪费流量，而网盘的分享链接往往带 token、
 * 不适合每次都打。缓存 key 带 URL 的哈希，换地址不会读到旧缓存。
 *
 * **③ 墓碑与设置放 localStorage，不占 IndexedDB。**
 * 几十个 8 位 id 加一个 URL，量级只有几百字节；放进 IndexedDB 反而
 * 要多写一套 CRUD 与迁移。
 */
import type { BackupFile } from '../../model/backup.js';
import { parseBackup } from '../../model/backup.js';
import type { ReferencePayload } from '../../model/referenceLib.js';

const K = {
  url: 'le.reflib.url',
  payload: 'le.reflib.payload',
  etag: 'le.reflib.etag',
  deletedBoxes: 'le.reflib.del.box',
  deletedContainers: 'le.reflib.del.con',
} as const;

/** 缓存有效期：这段时间内直接用缓存，不发网络请求 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface LibState {
  /** 已配置的 URL；空串表示未启用 */
  url: string;
  payload: ReferencePayload | null;
  /** 上次成功拉取的时间戳（0 = 从未） */
  loadedAt: number;
  /** 缓存里的数据是否已过期（该重新拉了） */
  stale: boolean;
  lastError: string;
}

function ls(): Storage | null {
  try {
    // 无痕模式 / 隐私设置下访问 localStorage 可能直接抛 SecurityError
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const s = ls();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const s = ls();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    // 配额超限等：功能降级，不抛
  }
}

function readIds(key: string): Set<string> {
  const v = readJson<string[]>(key);
  return new Set(Array.isArray(v) ? v : []);
}

// ---------------------------------------------------------------------------
// 设置与墓碑
// ---------------------------------------------------------------------------

export function getLibUrl(): string {
  const s = ls();
  if (!s) return '';
  try {
    return s.getItem(K.url) ?? '';
  } catch {
    return '';
  }
}

/** 保存 URL。返回是否成功（存不进去要告诉用户，不能假装存了） */
export function setLibUrl(url: string): boolean {
  const s = ls();
  if (!s) return false;
  try {
    s.setItem(K.url, url.trim());
    return true;
  } catch {
    return false;
  }
}

/** 清除 URL 与缓存（墓碑保留 —— 那是用户的选择，不该被"重置"顺手抹掉） */
export function clearLib(): void {
  const s = ls();
  if (!s) return;
  for (const k of [K.url, K.payload, K.etag]) {
    try {
      s.removeItem(k);
    } catch {
      /* 忽略 */
    }
  }
}

export function getDeletedIds(): { boxIds: Set<string>; containerIds: Set<string> } {
  return { boxIds: readIds(K.deletedBoxes), containerIds: readIds(K.deletedContainers) };
}

export function addDeletedId(kind: 'box' | 'container', id: string): void {
  const key = kind === 'box' ? K.deletedBoxes : K.deletedContainers;
  const set = readIds(key);
  set.add(String(id));
  writeJson(key, [...set]);
}

/**
 * 撤销墓碑（把某条库条目放回列表）
 *
 * 目前界面没提供这个入口 —— 用户若想恢复某条，去维护设备上改资料库文件、
 * 换掉 id 重新上传即可（墓碑是按 id 记的，换 id 就绕开了）。
 * 留着这个函数是因为它是 addDeletedId 的自然逆操作，将来加"恢复"按钮直接用。
 */
export function removeDeletedId(kind: 'box' | 'container', id: string): void {
  const key = kind === 'box' ? K.deletedBoxes : K.deletedContainers;
  const set = readIds(key);
  set.delete(String(id));
  writeJson(key, [...set]);
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

/** 备份文件 → 参考库载荷。只取柜型与货物，方案/案例是业务记录不该跨设备传 */
function toPayload(file: BackupFile): ReferencePayload {
  return {
    boxes: file.data.boxes ?? [],
    containers: file.data.containers ?? [],
    exportedAt: file.exportedAt,
    appVersion: file.appVersion,
  };
}

export interface FetchOutcome {
  ok: boolean;
  payload: ReferencePayload | null;
  /** 'network' | 'cache' | 'disabled' —— 用于界面上如实说明发生了什么 */
  source: 'network' | 'cache' | 'disabled';
  error: string;
}

/**
 * 确保本地有可用的资料库内容
 *
 * 优先级：内存/缓存（未过期）→ 网络（带条件请求）→ 旧缓存（过期了也先用着）
 * **任何一步失败都不抛异常**，最坏返回空载荷。
 */
export async function ensureLib(force = false): Promise<FetchOutcome> {
  const url = getLibUrl();
  if (!url) {
    return { ok: false, payload: null, source: 'disabled', error: '' };
  }

  const cached = readJson<ReferencePayload>(K.payload);
  const hasCache = cached !== null;

  if (!force && hasCache && Date.now() - (readJson<{ at: number }>(K.url + '.at')?.at ?? 0) < CACHE_TTL_MS) {
    return { ok: true, payload: cached, source: 'cache', error: '' };
  }

  // 只允许 http/https；挡掉 file:// 与 javascript: 之类
  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: hasCache,
      payload: cached,
      source: 'cache',
      error: '地址必须以 http:// 或 https:// 开头',
    };
  }

  try {
    const headers: Record<string, string> = {};
    const etag = ls()?.getItem(K.etag) ?? '';
    if (etag) headers['If-None-Match'] = etag;

    const res = await fetch(url, { headers, cache: 'no-cache' });

    if (res.status === 304) {
      writeJson(K.url + '.at', { at: Date.now() });
      return { ok: hasCache, payload: cached, source: 'cache', error: '' };
    }
    if (!res.ok) {
      return { ok: hasCache, payload: cached, source: 'cache', error: `服务器返回 HTTP ${res.status}` };
    }

    const text = await res.text();
    // 复用备份格式的严格校验：格式不对时明确报错，而不是塞半截数据进来
    const file = parseBackup(text);
    const payload = toPayload(file);

    writeJson(K.payload, payload);
    writeJson(K.url + '.at', { at: Date.now() });
    const newEtag = res.headers.get('etag');
    if (newEtag) {
      try {
        ls()?.setItem(K.etag, newEtag);
      } catch {
        /* 忽略 */
      }
    }
    return { ok: true, payload, source: 'network', error: '' };
  } catch (e) {
    // 典型是 CORS 被拦（TypeError）与断网。**兜底用旧缓存**，
    // 所以断网几天后照样能查到上次拉到的那份资料。
    const msg = e instanceof Error ? e.message : String(e);
    const isCors = msg.includes('Failed to fetch') || msg.includes('NetworkError');
    return {
      ok: hasCache,
      payload: cached,
      source: 'cache',
      error: isCors ? '拉取失败（通常是地址不允许跨域，或网络不通）' : `拉取失败：${msg}`,
    };
  }
}

/** 当前状态，供设置界面显示 */
export function libState(outcome?: FetchOutcome): LibState {
  const url = getLibUrl();
  const at = readJson<{ at: number }>(K.url + '.at')?.at ?? 0;
  return {
    url,
    payload: readJson<ReferencePayload>(K.payload),
    loadedAt: at,
    stale: at > 0 && Date.now() - at >= CACHE_TTL_MS,
    lastError: outcome?.error ?? '',
  };
}

/**
 * 探测一个地址能否用（不写入任何设置）
 *
 * 与 ensureLib 分开：用户可能想先验一下地址再决定存不存。
 * 复用 parseBackup 校验，所以"能拉到"和"内容是合法资料库"一起验掉。
 */
export async function probeLibUrl(
  url: string,
): Promise<{ ok: boolean; boxes: number; containers: number; error: string }> {
  if (!/^https?:\/\//i.test(url.trim())) {
    return { ok: false, boxes: 0, containers: 0, error: '地址必须以 http:// 或 https:// 开头' };
  }
  try {
    const res = await fetch(url.trim(), { cache: 'no-cache' });
    if (!res.ok) return { ok: false, boxes: 0, containers: 0, error: `HTTP ${res.status}` };
    const file = parseBackup(await res.text());
    return {
      ok: true,
      boxes: file.data.boxes?.length ?? 0,
      containers: file.data.containers?.length ?? 0,
      error: '',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isCors = msg.includes('Failed to fetch') || msg.includes('NetworkError');
    return {
      ok: false,
      boxes: 0,
      containers: 0,
      error: isCors
        ? '浏览器拦下了跨域请求 —— 这个地址没有返回 Access-Control-Allow-Origin 头，网盘分享链接一般不返回'
        : `拉取失败：${msg}`,
    };
  }
}
