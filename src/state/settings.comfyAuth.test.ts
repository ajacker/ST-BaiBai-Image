import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ComfyUI 渠道级 Basic 认证的配置清洗。
 *
 * 要点:
 * 1. 存量配置没有 auth 字段 → 默认关闭,绝不能凭空发出认证头;
 * 2. 只有 enabled 且用户名非空才真的发凭据(空用户名发出去只会得到 401,更难排查);
 * 3. 密码只做形状清洗、不 trim——裁剪等于改用户密码。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithComfy(comfyui: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: comfyui === undefined ? {} : { comfyui } },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

describe('ComfyUI Basic 认证配置', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('存量配置没有 auth 字段 → 默认关闭、空凭据,effectiveComfyConn 不发认证', async () => {
    const { settings, effectiveComfyConn } = await hydrateWithComfy({ url: 'http://comfy.local:8188' });
    expect(settings.comfyui.auth).toEqual({ enabled: false, username: '', password: '' });
    expect(effectiveComfyConn().auth).toBeNull();
  });

  it('启用并填了用户名 → 凭据透出;用户名两侧空白被裁剪,密码原样保留', async () => {
    const { settings, effectiveComfyConn } = await hydrateWithComfy({
      url: 'http://comfy.local:8188',
      auth: { enabled: true, username: '  user  ', password: ' pa ss ' },
    });
    expect(settings.comfyui.auth.password).toBe(' pa ss ');
    expect(effectiveComfyConn().auth).toEqual({ username: 'user', password: ' pa ss ' });
  });

  it('勾了开关但用户名是空白 → 视同没配,不发认证头', async () => {
    const { effectiveComfyConn } = await hydrateWithComfy({
      url: 'http://comfy.local:8188',
      auth: { enabled: true, username: '   ', password: 'x' },
    });
    expect(effectiveComfyConn().auth).toBeNull();
  });

  it('开关是脏值(字符串/缺失)一律按关闭处理,凭据字段非字符串归空串', async () => {
    const { settings, effectiveComfyConn } = await hydrateWithComfy({
      url: 'http://comfy.local:8188',
      auth: { enabled: 'yes', username: 42, password: null },
    });
    expect(settings.comfyui.auth).toEqual({ enabled: false, username: '', password: '' });
    expect(effectiveComfyConn().auth).toBeNull();
  });
});
