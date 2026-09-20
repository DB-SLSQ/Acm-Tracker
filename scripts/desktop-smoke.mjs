// 桌面程序冒烟测试：无界面启动 Electron，检查页面是否真的渲染成功，然后退出。
// 用法：npx electron scripts/desktop-smoke.mjs

import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
process.env.ACM_TRAINER_DATA_DIR = join(PROJECT_ROOT, 'data');

const { startServer } = await import('../server.js');

const problems = [];

app.whenReady().then(async () => {
  const { url } = await startServer({ port: 0, quiet: true });

  const win = new BrowserWindow({
    show: false,
    width: 1320,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.webContents.on('render-process-gone', (_event, details) =>
    problems.push(`渲染进程崩溃: ${details.reason}`),
  );
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl) =>
    problems.push(`页面加载失败 ${code} ${description} ${failedUrl}`),
  );
  // 捕获前端 JavaScript 报错
  win.webContents.on('console-message', (...args) => {
    const detail = args[0] && typeof args[0] === 'object' && 'level' in args[0] ? args[0] : null;
    const level = detail ? detail.level : args[1];
    const message = detail ? detail.message : args[2];
    if (level === 'error' || level === 3) problems.push(`控制台报错: ${message}`);
  });

  await win.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, 4000)); // 等前端脚本跑完、日历请求回来

  const snapshot = await win.webContents.executeJavaScript(`({
    title: document.title,
    panels: document.querySelectorAll('section.panel').length,
    visiblePanels: [...document.querySelectorAll('section.panel')].filter(el => !el.classList.contains('hidden')).map(el => el.id),
    status: document.getElementById('status')?.textContent ?? null,
    calendarSummary: document.getElementById('calendar-summary')?.textContent ?? null,
    calendarRows: document.getElementById('calendar-list')?.children.length ?? 0,
    quickPicks: document.getElementById('quick-picks')?.children.length ?? 0,
    hasHandleInput: !!document.getElementById('handle-input'),
    hasTimerBar: !!document.getElementById('timer-bar'),
    bodyPreview: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)
  })`);

  console.log('');
  console.log('===== 冒烟测试结果 =====');
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('问题:', problems.length ? problems : '无');
  console.log('========================');
  app.exit(problems.length ? 1 : 0);
});
