// ★ 9-25 change: server-bind-host —— 绑定地址解析 + 鉴权范围判定
import { describe, it, expect } from 'vitest';
import { isLoopbackHost, needsAuth, resolveBindHost } from '../src/net.js';

describe('isLoopbackHost', () => {
  it('识别回环形态', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('大小写与空白归一', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('  127.0.0.1  ')).toBe(true);
  });

  it('对外地址不是回环', () => {
    for (const h of ['0.0.0.0', '192.168.1.5', '10.0.0.1', '::', '8.8.8.8']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('以 127. 开头但并非回环的字符串不被误判', () => {
    // 严格点分四段匹配，避免这类前缀欺骗
    for (const h of ['127.0.0.1.evil.com', '127.0.0.1.example', '127.', '127.0.0.1.5']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('空值不算回环', () => {
    for (const h of ['', '   ']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('resolveBindHost', () => {
  it('★ 回归：服务器场景（config 与 env 都无 host）仍是 0.0.0.0 —— 容器靠它做端口映射', () => {
    expect(resolveBindHost(undefined, undefined, false)).toBe('0.0.0.0');
  });

  it('★ 回归：桌面模式默认仍是 127.0.0.1', () => {
    expect(resolveBindHost(undefined, undefined, true)).toBe('127.0.0.1');
  });

  it('config.host 优先于环境变量与模式默认', () => {
    expect(resolveBindHost('192.168.1.5', '127.0.0.1', false)).toBe('192.168.1.5');
    expect(resolveBindHost('0.0.0.0', '127.0.0.1', true)).toBe('0.0.0.0');
  });

  it('环境变量优先于模式默认（本机免鉴权的用法）', () => {
    expect(resolveBindHost(undefined, '127.0.0.1', false)).toBe('127.0.0.1');
  });

  it('空串/空白视同未配置', () => {
    expect(resolveBindHost('', undefined, false)).toBe('0.0.0.0');
    expect(resolveBindHost('   ', '  ', true)).toBe('127.0.0.1');
    expect(resolveBindHost(undefined, '', false)).toBe('0.0.0.0');
  });

  it('★ 部署安全：config 里 host 被插值成空串（服务器没设 ALYSIA_HOST）→ 回落 0.0.0.0', () => {
    // 若有人把 host: "${ALYSIA_HOST}" 写进 config.yml 并部署，
    // 容器里该变量不存在 → 插值成 '' → 这里必须回落到 0.0.0.0，而不是绑回环
    expect(resolveBindHost('', undefined, false)).toBe('0.0.0.0');
  });
});

describe('needsAuth', () => {
  it('回环 → 免鉴权', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) {
      expect(needsAuth(h), h).toBe(false);
    }
  });

  it('对外可达 → 强制鉴权（不提供绕过开关）', () => {
    for (const h of ['0.0.0.0', '192.168.1.5', '10.0.0.1']) {
      expect(needsAuth(h), h).toBe(true);
    }
  });

  it('★ 关键不变量：本地配置下免鉴权，但服务器（无 ALYSIA_HOST）自动恢复鉴权', () => {
    const localHost = resolveBindHost(undefined, '127.0.0.1', false);
    expect(needsAuth(localHost)).toBe(false);

    // 同一份代码在服务器上跑：没有 ALYSIA_HOST → 0.0.0.0 → 必须鉴权
    const serverHost = resolveBindHost(undefined, undefined, false);
    expect(needsAuth(serverHost)).toBe(true);
  });

  it('★ 不存在「对外可达 + 免鉴权」的组合', () => {
    // needsAuth 是 bindHost 的纯函数，任何非回环地址都必然要求鉴权，
    // 因此不可能配出局域网裸奔
    const allHosts = ['0.0.0.0', '192.168.1.5', '10.1.2.3', '8.8.8.8', '::'];
    for (const h of allHosts) {
      expect(isLoopbackHost(h)).toBe(false);
      expect(needsAuth(h)).toBe(true);
    }
  });
});
