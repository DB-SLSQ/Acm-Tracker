// 把界面在各个关键状态下的样子截图，用于视觉检查和视频素材。
//
// 用法：npx electron scripts/desktop-shots.mjs
//   ACM_TRAINER_SMOKE_HANDLE  Codeforces 用户名（默认 tourist）
//   ACM_TRAINER_SHOTS_DIR     输出目录
//   ACM_TRAINER_SHOTS_TARGET  目标 rating（默认 1800）

import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const SHOTS = process.env.ACM_TRAINER_SHOTS_DIR || join(PROJECT_ROOT, 'work', 'shots');
const HANDLE = process.env.ACM_TRAINER_SMOKE_HANDLE || 'tourist';
const TARGET = Number(process.env.ACM_TRAINER_SHOTS_TARGET || 1800);
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
  writeFileSync(join(SHOTS, `${name}.png`), image.toPNG());
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

  const post = (body) =>
    fetch(`${url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  await post({ handle: HANDLE, target: TARGET, weekly: 10 });
  await win.loadURL(url);
  await wait(WAIT_MS);

  console.log('开始截图：');

  // ---- 暗色主题下的主要界面 ----
  await shot(win, '01-当前水平', { scrollTo: 'panel-overview', height: 1000 });
  await shot(win, '02-训练计划', { scrollTo: 'panel-plan', height: 1150 });
  await shot(win, '03-训练日程', { scrollTo: 'panel-schedule', height: 1250 });

  // 标记某天没空，看题目怎么顺延
  await win.webContents.executeJavaScript(`
    (() => {
      const days = [...document.querySelectorAll('#cal-grid .cal-cell[data-cal-date]')]
        .filter((el) => !el.classList.contains('dim') && el.dataset.calDate > new Date().toISOString().slice(0, 10));
      const pick = days[3] || days[0];
      if (pick) pick.click();
    })();
  `);
  await wait(600);
  await win.webContents.executeJavaScript(`
    (() => {
      const note = document.getElementById('day-note');
      if (note) { note.value = '聚餐'; note.dispatchEvent(new Event('change', { bubbles: true })); }
      document.getElementById('day-toggle')?.click();
    })();
  `);
  await wait(900);
  await shot(win, '04-训练日程-某天没空');

  await shot(win, '05-虚拟参赛', { scrollTo: 'panel-virtual' });
  await shot(win, '06-活动热力图', { scrollTo: 'panel-heatmap', height: 900 });

  // 同步两个平台，好把图表也拍下来
  await win.webContents.executeJavaScript(`
    document.getElementById('nowcoder-input').value = '886965097';
    document.getElementById('luogu-input').value = '377873';
  `);
  await wait(200);
  await win.webContents.executeJavaScript(`document.getElementById('nowcoder-sync').click();`);
  await wait(3500);
  await win.webContents.executeJavaScript(`document.getElementById('luogu-sync').click();`);
  await wait(6000);
  await shot(win, '07-平台数据', { scrollTo: 'panel-platforms', height: 1050 });
  await shot(win, '08-能力画像', { scrollTo: 'panel-tags', height: 1000 });

  // ---- 交互状态 ----
  await win.webContents.executeJavaScript(`
    document.getElementById('collapse-all').click();
    window.scrollTo(0, 0);
  `);
  await wait(800);
  await shot(win, '09-全部收起');
  await win.webContents.executeJavaScript(`document.getElementById('expand-all').click();`);
  await wait(500);

  await win.webContents.executeJavaScript(`document.getElementById('qq-toggle').click();`);
  await wait(600);
  await shot(win, '10-交流群二维码');
  await win.webContents.executeJavaScript(`document.getElementById('qq-toggle').click();`);
  await wait(300);

  await shot(win, '11-设置面板', { scrollTo: 'panel-settings', height: 1250 });

  // ---- 其他主题 ----
  await shot(win, '12-亮色主题', { scrollTo: 'panel-overview', theme: 'light', height: 1000 });
  await shot(win, '13-护眼主题', { scrollTo: 'panel-overview', theme: 'eye' });
  await shot(win, '14-灰色主题', { scrollTo: 'panel-overview', theme: 'gray' });

  console.log('输出目录:', SHOTS);
  app.exit(0);
});
