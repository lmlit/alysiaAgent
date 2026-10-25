/**
 * 回滚点保留策略（★ 2026-10-25，起因：部署脚本只打 `rollback-*` 标签、从不删）
 *
 * 事实（2026-10-25 实测生产）：37 个镜像 8.736 GB，其中可用只剩 **一个**
 * `server-alysia:latest`；一天内 12 次部署 ⇒ 12 个回滚点 + 9 个悬空 `<none>`，
 * `/` 从 40G 用到 23G。**按天算不心疼，按周算就是把磁盘填满**，
 * 而填满的那一刻报的错是「数据库写入失败」—— 与部署毫无字面关系。
 *
 * 本模块只做**纯决策**（可单测、不碰 docker/ssh）：
 *   `docker images` 的文本 → 保留哪些 / 删哪些 → 一段可执行的 bash。
 *
 * 安全边界（写死在代码里，不靠调用方自觉）：
 *   ① 只认 `server-alysia:rollback-*` 这个前缀，**`latest` 永远进不了待删集合**；
 *   ② 排序用 **docker 的 CreatedAt**，不用标签名 —— 生产上真有过
 *      `rollback-20261017`（无时分秒）、`rollback-20261021-preimage`（非时间后缀），
 *      按名字解析会静默排错顺序；
 *   ③ 悬空镜像清理**带 label 过滤**（compose 会给每个镜像打 project 标签），
 *      避免在共用宿主机上误删别人的 `<none>`；过滤不被支持时**宁可不删**。
 */

export const IMAGE = 'server-alysia:latest';
export const ROLLBACK_PREFIX = 'server-alysia:rollback-';
export const DEFAULT_KEEP = 3;
/** 只允许这种形状的标签进入 `docker rmi`（防注入 / 防误删 latest） */
export const ROLLBACK_TAG_RE = /^server-alysia:rollback-[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 我们用 `docker compose build` 构建 ⇒ 镜像都带这个 project 标签 */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project=server';

/** `docker images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}|{{.ID}}'` 的输出 → 记录 */
export function parseImageList(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [createdAt = '', tag = '', id = ''] = line.split('|');
      return { createdAt: createdAt.trim(), tag: tag.trim(), id: id.trim() };
    })
    .filter((e) => e.tag);
}

const cmpDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * 决定保留/删除。
 * @param {{createdAt:string, tag:string, id:string}[]} entries
 * @param {number} keep 保留多少个最近的回滚点（0 = 全删，仅留 latest）
 * @returns {{keep:object[], remove:object[], ignored:object[], keepCount:number}}
 */
export function planRollbackPrune(entries, keep = DEFAULT_KEEP) {
  const list = Array.isArray(entries) ? entries : [];
  // ⚠️ 负数**退回默认**而不是钳到 0：`-1` 是手滑，不是「只留 latest」的意图，
  //    钳成 0 就等于一次手滑把全部回滚点删光。0 只能**显式**传。
  const raw = keep === undefined || keep === null ? NaN : Number(keep);
  const keepCount = Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_KEEP;

  const rollbacks = list.filter((e) => e && ROLLBACK_TAG_RE.test(e.tag));
  const ignored = list.filter((e) => !(e && ROLLBACK_TAG_RE.test(e.tag)));

  // 新 → 旧。同 CreatedAt（同一镜像被打多个标签）时用标签名兜底，保证**确定性**：
  // 同样的输入必须给出同样的结果，否则「重复部署会越删越多」这类问题没法复现。
  const sorted = [...rollbacks].sort(
    (a, b) => cmpDesc(a.createdAt || '', b.createdAt || '') || cmpDesc(a.tag, b.tag) || cmpDesc(a.id || '', b.id || ''),
  );

  return {
    keep: sorted.slice(0, keepCount),
    remove: sorted.slice(keepCount),
    ignored,
    keepCount,
  };
}

/**
 * 生成在服务器上执行的清理脚本。
 * 顺序：先删过期标签 → 再清悬空（带 label 过滤）→ 最后把现状打出来当验收依据。
 */
export function buildPruneScript(
  removeTags,
  { labelFilter = COMPOSE_PROJECT_LABEL, image = IMAGE, healthUrl = 'http://localhost:6186/api/health' } = {},
) {
  const tags = (Array.isArray(removeTags) ? removeTags : [])
    .filter((t) => typeof t === 'string' && ROLLBACK_TAG_RE.test(t));

  const lines = ['set -u'];
  if (tags.length) {
    lines.push(`docker rmi ${tags.join(' ')} >/dev/null 2>&1 || true`);
    lines.push(`echo "removed=${tags.length}"`);
  } else {
    lines.push('echo "removed=0"');
  }
  if (labelFilter) {
    lines.push(
      `if docker image prune -f --filter 'label=${labelFilter}' >/dev/null 2>&1; then echo "dangling=pruned"; else echo "dangling=skipped"; fi`,
    );
  }
  lines.push(`docker images --format '{{.Repository}}:{{.Tag}}|{{.Size}}' | grep -c . | sed 's/^/image-count=/'`);
  lines.push(
    `docker system df | awk 'NR==2{print "images-df=" $2 " 个 / " $4 " 总量 / " $5 " 可回收"}'`,
  );
  lines.push(`df -h / | awk 'NR==2{print "disk=" $3 "/" $2 " used (" $5 ")"}'`);
  lines.push(`docker ps --format '{{.Names}}|{{.Status}}' | sed 's/^/container=/'`);
  lines.push(
    `curl -s -o /dev/null -w 'health=%{http_code}\\n' --max-time 5 ${healthUrl} || echo 'health=unreachable'`,
  );
  lines.push(`test -n "$(docker images -q ${image})" && echo "latest=present" || echo "latest=MISSING"`);
  return lines.join('\n');
}

/** `--keep-rollbacks=N` / `ALYSIA_ROLLBACK_KEEP` 的解析（非法值退回默认，不抛） */
export function resolveKeep({ argv = [], env = {} } = {}) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-rollbacks' && argv[i + 1] !== undefined) return toKeep(argv[i + 1]);
    if (a.startsWith('--keep-rollbacks=')) return toKeep(a.slice('--keep-rollbacks='.length));
  }
  return toKeep(env.ALYSIA_ROLLBACK_KEEP);
}

function toKeep(v) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_KEEP;
}
