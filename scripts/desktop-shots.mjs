// 视觉检查：把几个主要界面和四套主题截图，用来确认排版没问题。
// 用法：npx electron scripts/desktop-shots.mjs
// 可用 ACM_TRAINER_SMOKE_HANDLE 指定账号，ACM_TRAINER_SHOTS_DIR 指定输出目录。

import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const SHOTS = process.env.ACM_TRAINER_SHOTS_DIR || join(PROJECT_ROOT, 'work', 'shots');
const HANDLE = process.env.ACM_TRAINER_SMOKE_HANDLE || 'tourist';
const WAIT_MS = Number(process.env.ACM_TRAINER_SMOKE_WAIT || 75000);

process.env.ACM_TRAINER_DATA_DIR =
  process.env.ACM_TRAINER_SMOKE_DATA_DIR || join(PROJECT_ROOT, 'work', 'shots-data');

const { startServer } = await import('../server.js');

mkdirSync(SHOTS, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(win, name, { scrollTo = null, theme = null, height = 0 } = {}) {
  if (theme) {
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-theme-value="${theme}"]').click();`,
    );
    await wait(400);
  }
  if (scrollTo) {
    await win.webContents.executeJavaScript(`
      (() => {
        const target = document.getElementById('${scrollTo}');
        if (target) target.scrollIntoView({ block: 'start' });
      })();
    `);
    await wait(700);
  }
  if (height) {
    win.setContentSize(1280, height);
    await wait(500);
  }
  const image = await win.webContents.capturePage();
  const file = join(SHOTS, `${name}.png`);
  writeFileSync(file, image.toPNG());
  const size = image.getSize();
  console.log(`  已保存 ${name}.png  ${size.width}x${size.height}`);
}

app.whenReady().then(async () => {
  const { url } = await startServer({ port: 0, quiet: true });

  const win = new BrowserWindow({
    width: 1280,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  await fetch(`${url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: HANDLE, target: 3400, weekly: 10 }),
  });

  await win.loadURL(url);
  await wait(WAIT_MS);

  console.log('开始截图：');
  await shot(win, '01-顶部', { height: 1000 });
  await shot(win, '02-训练日程', { scrollTo: 'panel-schedule', height: 1250 });
  await shot(win, '03-活动热力图', { scrollTo: 'panel-heatmap', height: 900 });
  await shot(win, '04-亮色主题-热力图', { theme: 'light' });
  await shot(win, '05-灰色主题-热力图', { theme: 'gray' });
  await shot(win, '06-护眼主题-热力图', { theme: 'eye' });
  await shot(win, '07-亮色主题-日程', { scrollTo: 'panel-schedule' });
  await shot(win, '08-亮色主题-顶部', { scrollTo: null, height: 1000 });

  console.log('输出目录:', SHOTS);
  app.exit(0);
});
