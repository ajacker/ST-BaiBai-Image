import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMFY_AUTH_NO_RELAY, comfyAuthHeaders, comfyStatusHint } from '@/backends/comfyAuth';
import { clearComfyModelListsCache, fetchComfyModelLists } from '@/backends/comfyObjectInfo';
import { generateComfyImage, testComfyConnection } from '@/backends/comfyui';

vi.mock('@/st/context', () => ({
  getContext: () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  }),
}));

afterEach(() => {
  clearComfyModelListsCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TEMPLATE = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { text: '%prompt%' } } });

const AUTH = { username: 'user', password: 'pass' };

function connWith(auth: { username: string; password: string } | null) {
  return {
    url: 'http://comfy.local:8188',
    auth,
    workflow: TEMPLATE,
    mode: 'custom',
    simple: {},
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
  } as unknown as Parameters<typeof generateComfyImage>[0];
}

function decodeBasic(header: string): string {
  const bytes = Uint8Array.from(atob(header.replace(/^Basic /, '')), ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe('comfyAuthHeaders', () => {
  it('未配置凭据时不发认证头', () => {
    expect(comfyAuthHeaders(null)).toEqual({});
    expect(comfyAuthHeaders(undefined)).toEqual({});
    expect(comfyAuthHeaders({ username: '  ', password: 'x' })).toEqual({});
  });

  it('按 HTTP Basic 规范编码 username:password', () => {
    expect(comfyAuthHeaders(AUTH)).toEqual({ Authorization: 'Basic dXNlcjpwYXNz' });
  });

  it('非 ASCII 凭据走 UTF-8(直接 btoa 会抛 InvalidCharacterError)', () => {
    const header = comfyAuthHeaders({ username: '酒馆', password: '秘密' }).Authorization;
    expect(decodeBasic(header)).toBe('酒馆:秘密');
  });

  it('空密码仍发认证头(Basic 允许空密码,只有用户名空才算没配)', () => {
    expect(comfyAuthHeaders({ username: 'user', password: '' }).Authorization).toBe('Basic dXNlcjo=');
  });
});

describe('comfyStatusHint', () => {
  it('401/403 给可读原因,其余不回话', () => {
    expect(comfyStatusHint(401)).toContain('用户名/密码');
    expect(comfyStatusHint(403)).toContain('无权');
    expect(comfyStatusHint(500)).toBe('');
  });
});

describe('出图请求带认证头', () => {
  function stubSuccess() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = String(input);
        calls.push({ url, headers: init?.headers ?? {} });
        if (url.endsWith('/prompt')) return json({ prompt_id: 'pid-1' });
        if (url.endsWith('/system_stats')) return json({ system: {} });
        if (url.includes('/history/')) {
          return json({
            'pid-1': {
              status: { completed: true },
              outputs: { '8': { images: [{ filename: 'a.png', type: 'output' }] } },
            },
          });
        }
        if (url.includes('/view')) {
          return { ok: true, status: 200, blob: async () => new Blob(['png'], { type: 'image/png' }) };
        }
        return json({});
      }),
    );
    return calls;
  }

  it('排队/轮询/取图每个请求都带 Authorization(漏一个就是连得上但出不了图)', async () => {
    const calls = stubSuccess();
    const result = await generateComfyImage(connWith(AUTH), { prompt: '1girl', seed: 1 });

    const paths = calls.map(c => c.url);
    expect(paths.some(p => p.endsWith('/prompt'))).toBe(true);
    expect(paths.some(p => p.includes('/history/'))).toBe(true);
    expect(paths.some(p => p.includes('/view'))).toBe(true);
    for (const call of calls) {
      expect(call.headers.Authorization).toBe('Basic dXNlcjpwYXNz');
    }
    // POST 的 Content-Type 不能被认证头挤掉
    expect(calls.find(c => c.url.endsWith('/prompt'))?.headers['Content-Type']).toBe('application/json');
    result.revoke();
  });

  it('未启用认证时不带 Authorization', async () => {
    const calls = stubSuccess();
    const result = await generateComfyImage(connWith(null), { prompt: '1girl', seed: 1 });
    expect(calls.every(c => !('Authorization' in c.headers))).toBe(true);
    result.revoke();
  });

  it('直连网络失败且已启用认证 → 明确报错,不转发(转发不带认证头,只会 401)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateComfyImage(connWith(AUTH), { prompt: '1girl', seed: 1 })).rejects.toThrow(COMFY_AUTH_NO_RELAY);
    // 只有直连那一次尝试,没有后续的 /api/sd/comfy 转发
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://comfy.local:8188/prompt');
  });

  it('testComfyConnection 同样带认证头,且认证下不回退转发', async () => {
    const okFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', okFetch);
    await expect(testComfyConnection(connWith(AUTH))).resolves.toEqual({ mode: 'browser' });
    expect((okFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Basic dXNlcjpwYXNz',
    );

    const failFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', failFetch);
    await expect(testComfyConnection(connWith(AUTH))).rejects.toThrow(COMFY_AUTH_NO_RELAY);
    expect(failFetch).toHaveBeenCalledTimes(1);
  });
});

describe('模型列表请求带认证头', () => {
  const OBJECT_INFO = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illu.safetensors']] } } } };

  it('object_info 走直连带认证;缓存按凭据区分', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        calls.push({ url: String(input), headers: init?.headers ?? {} });
        return { ok: true, status: 200, json: async () => OBJECT_INFO, text: async () => '' };
      }),
    );

    await fetchComfyModelLists('http://comfy.local:8188', { auth: AUTH });
    await fetchComfyModelLists('http://comfy.local:8188', { auth: AUTH });
    // 同凭据命中缓存
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Basic dXNlcjpwYXNz');

    // 换凭据不命中旧缓存(多用户部署的模型列表可能不同)
    await fetchComfyModelLists('http://comfy.local:8188', { auth: { username: 'other', password: 'x' } });
    expect(calls).toHaveLength(2);
  });

  it('已启用认证时网络失败直接报错,不回退转发', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchComfyModelLists('http://comfy.local:8188', { auth: AUTH })).rejects.toThrow(COMFY_AUTH_NO_RELAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
