/**
 * 通道策略与 generateComfyImage 同口径(见 comfyTransport.ts):
 * - proxy / relay:一次 GET /object_info 由 ST 代发,拿到全量(含 LoRA/CLIP);
 * - 其余:浏览器直连优先;网络级失败后按 auto 规则试 ST 代理、relay 插件、再退 ST 内置转发。
 *
 * ST 内置转发只有 /api/sd/comfy/models|samplers|schedulers|vaes 四个端点(都是服务端
 * 拉 /object_info 再摘字段),**没有 loras/clips 端点**——该通道下这两组降级为空,
 * 表单退化为手输(datalist 无候选),并在状态行说明原因。走 proxy/relay 则没有这个缺陷。
 *
 * 列表有 session 级缓存:object_info 完整响应有几 MB,切换预设/重开面板不该反复拉;
 * 用户加了新模型点「刷新」强制重拉。
 */

import { COMFY_AUTH_NO_RELAY, comfyStatusHint } from '@/backends/comfyAuth';
import { ComfyProxyUnavailable, ComfyUIError, ComfyRelayUnavailable } from '@/backends/comfyErrors';
import { COMFY_DIRECT_UNREACHABLE, comfyFetch } from '@/backends/comfyTransport';
import { getContext } from '@/st/context';
import type { ComfyAuthCreds, ComfyChannel } from '@/state/settings';

export interface ComfyModelLists {
  checkpoints: string[];
  unets: string[];
  ggufs: string[];
  vaes: string[];
  clips: string[];
  loras: string[];
  samplers: string[];
  schedulers: string[];
  /** 实际打通的通道:browser=直连全量;proxy/relay=服务端代发全量;server=ST 内置转发,loras/clips 为空。 */
  mode: 'browser' | 'proxy' | 'relay' | 'server';
  fetchedAt: number;
}

/** 转发通道拿不到列表时的常见候选(datalist 兜底,仍允许手输)。 */
export const FALLBACK_SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'ddim', 'uni_pc'];
export const FALLBACK_SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'beta'];

const SERVER_BASE = '/api/sd/comfy';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

/** object_info 里取某个节点某输入的候选列表;节点未装/形状不符一律空数组(降级优先)。 */
function optionList(info: JsonObject, nodeClass: string, input: string): string[] {
  const node = info[nodeClass];
  if (!isObject(node) || !isObject(node.input) || !isObject(node.input.required)) return [];
  const entry = node.input.required[input];
  if (!Array.isArray(entry)) return [];
  const options = entry[0];
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is string => typeof item === 'string');
}

/** 浏览器直连的全量解析。clips 取 CLIPLoader 与 DualCLIPLoader 的并集(同文件夹,口径可能差一版)。 */
export function parseObjectInfo(info: JsonObject): Omit<ComfyModelLists, 'mode' | 'fetchedAt'> {
  return {
    checkpoints: optionList(info, 'CheckpointLoaderSimple', 'ckpt_name'),
    unets: optionList(info, 'UNETLoader', 'unet_name'),
    ggufs: optionList(info, 'UnetLoaderGGUF', 'unet_name'),
    vaes: optionList(info, 'VAELoader', 'vae_name'),
    clips: [
      ...new Set([
        ...optionList(info, 'CLIPLoader', 'clip_name'),
        ...optionList(info, 'DualCLIPLoader', 'clip_name1'),
      ]),
    ],
    loras: optionList(info, 'LoraLoader', 'lora_name'),
    samplers: optionList(info, 'KSampler', 'sampler_name'),
    schedulers: optionList(info, 'KSampler', 'scheduler'),
  };
}

/**
 * ST 转发 /models 的条目是 {value: 原始文件名, text: 展示名};
 * UNet/GGUF 靠 text 前缀区分("UNet: xxx"/"GGUF: xxx"),其余是 checkpoint。
 */
function classifyServerModels(data: unknown): Pick<ComfyModelLists, 'checkpoints' | 'unets' | 'ggufs'> {
  const result = { checkpoints: [] as string[], unets: [] as string[], ggufs: [] as string[] };
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    if (!isObject(item) || typeof item.value !== 'string') continue;
    const text = typeof item.text === 'string' ? item.text : '';
    if (text.startsWith('UNet: ')) result.unets.push(item.value);
    else if (text.startsWith('GGUF: ')) result.ggufs.push(item.value);
    else result.checkpoints.push(item.value);
  }
  return result;
}

function stringArray(data: unknown): string[] {
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === 'string') : [];
}

async function responseError(response: Response, label: string): Promise<ComfyUIError> {
  const text = (await response.text().catch(() => '')).trim();
  const hint = comfyStatusHint(response.status);
  const detail = [hint, text.slice(0, 300)].filter(Boolean).join('；');
  return new ComfyUIError(`${label} (${response.status})${detail ? `：${detail}` : ''}`, response.status);
}

async function fetchViaBrowser(
  conn: { url: string; auth: ComfyAuthCreds | null },
  signal?: AbortSignal,
): Promise<ComfyModelLists> {
  // channel 留空 = 直连（comfyFetch 只对 'relay' 分流）
  const response = await comfyFetch({ ...conn, channel: 'direct' }, 'object_info', { signal });
  if (!response.ok) throw await responseError(response, '读取 ComfyUI 模型列表失败');
  const info = (await response.json()) as JsonObject;
  if (!isObject(info)) throw new ComfyUIError('ComfyUI 返回的 object_info 格式异常');
  return { ...parseObjectInfo(info), mode: 'browser', fetchedAt: Date.now() };
}

async function fetchViaServer(url: string, signal?: AbortSignal): Promise<ComfyModelLists> {
  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern 上下文不可用');
  const post = async (path: string): Promise<unknown> => {
    const response = await fetch(`${SERVER_BASE}/${path}`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({ url: url.trim() }),
      signal,
    });
    if (!response.ok) throw await responseError(response, 'ST 后端读取 ComfyUI 模型列表失败');
    return response.json();
  };
  const [models, samplers, schedulers, vaes] = await Promise.all([
    post('models'),
    post('samplers'),
    post('schedulers'),
    post('vaes'),
  ]);
  return {
    ...classifyServerModels(models),
    vaes: stringArray(vaes),
    clips: [],
    loras: [],
    samplers: stringArray(samplers),
    schedulers: stringArray(schedulers),
    mode: 'server',
    fetchedAt: Date.now(),
  };
}

/** 服务端通道(proxy/relay):同一份 object_info 由 ST 代发,拿到的是全量(含 LoRA/CLIP)。 */
async function fetchViaServerSide(
  conn: { url: string; auth: ComfyAuthCreds | null },
  channel: 'proxy' | 'relay',
  signal?: AbortSignal,
): Promise<ComfyModelLists> {
  const response = await comfyFetch({ ...conn, channel }, 'object_info', { signal });
  if (!response.ok) throw await responseError(response, '服务端转发读取 ComfyUI 模型列表失败');
  const info = (await response.json()) as JsonObject;
  if (!isObject(info)) throw new ComfyUIError('ComfyUI 返回的 object_info 格式异常');
  return { ...parseObjectInfo(info), mode: channel, fetchedAt: Date.now() };
}

const cache = new Map<string, ComfyModelLists>();

/**
 * 缓存键含凭据与通道:同一地址换账号时列表可能不同(多用户部署),
 * 换通道时能拿到的集合也不同(内置转发没有 LoRA/CLIP)。只存内存、与会话同寿命,不落盘。
 */
function cacheKey(url: string, auth: ComfyAuthCreds | null, channel: ComfyChannel): string {
  return `${channel}\u0000${url.trim()}\u0000${auth?.username ?? ''}\u0000${auth?.password ?? ''}`;
}

/** 拉取列表;同 url+凭据+通道命中缓存直接返回,force 强制重拉(「刷新」按钮)。 */
export async function fetchComfyModelLists(
  url: string,
  options?: {
    force?: boolean;
    signal?: AbortSignal;
    auth?: ComfyAuthCreds | null;
    channel?: ComfyChannel;
  },
): Promise<ComfyModelLists> {
  const key = url.trim();
  if (!key) throw new ComfyUIError('请先填写 ComfyUI 服务地址');
  const auth = options?.auth ?? null;
  const channel = options?.channel ?? 'auto';
  const cacheId = cacheKey(key, auth, channel);
  if (!options?.force && cache.has(cacheId)) return cache.get(cacheId)!;

  const conn = { url: key, auth };
  let lists: ComfyModelLists;
  if (channel === 'proxy' || channel === 'relay') {
    lists = await fetchViaServerSide(conn, channel, options?.signal);
  } else {
    try {
      lists = await fetchViaBrowser(conn, options?.signal);
    } catch (error) {
      // 与出图同口径:仅网络级失败换通道;HTTP 错误是服务端真实反馈,换条路结果一样
      if (!isNetworkError(error)) throw error;
      lists = await fallbackLists(conn, channel, options?.signal);
    }
  }
  cache.set(cacheId, lists);
  return lists;
}

/** auto 的换通道顺序:直连不通 → ST 代理(零安装) → relay 插件 → ST 内置转发(无认证能力)。 */
async function fallbackLists(
  conn: { url: string; auth: ComfyAuthCreds | null },
  channel: ComfyChannel,
  signal?: AbortSignal,
): Promise<ComfyModelLists> {
  if (channel === 'direct') throw new ComfyUIError(COMFY_DIRECT_UNREACHABLE);
  for (const next of ['proxy', 'relay'] as const) {
    try {
      return await fetchViaServerSide(conn, next, signal);
    } catch (error) {
      if (!(error instanceof ComfyRelayUnavailable) && !(error instanceof ComfyProxyUnavailable)) throw error;
    }
  }
  // 内置转发端点不带认证头,启用认证时只能走前面几条路
  if (conn.auth) throw new ComfyUIError(COMFY_AUTH_NO_RELAY);
  return fetchViaServer(conn.url, signal);
}

/** 测试用:清空缓存。 */
export function clearComfyModelListsCache(): void {
  cache.clear();
}
