/**
 * ComfyUI 相关错误类型。
 *
 * 单独成模块是为了打断循环依赖：comfyui.ts 要用 transport，transport 又要抛 ComfyUIError。
 * comfyui.ts 仍对外 re-export 这两个类，既有 import 路径不受影响。
 */

export class ComfyUIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ComfyUIError';
  }
}

/**
 * comfy-relay 服务端插件不可用（没装 / 没开 enableServerPlugins / 路由 404）。
 *
 * 与「上游 ComfyUI 报错」严格区分：前者可以安全地回退到别的通道，
 * 后者是服务端真实反馈，重试没有意义，更不能重发一次生图请求。
 */
export class ComfyRelayUnavailable extends ComfyUIError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ComfyRelayUnavailable';
  }
}

/**
 * ST 自带的 CORS 代理没开（config.yaml 的 enableCorsProxy: false，自带路由回 404）。
 * 同样是「通道不可用」，可以安全回退。
 */
export class ComfyProxyUnavailable extends ComfyUIError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ComfyProxyUnavailable';
  }
}
