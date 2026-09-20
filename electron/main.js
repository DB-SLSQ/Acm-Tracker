// 桌面程序入口：启动内置服务，然后用原生窗口打开它。

import { app, BrowserWindow, Menu, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
// 开发模式下窗口用这个图标；打包后用的是 exe 内置的图标资源
const DEV_ICON = join(PROJECT_ROOT, 'build', 'icon.png');

// 必须在导入服务之前设定数据目录：打包后安装目录是只读的，
// 数据库要放到用户数据目录（Windows 上是 %APPDATA%\ACM Trainer）。
process.env.ACM_TRAINER_DATA_DIR = app.isPackaged
  ? join(app.getPath('userData'), 'data')
  : join(PROJECT_ROOT, 'data');

const { startServer } = await import('../server.js');

let mainWindow = null;
let serverUrl = null;

async function createWindow() {
  if (!serverUrl) {
    const { url } = await startServer({ port: 0, quiet: true });
    serverUrl = url;
    console.log('[desktop] 内置服务已启动:', url);
  }

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    title: 'ACM 训练台',
    icon: app.isPackaged ? undefined : DEV_ICON,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 题目页、比赛页这些外链交给系统浏览器，不在应用里打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (serverUrl && !url.startsWith(serverUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    console.log('[desktop] 窗口已关闭');
  });
  await mainWindow.loadURL(serverUrl);
  console.log('[desktop] 页面加载完成');
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'forceReload', label: '强制重新加载' },
          { type: 'separator' },
          { role: 'resetZoom', label: '恢复缩放' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'toggleDevTools', label: '开发者工具' },
        ],
      },
    ]),
  );
}

app.whenReady().then(async () => {
  try {
    buildMenu();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (error) {
    console.error('[desktop] 启动失败:', error);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  console.log('[desktop] 所有窗口已关闭，退出');
  app.quit();
});

process.on('uncaughtException', (error) => {
  console.error('[desktop] 未捕获的异常:', error);
});
