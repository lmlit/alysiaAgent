/**
 * 监听地址与鉴权范围判定 —— 纯函数，独立于 bootstrap（后者 import 即启动服务器，不可测）
 * ★ 9-25 change: server-bind-host
 */

/** 是否是回环地址（只有本机能连） */
export function isLoopbackHost(host: string): boolean {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  // 127.0.0.0/8 整段都是回环。用严格点分四段匹配——
  // 避免 `127.0.0.1.evil.com` 这类以 127. 开头但并非回环的字符串被误判
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 解析实际绑定地址。
 * 优先级：`config.host` > `ALYSIA_HOST` 环境变量 > 模式默认（桌面 127.0.0.1 / 服务 0.0.0.0）
 *
 * ★ 默认值必须与改动前逐字节一致：线上容器绑 0.0.0.0 才做得了端口映射，
 *   改成默认回环会让部署直接失联。
 *
 * ★ 为什么同时支持环境变量：部署 SOP 会把 `packages/server/config.yml` **打包传到服务器**
 *   （`tar czf alysia-deploy.tar.gz compose.yml config.yml`）。若把本机专用的
 *   `host: "127.0.0.1"` 写进那个文件，部署后容器会绑回环、`6186:6185` 端口映射失效。
 *   走 `.env` 则天然安全：`.env` 不进部署包，且 compose 的 `environment:` 是白名单，
 *   没列 `ALYSIA_HOST` → 容器里该变量不存在 → 回落默认 0.0.0.0。
 */
export function resolveBindHost(
  configHost: string | undefined,
  envHost: string | undefined,
  isDesktop: boolean,
): string {
  const fromConfig = String(configHost ?? '').trim();
  if (fromConfig) return fromConfig;
  const fromEnv = String(envHost ?? '').trim();
  if (fromEnv) return fromEnv;
  return isDesktop ? '127.0.0.1' : '0.0.0.0';
}

/**
 * 是否需要鉴权。
 *
 * ★ 绑定回环 ⇒ 只有本机可达 ⇒ 免鉴权（与既有 `IS_DESKTOP` 分支语义一致，此处泛化）；
 *   对外可达 ⇒ 强制鉴权。
 *
 * 刻意**不提供**独立的 requireAuth 开关：两个开关能配出
 * `0.0.0.0` + 免鉴权 = 局域网裸奔。让绑定地址做唯一事实来源，
 * 「对外可达 ⇒ 必须鉴权」成为不可绕过的推论。
 */
export function needsAuth(bindHost: string): boolean {
  return !isLoopbackHost(bindHost);
}
