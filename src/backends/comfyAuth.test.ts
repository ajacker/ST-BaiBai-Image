import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMFY_AUTH_NO_RELAY, comfyAuthHeaders, comfyStatusHint } from '@/backends/comfyAuth';
import { clearComfyModelListsCache, fetchComfyModelLists } from '@/backends/comfyObjectInfo';
import { COMFY_RELAY_MISSING } from '@/backends/comfyTransport';
import { generateComfyImage, testComfyConnection } from '@/backends/comfyui';

vi.mock('@/st/context', () => ({
  getContext: () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }),
  }),
}));

afterEach(() => {
  clearComfyModelListsCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TEMPLATE = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { text: '%prompt%' } } });
const AUTH = { username: 'user', password: 'pass' };
const RELAY_PATH = '/api/plugins/comfy-relay/proxy';

type ConnOverrides = Partial<{ auth: { username: string; password: string } | null; channel: 'auto' | 'direct' | 'relay' }>;

function connWith(overrides: ConnOverrides = {}) {
  return {
    url: 'http://comfy.local:8188',
    auth: null,
    channel: 'auto',
    workflow: TEMPLATE,
    mode: 'custom',
    simple: {},
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    ...overrides,
  } as unknown as Parameters<typeof generateComfyImage>[0];
}

function decodeBasic(header: string): string {
  const bytes = Uint8Array.from(atob(header.replace(/^Basic /, '')), ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 未安装 comfy-relay 时 ST 的真实回应：404 且不带 x-comfy-relay-status。 */
function relayMissingResponse(): Response {
  return new Response('<html>Cannot POST /api/plugins/comfy-relay/proxy</html>', { status: 404 });
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

describe('直连通道', () => {
  function stubSuccess() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const json = (data: unknown) => new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
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
        if (url.includes('/view')) return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
        return json({});
      }),
    );
    return calls;
  }

  it('排队/轮询/取图每个请求都带 Authorization(漏一个就是连得上但出不了图)', async () => {
    const calls = stubSuccess();
    const result = await generateComfyImage(connWith({ auth: AUTH, channel: 'direct' }), { prompt: '1girl', seed: 1 });

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
    const result = await generateComfyImage(connWith({ channel: 'direct' }), { prompt: '1girl', seed: 1 });
    expect(calls.every(c => !('Authorization' in c.headers))).toBe(true);
    result.revoke();
  });

  it('仅直连 + 网络失败 → 明确报错,不换通道(不重复生图)', async () => {
    const fetchMock = vi.fn(async (_input?: unknown, _init?: { headers?: Record<string, string> }) => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateComfyImage(connWith({ auth: AUTH, channel: 'direct' }), { prompt: '1girl', seed: 1 })).rejects.toThrow(
      '浏览器直连 ComfyUI 失败',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://comfy.local:8188/prompt');
  });

  it('testComfyConnection 同样带认证头', async () => {
    const okFetch = vi.fn(async (_input?: unknown, _init?: { headers?: Record<string, string> }) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', okFetch);
    await expect(testComfyConnection(connWith({ auth: AUTH, channel: 'direct' }))).resolves.toEqual({ mode: 'browser' });
    expect((okFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Basic dXNlcjpwYXNz',
    );
  });
});

describe('服务端转发通道（comfy-relay）', () => {
  function stubRelay() {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const json = (data: unknown) => new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-comfy-relay-status': '200' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body, headers: init?.headers ?? {} });
        if (body?.path === 'prompt') return json({ prompt_id: 'pid-1' });
        if (body?.path === 'system_stats') return json({ system: {} });
        if (String(body?.path).startsWith('history/')) {
          return json({
            'pid-1': {
              status: { completed: true },
              outputs: { '8': { images: [{ filename: 'a.png', type: 'output' }] } },
            },
          });
        }
        if (String(body?.path).startsWith('view?')) {
          return new Response(new Blob(['png'], { type: 'image/png' }), {
            status: 200,
            headers: { 'x-comfy-relay-status': '200' },
          });
        }
        return json({});
      }),
    );
    return calls;
  }

  it('全程打 ST 插件路由,浏览器不直连 ComfyUI;认证交给服务端拼', async () => {
    const calls = stubRelay();
    const result = await generateComfyImage(connWith({ auth: AUTH, channel: 'relay' }), { prompt: '1girl', seed: 1 });

    expect(calls.every(c => c.url === RELAY_PATH)).toBe(true);
    const queue = calls.find(c => c.body?.path === 'prompt');
    expect(queue?.body).toEqual({
      base: 'http://comfy.local:8188',
      path: 'prompt',
      method: 'POST',
      body: { prompt: expect.any(Object) },
      auth: AUTH,
    });
    // 浏览器只带 ST 自己的头（含 CSRF），不发 ComfyUI 的 Authorization
    expect(queue?.headers['X-CSRF-Token']).toBe('csrf');
    expect(queue?.headers.Authorization).toBeUndefined();
    result.revoke();
  });

  it('插件没装（404 且无 relay 状态头）→ 提示安装,而不是当成 ComfyUI 报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => relayMissingResponse()));
    await expect(
      generateComfyImage(connWith({ auth: AUTH, channel: 'relay' }), { prompt: '1girl', seed: 1 }),
    ).rejects.toThrow(COMFY_RELAY_MISSING);
  });

  it('testComfyConnection 走 relay 时返回 mode=relay', async () => {
    stubRelay();
    await expect(testComfyConnection(connWith({ channel: 'relay' }))).resolves.toEqual({ mode: 'relay' });
  });

  it('模型列表走 relay 时拿到全量（LoRA/CLIP 不再缺失）', async () => {
    const objectInfo = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['illu.safetensors']] } } },
      LoraLoader: { input: { required: { lora_name: [['style.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['clip_l.safetensors']] } } },
    };
    const calls: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: string }) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(objectInfo), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-comfy-relay-status': '200' },
        });
      }),
    );

    const lists = await fetchComfyModelLists('http://comfy.local:8188', { channel: 'relay' });
    expect(lists.mode).toBe('relay');
    expect(lists.loras).toEqual(['style.safetensors']);
    expect(lists.clips).toEqual(['clip_l.safetensors']);
    expect(calls[0].path).toBe('object_info');
  });
});

describe('auto 通道的换通道顺序', () => {
  it('直连网络失败 → 自动用上 relay 插件（装了插件即生效,无需改配置）', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { body?: string }) => {
        const url = String(input);
        seen.push(url);
        if (url === RELAY_PATH) {
          const body = JSON.parse(String(init?.body));
          if (body.path === 'prompt') {
            return new Response(JSON.stringify({ prompt_id: 'pid-1' }), {
              status: 200,
              headers: { 'x-comfy-relay-status': '200' },
            });
          }
          if (body.path === 'system_stats') {
            return new Response('{}', { status: 200, headers: { 'x-comfy-relay-status': '200' } });
          }
          if (String(body.path).startsWith('history/')) {
            return new Response(
              JSON.stringify({
                'pid-1': { status: { completed: true }, outputs: { '8': { images: [{ filename: 'a.png' }] } } },
              }),
              { status: 200, headers: { 'x-comfy-relay-status': '200' } },
            );
          }
          return new Response(new Blob(['png']), { status: 200, headers: { 'x-comfy-relay-status': '200' } });
        }
        throw new TypeError('Failed to fetch');
      }),
    );

    const result = await generateComfyImage(connWith({ auth: AUTH, channel: 'auto' }), { prompt: '1girl', seed: 1 });
    expect(result.filename).toBe('a.png');
    expect(seen[0]).toBe('http://comfy.local:8188/prompt'); // 先直连
    expect(seen[1]).toBe(RELAY_PATH); // 失败后走插件
    result.revoke();
  });

  it('插件没装且启用认证 → 报「内置转发不带认证」的原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input) === RELAY_PATH) return relayMissingResponse();
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(
      generateComfyImage(connWith({ auth: AUTH, channel: 'auto' }), { prompt: '1girl', seed: 1 }),
    ).rejects.toThrow(COMFY_AUTH_NO_RELAY);
  });

  it('插件没装且未启用认证 → 回退 ST 内置转发（改造前行为不变）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === RELAY_PATH) return relayMissingResponse();
        if (url.endsWith('/api/sd/comfy/generate')) {
          return new Response(JSON.stringify({ format: 'png', data: 'AAAA' }), { status: 200 });
        }
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await generateComfyImage(connWith({ channel: 'auto' }), { prompt: '1girl', seed: 1 });
    expect(result.url.startsWith('data:image/png;base64,')).toBe(true);
  });
});
