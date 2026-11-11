/**
 * comfy-relay —— SillyTavern 服务端插件
 *
 * 用途：给「柏宝绘」插件的「服务端转发」通道提供一条 ST 服务端代发的 ComfyUI 请求路径。
 * 浏览器不参与请求，所以不受 CORS、预检、混合内容任何限制，也能携带 Basic 认证。
 *
 * 为什么不复用 ST 自带的 /api/sd/comfy/*：那组端点（src/endpoints/stable-diffusion.js）
 * 是裸 fetch(url)，既不带也不透传认证头（同文件的 webui 端点倒是有 auth），
 * 因此对「有认证的 ComfyUI」无解。这个插件把缺的那一段补上，且不进 ST 源码。
 *
 * 安装：
 *   1. 把整个 comfy-relay 目录拷到 SillyTavern/plugins/comfy-relay/
 *   2. SillyTavern/config.yaml 里设 enableServerPlugins: true
 *   3. 重启 SillyTavern（控制台应出现 Initializing plugin from .../comfy-relay/index.js）
 *   4. 插件面板「请求通道」选「服务端转发」或「自动」
 *
 * 可选配置：同目录放 config.json
 *   {
 *     "allowedOrigins": ["https://comfyui.example.com"],  // 留空 = 不限制
 *     "timeoutMs": 600000
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const info = {
  id: 'comfy-relay',
  name: 'ComfyUI Relay',
  description: '为柏宝绘插件转发 ComfyUI 请求（可携带 Basic 认证），绕开浏览器跨域限制',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(here, 'config.json');
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST']);

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // 没有配置文件是正常状态（开箱即用）：允许任意 base，不设超时
    return {};
  }
}

/** 兼容两种情形：ST 已挂 body parser（req.body 可用），或没有（自己读流）。 */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf8');
    return text ? JSON.parse(text) : {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function basicAuthHeader(auth) {
  if (!auth || typeof auth.username !== 'string' || !auth.username) return null;
  const password = typeof auth.password === 'string' ? auth.password : '';
  return `Basic ${Buffer.from(`${auth.username}:${password}`, 'utf8').toString('base64')}`;
}

export async function init(router) {
  router.post('/proxy', async (request, response) => {
    try {
      const config = loadConfig();
      const payload = await readJsonBody(request);
      const { base, path: upstreamPath, method = 'GET', body, auth } = payload ?? {};

      if (typeof base !== 'string' || typeof upstreamPath !== 'string' || !upstreamPath.startsWith('/')) {
        return response.status(400).json({ error: 'base 必须为字符串，path 必须以 / 开头' });
      }
      if (!ALLOWED_METHODS.has(method)) {
        return response.status(400).json({ error: `method 仅支持 GET/POST，收到 ${String(method)}` });
      }

      let origin;
      let target;
      try {
        origin = new URL(base).origin;
        // 以 origin 为基准解析相对 path：'//evil.com/x' 之类的跨源写法会在下面被拒
        target = new URL(upstreamPath, `${origin}/`);
      } catch {
        return response.status(400).json({ error: 'base 不是合法 URL' });
      }
      if (target.origin !== origin) {
        return response.status(400).json({ error: 'path 不得指向其他源' });
      }

      const allowed = Array.isArray(config.allowedOrigins)
        ? config.allowedOrigins.filter(item => typeof item === 'string')
        : [];
      if (allowed.length && !allowed.includes(origin)) {
        return response.status(403).json({ error: `源不在 comfy-relay 白名单：${origin}` });
      }

      const headers = {};
      const hasBody = body !== undefined && body !== null;
      if (hasBody) headers['Content-Type'] = 'application/json';
      const authorization = basicAuthHeader(auth);
      if (authorization) headers.Authorization = authorization;

      const timeoutMs = Number(config.timeoutMs);
      const upstream = await fetch(target, {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });

      // 上游状态码原样回传，并用自定义头标明「这是上游的回应」——
      // 插件自身的失败走 4xx/502 且不带这个头，客户端据此区分，避免把 404（没装插件）
      // 和 ComfyUI 的 404 混为一谈。
      response.status(upstream.status);
      response.setHeader('x-comfy-relay-status', String(upstream.status));
      const contentType = upstream.headers.get('content-type');
      if (contentType) response.setHeader('content-type', contentType);
      response.setHeader('cache-control', 'no-store');
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[comfy-relay]', message);
      if (!response.headersSent) response.status(502).json({ error: message.slice(0, 500) });
      else response.end();
    }
  });

  console.log('[comfy-relay] 路由已注册：POST /api/plugins/comfy-relay/proxy');
}
