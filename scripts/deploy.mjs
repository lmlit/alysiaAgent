#!/usr/bin/env node
/**
 * 一键部署（★ 2026-10-25，起因：一直只提交不部署，而 SOP 的顺序是「先部署、后提交」）
 *
 *   node scripts/deploy.mjs --dry-run   # 只跑前置检查，不碰服务器（先跑这个）
 *   node scripts/deploy.mjs             # 真部署
 *
 * 环境变量（**不进仓库** —— 本仓公开，见 CLAUDE.md 的两次泄露事故）：
 *   ALYSIA_DEPLOY_HOST  必填，形如 root@1.2.3.4
 *   ALYSIA_DEPLOY_DIR   服务器部署目录，默认 /root/alysia
 *
 * 开关：--dry-run / --allow-dirty / --skip-tests / --merge-config
 *
 * ## 它拦的是今天真踩到的三个坑（每个都**不报错**）
 *
 *   ① **config.yml 被整份覆盖** —— 它是 gitignore 的，本机与服务器各自漂移。
 *      实测把服务器侧 `max_tokens 1024→256`、`4096→2048` 和整段 `projects:` 退回默认
 *      （委托工具会全部不注册）。⇒ 本脚本**默认拒绝**：发现服务器独有行就中止，
 *      要你显式 `--merge-config` 才继续。
 *   ② **切镜像前没打回滚标签** ⇒ 出问题退不回去。⇒ 先 tag 再切。
 *   ③ **切完不看健康** ⇒ 服务半死而你以为发成功了。⇒ 轮询 /api/health，不健康**自动回滚**。
 *
 * ## 为什么用 .mjs 而不是 .sh
 * 主战场是 Windows，`.sh` 依赖 git-bash；node 是硬依赖（构建/测试都要 24），两端一致。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const TMP_DIR = join(ROOT, '.tmp');           // gitignored
const IMAGE_TAR = join(SERVER_DIR, 'alysia-image.tar');
const CFG_TAR = join(SERVER_DIR, 'alysia-deploy.tar.gz');
const HOST = (process.env.ALYSIA_DEPLOY_HOST || '').trim();
const REMOTE_DIR = (process.env.ALYSIA_DEPLOY_DIR || '/root/alysia').trim();
const IMAGE = 'server-alysia:latest';
const HEALTH_URL = 'http://localhost:6186/api/health';

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const ALLOW_DIRTY = argv.has('--allow-dirty');
const SKIP_TESTS = argv.has('--skip-tests');
/** 跳过构建，直接部署本地现成镜像（见 Step 2/3 的「离线构建」说明） */
const SKIP_BUILD = argv.has('--skip-build');
const MERGE_CONFIG = argv.has('--merge-config');

const log = (m) => console.log(`\n▸ ${m}`);
const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n✖ ${m}`); process.exit(1); };

/** 跑命令；失败即中止（部署脚本不许"继续看看"）。allowFail=true 时返回 stderr+stdout */
function run(cmd, args, { cwd = ROOT, allowFail = false, quiet = false, shell = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd, encoding: 'utf8', shell,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    })?.toString().trim() ?? '';
  } catch (e) {
    const detail = ((e.stdout || '') + (e.stderr || '') || e.message || '').toString().slice(0, 3000);
    if (allowFail) return detail;
    die(`命令失败：${cmd} ${args.join(' ')}\n${detail}`);
  }
}

/**
 * 只看**退出码**的版本（★ 2026-10-25 修：Step 0b 曾按文本判断"测试过没过"，
 * 而 vitest 的 stderr 里塞满了测试自己的日志 —— 解析文本就会误判成失败，
 * 于是部署在"测试其实全绿"的情况下被自己拦下。退出码才是唯一可信信号。）
 */
function tryRun(cmd, args, { cwd = ROOT, quiet = true } = {}) {
  try {
    execFileSync(cmd, args, {
      cwd, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '') || e.message || '').toString() };
  }
}

/**
 * 跑 pnpm/npx —— Windows 上它们是 `.cmd`，`execFileSync` 直接调会 ENOENT，
 * 所以走 shell。参数都是固定字面量，没有注入面。
 */
const runPnpm = (args) => run('pnpm', args, { shell: true });
const runNpx = (args) => run('npx', args, { shell: true });

/** 远程执行：脚本经 stdin 送过去（避免 PowerShell 引号地狱 —— 今天为此浪费过时间） */
function remote(script, { allowFail = false } = {}) {
  const body = script.replace(/\r\n/g, '\n');
  try {
    return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, 'bash -s'], {
      cwd: ROOT, encoding: 'utf8', input: body, maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (e) {
    const detail = ((e.stdout || '') + (e.stderr || '') || e.message || '').toString();
    if (allowFail) return detail.trim();
    die(`远程命令失败：\n${detail.slice(0, 3000)}`);
  }
}

// ── Step 0 前置检查 ───────────────────────────────────────────────────────
log('Step 0 前置检查');
if (!HOST) die('没有 ALYSIA_DEPLOY_HOST。例（PowerShell）：$env:ALYSIA_DEPLOY_HOST="root@1.2.3.4" —— 不要写进仓库');
if (HOST.includes('/') || HOST.startsWith('http')) die(`ALYSIA_DEPLOY_HOST 只要 host，形如 root@1.2.3.4（当前 "${HOST}"）`);
if (!existsSync(join(SERVER_DIR, 'config.yml'))) die('缺 packages/server/config.yml');

const localCfgPath = join(SERVER_DIR, 'config.yml');
if (/^ *host:/m.test(readFileSync(localCfgPath, 'utf8'))) {
  die('config.yml 里有 server.host —— 打进去会让容器绑回环地址、服务器失联（SOP 自查项）');
}

const dirty = run('git', ['status', '--porcelain', '--', ':(exclude).tmp-*']);
if (dirty && !ALLOW_DIRTY) die(`工作区有未提交改动（回滚要有依据）:\n${dirty}\n  → 先提交，或加 --allow-dirty`);

if (!/^\d+/.test(run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFail: true }))) {
  die('Docker 引擎没起（docker info 失败）。启动 Docker Desktop 并等它就绪');
}
if (!/ok/.test(remote('echo ok', { allowFail: true }))) die(`SSH 免密连不上 ${HOST}`);

say(`目标 ${HOST}:${REMOTE_DIR} · 镜像 ${IMAGE}${DRY ? ' · DRY-RUN' : ''}`);

if (!SKIP_TESTS) {
  log('Step 0b 全量测试（--skip-tests 可跳过，但别跳）');
  // 只看退出码（见 `tryRun` 的注释：文本判断会把 stderr 里的测试日志误当成失败）
  const r = tryRun('npx', ['vitest', 'run', '--exclude=tests/memory/e2e/*']);
  if (!r.ok) {
    const tail = r.out.split('\n').filter((l) => /FAIL|✗|×|Tests\s+\d|Test Files/.test(l)).slice(-12).join('\n');
    die(`全量测试没过（exit≠0）：\n${tail || r.out.slice(-1200)}`);
  }
  say('✓ 全量测试通过（exit 0）');
}

// ── Step 1 config 漂移闸（今天的事故就缺这一步）───────────────────────────
log('Step 1 config.yml 漂移检查');
const serverCfg = remote(`cat ${REMOTE_DIR}/config.yml 2>/dev/null || true`);
if (!serverCfg) {
  say('（服务器还没有 config.yml —— 首次部署，跳过比对）');
} else {
  mkdirSync(TMP_DIR, { recursive: true });
  const tmp = join(TMP_DIR, 'config.server.yml');
  writeFileSync(tmp, serverCfg, 'utf8');
  const diff = run('git', ['diff', '--no-index', '--unified=0', '--', tmp, localCfgPath], { allowFail: true });
  rmSync(tmp, { force: true });

  if (!diff.trim()) {
    say('✓ 与服务器一致');
  } else {
    const lines = diff.split('\n');
    const serverOnly = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const localOnly = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    say(`⚠ 不一致：服务器独有 ${serverOnly.length} 行 / 本机独有 ${localOnly.length} 行`);
    for (const l of serverOnly.slice(0, 20)) say(`   服务器有、本机无  ${l}`);
    if (serverOnly.length > 20) say(`   …另有 ${serverOnly.length - 20} 行`);
    for (const l of localOnly.slice(0, 10)) say(`   本机有、服务器无  ${l}`);
    if (!MERGE_CONFIG) {
      die(
        '拒绝部署：整份覆盖会**静默抹掉**服务器侧配置（历史上干过：max_tokens 调参、projects 委托表 ⇒ 委托工具不注册）。\n' +
        '  做法：把上面「服务器有、本机无」的行并进本机 config.yml，重跑；确认已并集后可加 --merge-config。',
      );
    }
    say('⚠ --merge-config：按你的显式确认继续');
  }
}

if (DRY) { log('DRY-RUN 结束：前置检查通过，未改动服务器'); process.exit(0); }

// ── Step 2/3 构建 ────────────────────────────────────────────────────────
//
// ★ 2026-10-25 实测的**离线构建**姿势（`--skip-build` 就是为它准备的）：
//   本机 Docker Desktop 的 BuildKit **无法拉取基础镜像元数据**（`auth.docker.io` 被拒），
//   而 `node:22-alpine` 其实早就在本地。稳妥做法：
//     1. `docker tag <本地 base 镜像 ID> local/node:22-alpine`
//     2. 临时把 Dockerfile 的两处 `FROM node:22-alpine` 指向 `local/node:22-alpine`
//     3. `docker compose build`（命中缓存，无需联网）→ 之后**还原 Dockerfile**
//     4. `node scripts/deploy.mjs --skip-build`
//   ⇒ 这条路径不碰 registry，构建确定性更高。
if (SKIP_BUILD) {
  log('Step 2/3 跳过构建（--skip-build：用本地现成镜像）');
  const id = run('docker', ['images', IMAGE, '--format', '{{.ID}}'], { allowFail: true });
  if (!id) die(`本地没有 ${IMAGE} —— 不能 --skip-build`);
  say(`✓ 复用 ${IMAGE} → ${id.split('\n')[0]}`);
} else {
  log('Step 2 构建前端产物（镜像只 COPY console/out，不在镜像里构建）');
  runPnpm(['build:console']);
  const outIdx = join(ROOT, 'packages', 'console', 'out', 'index.html');
  if (!existsSync(outIdx)) die('packages/console/out 无产物');
  say(`✓ out/ 就绪（mtime ${new Date(statSync(outIdx).mtimeMs).toISOString()}）`);

  log('Step 3 构建镜像');
  // ★ `pnpm install` 层一旦失效就必须联网；容器内直连 npmmirror 在本机会 ECONNRESET，
  //   所以支持传构建期代理：ALYSIA_BUILD_PROXY=http://host.docker.internal:7898
  //   ⚠️ Clash 只监听回环 ⇒ 需要 `0.0.0.0:7898 → 127.0.0.1:7897` 的转发。
  const proxyArgs = process.env.ALYSIA_BUILD_PROXY
    ? ['--build-arg', `HTTP_PROXY=${process.env.ALYSIA_BUILD_PROXY}`,
       '--build-arg', `HTTPS_PROXY=${process.env.ALYSIA_BUILD_PROXY}`]
    : [];
  run('docker', ['compose', 'build', ...proxyArgs], { cwd: SERVER_DIR });
  say(`✓ ${IMAGE} → ${run('docker', ['images', IMAGE, '--format', '{{.ID}}'], { allowFail: true }) || '(未找到)'}`);
}

// ── Step 4 打包 + 上传 ───────────────────────────────────────────────────
log('Step 4 打包 + 上传');
rmSync(IMAGE_TAR, { force: true });
rmSync(CFG_TAR, { force: true });
run('docker', ['save', IMAGE, '-o', IMAGE_TAR]);
run('tar', ['czf', CFG_TAR, 'compose.yml', 'config.yml'], { cwd: SERVER_DIR });
say(`✓ 镜像包 ${(statSync(IMAGE_TAR).size / 1024 / 1024).toFixed(1)} MB`);
run('scp', ['-o', 'BatchMode=yes', IMAGE_TAR, CFG_TAR, `${HOST}:/root/`]);
say('✓ 已上传');

// ── Step 5 打回滚标签 → 切换 → 健康检查（失败自动回滚）────────────────────
log('Step 5 部署（先打回滚标签）');
const out = remote(`
set -u
cd ${REMOTE_DIR} || { echo "FAIL=cd"; exit 2; }
TS=$(date +%Y%m%d-%H%M%S)
OLD=$(docker inspect --format '{{.Image}}' alysia-server 2>/dev/null || true)
if [ -n "$OLD" ]; then docker tag "$OLD" "server-alysia:rollback-$TS" >/dev/null 2>&1 && echo "rollback-tag=server-alysia:rollback-$TS"; fi
docker load -i /root/alysia-image.tar >/dev/null 2>&1 || { echo "FAIL=load"; exit 3; }
tar xzf /root/alysia-deploy.tar.gz -C ${REMOTE_DIR} || { echo "FAIL=untar"; exit 4; }
docker compose -f compose.yml config -q || { echo "FAIL=config-invalid"; exit 5; }
docker compose -f compose.yml down >/dev/null 2>&1
docker compose -f compose.yml up -d >/dev/null 2>&1 || { echo "FAIL=up"; exit 6; }
for i in $(seq 1 24); do
  sleep 5
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 ${HEALTH_URL} || true)
  echo "health[$i]=$CODE"
  [ "$CODE" = "200" ] && { echo "OK"; exit 0; }
done
echo "FAIL=health"
exit 7
`, { allowFail: true });
for (const l of out.split('\n')) say(l);

const rollbackTag = (out.match(/rollback-tag=(\S+)/) || [])[1] || '';
if (!/^OK$/m.test(out)) {
  console.error('\n✖ 健康检查没过 —— 自动回滚');
  if (!rollbackTag) die('没有回滚标签，服务状态未知 —— 立刻人工处理（docker ps / docker logs alysia-server）');
  const rb = remote(`
set -u
cd ${REMOTE_DIR}
docker tag ${rollbackTag} ${IMAGE} || exit 1
docker compose -f compose.yml down >/dev/null 2>&1
docker compose -f compose.yml up -d >/dev/null 2>&1
sleep 8
curl -s --max-time 5 ${HEALTH_URL} || true
`, { allowFail: true });
  die(`已回滚到 ${rollbackTag}，回滚后健康：${rb || '(无响应)'}\n  请人工确认 docker logs alysia-server --tail 50`);
}

log('部署成功');
say(remote(`docker ps --format '{{.Names}} {{.Status}}'; curl -s --max-time 5 ${HEALTH_URL}; echo`).replace(/\n/g, '\n  '));
say(`回滚点：${rollbackTag || '（无）'}`);
console.log('\n下一步：把这次部署输出记进 change（验收依据），再提交代码 —— SOP 的 Step 5。');
