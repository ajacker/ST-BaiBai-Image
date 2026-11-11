# comfy-relay（SillyTavern 服务端插件）

给「柏宝绘」插件的**服务端转发**通道提供 ST 服务端代发的 ComfyUI 请求。

## 解决什么

浏览器直连 ComfyUI 时，只要请求带 `Authorization`（Basic 认证），就必然触发 CORS 预检；而预检按规范**不带凭据**，于是被认证层 401 掉、且 401 上没有 CORS 头，浏览器直接报：

```
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

这个插件把请求搬到 ST 服务端发出：浏览器只访问同源的 `/api/plugins/comfy-relay/proxy`（无预检），认证头由服务端拼。因此**不需要改 nginx、不需要给 ComfyUI 开跨域、也不受混合内容限制**。

为什么不用 ST 自带的 `/api/sd/comfy/*`：那组端点（`src/endpoints/stable-diffusion.js`）是裸 `fetch(url)`，不带也不透传认证头（同文件的 webui 端点倒是有 `getBasicAuthHeader(request.body.auth)`），对有认证的 ComfyUI 无解。

## 安装

1. 把整个 `comfy-relay` 目录拷到 `SillyTavern/plugins/comfy-relay/`
   ```
   SillyTavern/
     plugins/
       comfy-relay/
         index.js
         config.json      (可选，见下)
   ```
2. `SillyTavern/config.yaml` 里打开服务端插件：
   ```yaml
   enableServerPlugins: true
   ```
3. 重启 SillyTavern。控制台应出现：
   ```
   Initializing plugin from .../plugins/comfy-relay/index.js
   [comfy-relay] 路由已注册：POST /api/plugins/comfy-relay/proxy
   ```
4. 「柏宝绘」→ 渠道 → ComfyUI → **请求通道**选「服务端转发」（或「自动」，直连失败时会自动用上它）。

## 可选配置 `config.json`

```json
{
  "allowedOrigins": ["https://comfyui.example.com"],
  "timeoutMs": 600000
}
```

- `allowedOrigins`：允许转发的目标源白名单。留空/不写 = 不限制（插件路由本身在 ST 登录态之后，非登录用户调不到）。
- `timeoutMs`：单次上游请求超时（毫秒）。ComfyUI 排队很久时建议 ≥ 600000，或不写。

## 路由契约

`POST /api/plugins/comfy-relay/proxy`

```json
{
  "base": "https://comfyui.example.com",
  "path": "/system_stats",
  "method": "GET",
  "body": { },
  "auth": { "username": "u", "password": "p" }
}
```

- `path` 必须 `/` 开头，且解析后不得跨源（`//evil.com/x` 会被拒）；
- `method` 仅 `GET` / `POST`；
- 上游响应原样回传（含二进制），状态码保持一致，并附 `x-comfy-relay-status`；
- 插件自身失败回 `4xx/502 + {error}`，不带上述头——客户端据此判定「插件没装/参数错」。

## 排障

| 现象 | 原因 |
|---|---|
| 插件面板提示「未检测到 comfy-relay 服务端插件」 | 目录不在 `plugins/` 下，或 `enableServerPlugins` 没开，或没重启 |
| `403 源不在白名单` | `config.json` 的 `allowedOrigins` 与面板里 URL 的 scheme/host/port 不完全一致 |
| `502 ...` | ST 服务器到 ComfyUI 网络不通（用 ST 服务器自己 `curl ` 一下） |
| 上游 `401` | 面板里的用户名/密码不对（这个 401 是 ComfyUI/反代回的，会带 `x-comfy-relay-status`） |
