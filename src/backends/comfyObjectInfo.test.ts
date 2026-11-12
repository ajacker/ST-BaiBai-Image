import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearComfyModelListsCache,
  fetchComfyModelLists,
  parseObjectInfo,
} from '@/backends/comfyObjectInfo';

vi.mock('@/st/context', () => ({
  getContext: () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  }),
}));

afterEach(() => {
  clearComfyModelListsCache();
  vi.restoreAllMocks();
});

const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illu.safetensors', 'pony.safetensors']] } } },
  UNETLoader: { input: { required: { unet_name: [['flux1-dev.safetensors', 'anima.safetensors']] } } },
  UnetLoaderGGUF: { input: { required: { unet_name: [['anima-Q4.gguf']] } } },
  VAELoader: { input: { required: { vae_name: [['ae.safetensors', 'qwen_image_vae.safetensors']] } } },
  CLIPLoader: { input: { required: { clip_name: [['qwen_2.5_vl_7b.safetensors', 'clip_l.safetensors']] } } },
  DualCLIPLoader: { input: { required: { clip_name1: [['t5xxl_fp8.safetensors', 'clip_l.safetensors']] } } },
  LoraLoader: { input: { required: { lora_name: [['style.safetensors']] } } },
  KSampler: {
    input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'simple']] } },
  },
};

describe('parseObjectInfo', () => {
  it('摘出各类文件列表;clips 取 CLIPLoader 与 DualCLIPLoader 并集去重', () => {
    const lists = parseObjectInfo(OBJECT_INFO);
    expect(lists.checkpoints).toEqual(['illu.safetensors', 'pony.safetensors']);
    expect(lists.unets).toEqual(['flux1-dev.safetensors', 'anima.safetensors']);
    expect(lists.ggufs).toEqual(['anima-Q4.gguf']);
    expect(lists.vaes).toEqual(['ae.safetensors', 'qwen_image_vae.safetensors']);
    expect(lists.clips).toEqual(['qwen_2.5_vl_7b.safetensors', 'clip_l.safetensors', 't5xxl_fp8.safetensors']);
    expect(lists.loras).toEqual(['style.safetensors']);
    expect(lists.samplers).toEqual(['euler', 'dpmpp_2m']);
    expect(lists.schedulers).toEqual(['normal', 'simple']);
  });

  it('节点未装/形状不符时降级为空数组', () => {
    const lists = parseObjectInfo({ KSampler: { input: { required: {} } }, Broken: 42 });
    expect(lists.checkpoints).toEqual([]);
    expect(lists.ggufs).toEqual([]);
    expect(lists.samplers).toEqual([]);
  });
});

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => '' } as Response;
}

describe('fetchComfyModelLists', () => {
  it('浏览器直连成功 → 全量列表,mode=browser', async () => {
    const fetchMock = vi.fn(async (_input: unknown) => jsonResponse(OBJECT_INFO));
    vi.stubGlobal('fetch', fetchMock);
    const lists = await fetchComfyModelLists('http://127.0.0.1:8188');
    expect(lists.mode).toBe('browser');
    expect(lists.loras).toEqual(['style.safetensors']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8188/object_info');
  });

  it('同 url 命中缓存不重复请求;force 强制重拉', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OBJECT_INFO));
    vi.stubGlobal('fetch', fetchMock);
    await fetchComfyModelLists('http://a:8188');
    await fetchComfyModelLists('http://a:8188');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchComfyModelLists('http://a:8188', { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('网络级失败回退 ST 转发;loras/clips 为空,models 按 UNet:/GGUF: 前缀分类', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/object_info')) throw new TypeError('Failed to fetch');
      // 两条服务端通道都不可用：CORS 代理没开 + comfy-relay 没装
      if (url.startsWith('proxy/')) return new Response('CORS proxy is disabled.', { status: 404 });
      if (url === '/api/plugins/comfy-relay/proxy') return new Response('not found', { status: 404 });
      if (url.endsWith('/api/sd/comfy/models')) {
        return jsonResponse([
          { value: 'illu.safetensors', text: 'illu' },
          { value: 'flux1-dev.safetensors', text: 'UNet: flux1 dev' },
          { value: 'anima-Q4.gguf', text: 'GGUF: anima-Q4' },
        ]);
      }
      if (url.endsWith('/api/sd/comfy/samplers')) return jsonResponse(['euler']);
      if (url.endsWith('/api/sd/comfy/schedulers')) return jsonResponse(['simple']);
      if (url.endsWith('/api/sd/comfy/vaes')) return jsonResponse(['ae.safetensors']);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const lists = await fetchComfyModelLists('http://b:8188');
    expect(lists.mode).toBe('server');
    expect(lists.checkpoints).toEqual(['illu.safetensors']);
    expect(lists.unets).toEqual(['flux1-dev.safetensors']);
    expect(lists.ggufs).toEqual(['anima-Q4.gguf']);
    expect(lists.loras).toEqual([]);
    expect(lists.clips).toEqual([]);
    expect(lists.samplers).toEqual(['euler']);
  });

  it('HTTP 错误是服务端真实反馈,不回退转发', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchComfyModelLists('http://c:8188')).rejects.toThrow('500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('空 url 直接报错', async () => {
    await expect(fetchComfyModelLists('  ')).rejects.toThrow('服务地址');
  });
});
