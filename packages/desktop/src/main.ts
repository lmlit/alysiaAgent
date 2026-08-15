/**
 * ★ 8-15 Electron 壳(PRD M4,子进程架构)
 * 后端跑独立 Node 子进程(server bootstrap --desktop 模式)——原生模块
 * (better-sqlite3/LanceDB)在 Node ABI 下运行,规避 Electron ABI 不匹配;
 * Electron 主进程保持薄:窗口壳 + 后端生命周期管理。
 *  - 主窗口:SPA(管理面板 + 聊天 + 内嵌小人)
 *  - 桌宠窗口:透明/无边框/置顶/点击穿透,加载 pet.html(照抄 Cyrene)
 */
import { app, BrowserWindow, screen } from 'electron';
import { fork, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { logger } from '@alysia/core';

const BACKEND_PORT = 6185;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let backend: ChildProcess | null = null;

function startBackend(): void {
  const serverDir = resolve(import.meta.dirname, '../../server');
  backend = fork(resolve(serverDir, 'dist/bootstrap.js'), [], {
    cwd: serverDir, // dotenv 从 server 目录向上解析到项目根 .env
    // ★ execPath 指向真实 Node:Electron 的 fork 默认用自身可执行文件(ABI 不匹配 →
    //   better-sqlite3 ERR_DLOPEN_FAILED)。pnpm/npm 运行时都会注入 npm_node_execPath。
    execPath: process.env.npm_node_execPath ?? 'node',
    env: { ...process.env, ALYSIA_DESKTOP: '1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  backend.on('exit', (code) => {
    logger.info(`[Desktop] backend exited (code=${code})`);
    backend = null;
  });
}

/** 轮询 /api/health 直到后端就绪(30s 超时) */
async function waitForBackend(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('backend failed to start within timeout');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Alysia · 昔涟',
    backgroundColor: '#07050f',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadURL(`${BACKEND_URL}/#/chat`);
  mainWindow.on('closed', () => {
    mainWindow = null;
    // ★ 主窗口 = 应用主入口:关闭即退出全部(桌宠 + 后端一并回收),不留残影进程
    app.quit();
  });
}

/** 桌宠窗口:照抄 Cyrene(透明/无边框/置顶/穿透/跳过任务栏) */
function createPetWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  petWindow = new BrowserWindow({
    x: workArea.x + workArea.width - 420,
    y: workArea.y + workArea.height - 520,
    width: 400,
    height: 500,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  petWindow.loadURL(`${BACKEND_URL}/pet.html`);
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  // ★ 一期:不做像素级点击穿透(需 preload + click-through IPC 像素采样,见 PRD 遗留);
  //   窗口可交互——小人可点击/可拖拽(拖拽逻辑在 pet.ts)
  petWindow.on('closed', () => { petWindow = null; });
}

app.whenReady().then(async () => {
  try {
    startBackend();
    await waitForBackend();
    createMainWindow();
    createPetWindow();
  } catch (err) {
    logger.error('[Desktop] startup failed:', err);
    app.quit();
  }

  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  backend?.kill();
  app.quit();
});

// 进程退出兜底:后端子进程一并回收
process.on('exit', () => { backend?.kill(); });
