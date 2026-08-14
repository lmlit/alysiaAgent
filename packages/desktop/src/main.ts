/**
 * ★ 8-15 Electron 壳(PRD M4,照抄 Cyrene 窗口件)
 * 主进程 = 本地完整实例:AlysiaCore + 内嵌 Fastify(webui) + 双窗口
 *  - 主窗口:SPA(管理面板 + 聊天 + 内嵌小人)
 *  - 桌宠窗口:透明/无边框/置顶/点击穿透,加载 pet.html(独立小人,照抄 Cyrene)
 */
import { app, BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { homedir } from 'os';
import 'dotenv/config';
import { AlysiaCore } from '@alysia/core';
import { createWebuiApp } from '@alysia/server/webui';
import { logger } from '@alysia/core';

let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let core: AlysiaCore | null = null;
let httpPort = 0;

const WEBUI_BASE = join(import.meta.dirname, '../../webui');

async function startBackend(): Promise<number> {
  core = new AlysiaCore({
    dbPath: join(app.getPath('userData'), 'alysia.db'),
    ownerId: process.env.ALYSIA_OWNER_ID ?? 'local',
    workspaceDir: process.env.ALYSIA_WORKSPACE ?? homedir(),
    llmConfig: {
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: process.env.CHAT_MODEL ?? 'deepseek-v4-flash',
    },
    embedConfig: {
      baseUrl: process.env.EMBED_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: process.env.EMBED_API_KEY ?? '',
      model: process.env.EMBED_MODEL ?? 'embedding-2',
    },
    features: { codeMode: true }, // 桌面端全量工具 + CodeContext
  });
  await core.start();
  core.registerPlatform('local::private', core.scheduler);

  // createWebuiApp 返回已配置的 Fastify 实例(同 server bootstrap 用法)
  const webui = createWebuiApp(core);
  await webui.listen({ host: '127.0.0.1', port: 0 });
  const addr = webui.server.address();
  httpPort = typeof addr === 'object' && addr ? addr.port : 0;
  logger.info(`[Desktop] backend ready on http://127.0.0.1:${httpPort}`);
  return httpPort;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Alysia · 昔涟',
    backgroundColor: '#07050f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${httpPort}/#/chat`);
  mainWindow.on('closed', () => { mainWindow = null; });
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
  petWindow.loadURL(`http://127.0.0.1:${httpPort}/pet.html`);
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  // 点击穿透:小人透明区域不挡鼠标(桌面交互优先);渲染层 pet.ts 未接管时保持可点
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.on('closed', () => { petWindow = null; });
}

app.whenReady().then(async () => {
  try {
    await startBackend();
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
  core?.stop?.().catch(() => {});
  app.quit();
});
