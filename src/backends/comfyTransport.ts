/**
 * ComfyUI 请求通道。
 *
 * 三种（settings.comfyui.channel）：
 * - direct：只走浏览器直连。要求 ComfyUI 允许跨域（--enable-cors-header），
 *   且前置认证必须放行 OPTIONS 预检（预检按规范不带凭据，否则必然 401 无 CORS 头）。
 * - relay：只走 comfy-relay 服务端插件（ST 的 /api/plugins/comfy-relay/proxy）。
 *   请求由 ST 服务端发出，浏览器不参与 —— 不受跨域、预检、混合内容任何限制，
 *   也能带 Basic 认证。这是「认证 + 公网域名」部署下的正解。
 * - auto：浏览器直连优先；直连是网络级失败（CORS/拒连/混合内容被拦）时才退到 relay，
 *   relay 插件不在时按旧逻辑退到 ST 内置转发（内置转发不带认证，故启用认证时不做）。
 *
 * 为什么要一个统一入口：认证头、通道选择、错误语义必须对所有端点一致。
 * 之前漏过一处（/view 取图），结果就是「连得上但出不了图」，很难排查。
 */

import { comfyAuthHeaders } from '@/backends/comfyAuth';
import { ComfyRelayUnavailable, ComfyUIError } from '@/backends/comfyErrors';
import { getContext } from '@/st/context';
import type { ComfyAuthCreds, ComfyChannel } from '@/state/settings';

/** ST 服务端插件路由（plugins/comfy-relay/index.js 注册在 /api/plugins/comfy-relay）。 */
const RELAY_PATH = '/api/plugins/comfy-relay/proxy';
/** relay 回填的上游状态码头：没有它 = 插件层面的失败（没装/参数错），不是 ComfyUI 的回应。 */
const RELAY_STATUS_HEADER = 'x-comfy-relay-status';

export const COMFY_RELAY_MISSING =
  '未检测到 comfy-relay 服务端插件：把仓库里的 st-server-plugin/comfy-relay 拷到 SillyTavern/plugins/，' +
  '在 config.yaml 里设 enableServerPlugins: true，重启 SillyTavern';

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
async function relayFetch(conn: ComfyTransportConn, path: string, options: ComfyRequestOptions): Promise<Response> {
  const context = getContext();
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
 * 统一请求入口：调用方只给相对 path（可带查询串）与可选的 JSON 体，
 * 拿回一个与 fetch 同形的 Response（status/ok/text/json/blob 都能用）。
 */
export async function comfyFetch(
  conn: ComfyTransportConn,
  path: string,
  options: ComfyRequestOptions = {},
): Promise<Response> {
  if (conn.channel === 'relay') return relayFetch(conn, path, options);

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
  '可把「请求通道」改成「服务端转发」并安装 comfy-relay 插件，或给 ComfyUI 加 --enable-cors-header';
