/**
 * ComfyUI Basic 认证的公共实现。
 *
 * ComfyUI 本体没有内建口令,实际部署里认证通常来自反代的 auth_basic(nginx/Caddy)
 * 或 `--basic-auth` 一类的前置代理。它们的共同点是标准 HTTP Basic:
 * `Authorization: Basic base64(username:password)`,每个请求都要带——包括
 * /view 取图和 /object_info 拉列表,漏一个就是「连得上但出不了图」。
 *
 * base64 必须走 utf8ToBase64:用户名/密码里出现非 ASCII 字符时 btoa 会直接抛错。
 *
 * 另有一条结构性限制:ST 后端的 /api/sd/comfy/* 转发端点只接受 url(见
 * SillyTavern src/endpoints/stable-diffusion.js),既不带也不透传认证头。
 * 因此开启认证后转发通道不可用,由各调用点显式提示,而不是让用户收到一个
 * 莫名其妙的 401。
 */

import { utf8ToBase64 } from '@/base64';
import type { ComfyAuthCreds } from '@/state/settings';

/** 认证头;未配置凭据时返回空对象(fetch 不做特殊处理,等价于不带认证)。 */
export function comfyAuthHeaders(auth?: ComfyAuthCreds | null): Record<string, string> {
  const username = auth?.username.trim();
  if (!username) return {};
  return { Authorization: `Basic ${utf8ToBase64(`${username}:${auth?.password ?? ''}`)}` };
}

/** 启用认证后转发通道不可用时的说明(两条通道都会用到同一句话,保持一致)。 */
export const COMFY_AUTH_NO_RELAY =
  '已启用 Basic 认证：ST 后端转发端点不带认证头，无法代为请求；请给 ComfyUI 加 --enable-cors-header 让浏览器直连';

/** 按 HTTP 状态给一句人话提示;401 是最常见也最容易被误读成「地址错」的一种。 */
export function comfyStatusHint(status: number): string {
  if (status === 401) return '认证失败：请检查 Basic 认证的用户名/密码';
  if (status === 403) return '服务器拒绝访问：认证通过但该账号无权调用此接口';
  return '';
}
