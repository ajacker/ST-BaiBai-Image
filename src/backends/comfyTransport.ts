/**
 * ComfyUI 请求通道。
 *
 * 四种（settings.comfyui.channel）：
 * - direct：只走浏览器直连。要求 ComfyUI 允许跨域（--enable-cors-header），
 *   且前置认证必须放行 OPTIONS 预检（预检按规范不带凭据，否则必然 401 无 CORS 头）。
 * - proxy：走 ST 自带的 CORS 代理 `/proxy/<目标URL>`（config.yaml 的 enableCorsProxy）。
 *   浏览器只访问同源路径（无预检），代理会把请求头（含 Authorization）、method、JSON body
 *   原样转发给 ComfyUI —— 等于「服务端带认证」，但**不需要装任何插件**。
 * - relay：走 comfy-relay 服务端插件（/api/plugins/comfy-relay/proxy），行为同上，
 *   但需要 `enableServerPlugins: true` + 放一个目录；好处是能加源白名单、不用开全局代理。
 * - auto：浏览器直连优先；网络级失败后依次试 proxy、relay、ST 内置转发
 *   （后两条是兜底，避免「什么都没装」时彻底不可用）。
 *
 * 为什么要一个统一入口：认证头、通道选择、错误语义必须对所有端点一致。
 * 之前漏过一处（/view 取图），结果就是「连得上但出不了图」，很难排查。
 */

import { comfyAuthHeaders } from '@/backends/comfyAuth';
import { ComfyProxyUnavailable, ComfyRelayUnavailable, ComfyUIError } from '@/backends/comfyErrors';
import { getContext } from '@/st/context';
import type { ComfyAuthCreds, ComfyChannel } from '@/state/settings';

/** ST 服务端插件路由（plugins/comfy-relay/index.js 注册在 /api/plugins/comfy-relay）。 */
const RELAY_PATH = '/api/plugins/comfy-relay/proxy';
/** relay 回填的上游状态码头：没有它 = 插件层面的失败（没装/参数错），不是 ComfyUI 的回应。 */
const RELAY_STATUS_HEADER = 'x-comfy-relay-status';

export const COMFY_RELAY_MISSING =
  '未检测到 comfy-relay 服务端插件：把仓库里的 st-server-plugin/comfy-relay 拷到 SillyTavern/plugins/，' +
  '在 config.yaml 里设 enableServerPlugins: true，重启 SillyTavern';

export const COMFY_PROXY_DISABLED =
  'ST 自带 CORS 代理未开启：在 SillyTavern/config.yaml 里设 enableCorsProxy: true（或启动加 --corsProxy），重启 SillyTavern 后本通道即可用';

export interface ComfyTransportConn {
  url: string;
  auth: ComfyAuthCreds | null;
  channel: ComfyChannel;
}

export interface ComfyRequestOptions {
  method?: 'GET' | 'POST';
  /** JSON 请求体；GET 时忽略。 */
  json?: unknown;
  signal?: AbortSignal;
}

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** relay 通道：一次 fetch 到 ST 自己的插件路由（同源，无预检），由服务端代发。 */
async function relayFetch(conn: ComfyTransportConn, path: string, options: ComfyRequestOptions): Promise<Response> {  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern 上下文不可用');

  const response = await fetch(RELAY_PATH, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({
      base: conn.url.trim(),
      path,
      method: options.method ?? 'GET',
      body: options.json,
      auth: conn.auth ?? null,
    }),
    signal: options.signal,
  });

  if (!response.headers.get(RELAY_STATUS_HEADER)) {
    const text = (await response.text().catch(() => '')).trim();
    // ST 对未挂载的插件路由回 404（HTML）：这就是「插件没装」的判据
    if (response.status === 404 || response.status === 501) {
      throw new ComfyRelayUnavailable(COMFY_RELAY_MISSING, response.status);
    }
    throw new ComfyUIError(
      `comfy-relay 转发失败 (${response.status})${text ? `：${text.slice(0, 300)}` : ''}`,
      response.status,
    );
  }

  return response;
}

/**
 * proxy 通道：走 ST 自带的 CORS 代理（server.js 的 app.use('/proxy/:url(*)')）。
 *
 * 浏览器只访问 ST 同源路径 → 没有预检、没有跨域；代理会：
 * - 透传请求头（只剔除 x-csrf-token/host/origin/cookie 等），所以 Authorization 能到 ComfyUI；
 * - 透传 method，POST 时把 body 重新 JSON 化后转发；
 * - 把响应体原样 pipe 回来（注意它**不复制 content-type**，图片类型靠文件名兜底）。
 *
 * 目标 URL 必须整体 encodeURIComponent 后塞进路径：`?filename=` 这类查询串
 * 如果留在外面会被 ST 当成自己的 query 吃掉（已在 express 4 的路由匹配上实测）。
 *
 * 已知坑：ST 的 forwardFetchResponse 会把上游 401 改成 400（避免顶掉 ST 自己的 Basic 认证），
 * 所以走这条通道时「密码错」表现为 400，而不是 401。
 */
async function stProxyFetch(conn: ComfyTransportConn, path: string, options: ComfyRequestOptions): Promise<Response> {
  const target = endpoint(conn.url, path);
  const headers: Record<string, string> = { ...comfyAuthHeaders(conn.auth) };
  const init: RequestInit = { method: options.method ?? 'GET', headers, signal: options.signal };
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  }

  // 相对路径：ST 若挂在子路径（/st/）下也能正确解析
  const response = await fetch(`proxy/${encodeURIComponent(target)}`, init);
  if (response.status === 404) {
    const text = await response.clone().text().catch(() => '');
    if (text.includes('CORS proxy is disabled')) {
      throw new ComfyProxyUnavailable(COMFY_PROXY_DISABLED, response.status);
    }
  }
  return response;
}

/**
 * 统一请求入口：调用方只给相对 path（可带查询串）与可选的 JSON 体，
 * 拿回一个与 fetch 同形的 Response（status/ok/text/json/blob 都能用）。
 */
export async function comfyFetch(
  conn: ComfyTransportConn,
  path: string,
  options: ComfyRequestOptions = {},
): Promise<Response> {
  if (conn.channel === 'relay') return relayFetch(conn, path, options);
  if (conn.channel === 'proxy') return stProxyFetch(conn, path, options);

  const headers: Record<string, string> = { ...comfyAuthHeaders(conn.auth) };
  const init: RequestInit = { method: options.method ?? 'GET', headers, signal: options.signal };
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  }
  return fetch(endpoint(conn.url, path), init);
}

/** 直连通道失败时的可操作提示（只用于给用户看，不改变控制流）。 */
export const COMFY_DIRECT_UNREACHABLE =
  '浏览器直连 ComfyUI 失败（跨域被拦 / 连接不上 / 混合内容）。' +
  '可把「请求通道」改成「ST 代理」（config.yaml 开 enableCorsProxy）或「插件转发」，' +
  '或给 ComfyUI 加 --enable-cors-header';
