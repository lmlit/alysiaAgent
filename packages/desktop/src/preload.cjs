// ★ 8-15 窗口控制 preload(照抄 Cyrene 自定义标题栏思路:渲染层按钮 → IPC 控制窗口)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  // ★ 拖窗(照抄 Cyrene):渲染层 pointer 手动拖 → IPC 增量移动
  moveBy: (dx, dy) => ipcRenderer.send('window:move-by', dx, dy),
});
