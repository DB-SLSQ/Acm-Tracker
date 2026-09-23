// 桌面程序冒烟测试：无界面启动 Electron，检查页面渲染和「重启后自动恢复账号」。
// 用法：npx electron scripts/desktop-smoke.mjs
// 可加 ACM_TRAINER_SMOKE_DATA_DIR 指定数据目录，默认用项目里的 data/。

import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
process.env.ACM_TRAINER_DATA_DIR =
  process.env.ACM_TRAINER_SMOKE_DATA_DIR || join(PROJECT_ROOT, 'data');

const { startServer } = await import('../server.js');

const problems = [];
const TEST_HANDLE = process.env.ACM_TRAINER_SMOKE_HANDLE || 'smoke-test-user';
// 真实账号要走完整流程（抓数据 + 生成计划），等待时间需要放宽
const FULL_FLOW = TEST_HANDLE !== 'smoke-test-user';
const WAIT_MS = Number(process.env.ACM_TRAINER_SMOKE_WAIT || (FULL_FLOW ? 60000 : 4000));

function watchRenderer(win) {
  win.webContents.on('render-process-gone', (_event, details) =>
    problems.push(`渲染进程崩溃: ${details.reason}`),
  );
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl) =>
    problems.push(`页面加载失败 ${code} ${description} ${failedUrl}`),
  );
  win.webContents.on('console-message', (...args) => {
    const detail = args[0] && typeof args[0] === 'object' && 'level' in args[0] ? args[0] : null;
    const level = detail ? detail.level : args[1];
    const message = detail ? detail.message : args[2];
    if (level === 'error' || level === 3) problems.push(`控制台报错: ${message}`);
  });
}

const readPage = (win) =>
  win.webContents.executeJavaScript(`({
    title: document.title,
    panels: document.querySelectorAll('section.panel').length,
    visiblePanels: [...document.querySelectorAll('section.panel')]
      .filter((el) => !el.classList.contains('hidden')).map((el) => el.id),
    status: document.getElementById('status')?.textContent ?? null,
    handle: document.getElementById('handle-input')?.value ?? null,
    target: document.getElementById('target-input')?.value ?? null,
    weekly: document.getElementById('weekly-input')?.value ?? null,
    calendarSummary: document.getElementById('calendar-summary')?.textContent ?? null,
    calendarRows: document.getElementById('calendar-list')?.children.length ?? 0,
    quickPicks: document.getElementById('quick-picks')?.children.length ?? 0,
    version: document.getElementById('app-version')?.textContent ?? null,
    overviewText: document.getElementById('stats')?.innerText?.replace(/\\s+/g, ' ').slice(0, 90) ?? null,
    planSummary: document.getElementById('plan-summary')?.textContent?.slice(0, 90) ?? null,
    theme: document.documentElement.dataset.theme ?? null,
    themeButtons: document.querySelectorAll('#theme-switch .theme-btn').length,
    paletteDots: document.querySelectorAll('#palette-switch .palette-dot').length,
    heatmapCells: document.querySelectorAll('.heatmap-cell[data-level]').length,
    calendarCells: document.querySelectorAll('#cal-grid .cal-cell').length,
    restChips: document.querySelectorAll('#rest-picker .rest-chip').length,
    scheduleSummary: document.getElementById('schedule-summary')?.textContent?.slice(0, 90) ?? null,
    qqLink: document.getElementById('qq-toggle')?.textContent?.trim() ?? null,
    qqInTopbar: !!document.querySelector('.topbar #qq-toggle'),
    panelToggles: document.querySelectorAll('.panel-toggle').length
    ,
    hasSettingsPanel: !!document.getElementById('panel-settings'),
    moduleToggles: document.querySelectorAll('#module-list [data-module]').length,
    hasNowcoderInput: !!document.getElementById('nowcoder-input'),
    hasLuoguInput: !!document.getElementById('luogu-input'),
    hasFloorGapInput: !!document.getElementById('floor-gap-input'),
    hasRecordsPanel: !!document.getElementById('panel-records'),
    navLinks: document.querySelectorAll('.subnav a').length
  })`);

const postSettings = (url, body) =>
  fetch(`${url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

app.whenReady().then(async () => {
  const { url } = await startServer({ port: 0, quiet: true });
  const original = (await (await fetch(`${url}/api/settings`)).json()).settings;

  const win = new BrowserWindow({
    show: false,
    width: 1320,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  watchRenderer(win);

  // 阶段一：没有存过账号时的冷启动
  await win.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const cold = await readPage(win);

  // 阶段二：写入账号设置后重新加载，应当自动填好并开始加载数据
  await postSettings(url, { handle: TEST_HANDLE, target: 1900, weekly: 12 });
  await win.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  const restored = await readPage(win);

  // 还原成测试前的设置，避免污染真实数据
  await postSettings(url, {
    handle: original?.handle ?? '',
    target: original?.target ?? '',
    weekly: original?.weekly ?? '',
    theme: original?.theme ?? 'dark',
    heatmapPalette: original?.heatmapPalette ?? 'green',
  });

  // 点一下「亮色」，页面上的主题属性应该立刻跟着变
  const themeAfterClick = await win.webContents.executeJavaScript(`
    document.querySelector('[data-theme-value="light"]').click();
    document.documentElement.dataset.theme || '';
  `);
  // 这一下会把主题写进库；测完还回去，否则下次冷启动读到的就不是默认暗色了
  await postSettings(url, { theme: original?.theme ?? 'dark' });

  // 页脚的交流群入口：点一下应该把二维码弹出来
  const qrPopup = await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('qq-toggle').click();
      const pop = document.getElementById('qq-pop');
      const shown = !pop.classList.contains('hidden');
      const img = pop.querySelector('img');
      return {
        shown,
        src: img?.getAttribute('src') ?? null,
        loaded: img ? img.naturalWidth > 0 : false,
        name: pop.querySelector('strong')?.textContent ?? null,
      };
    })();
  `);

  // 面板折叠：收起后按钮必须还在，而且点标题也要能展开（防止误触后找不回来）
  const collapseTest = await win.webContents.executeJavaScript(`
    (() => {
      // 用比赛日历：它不依赖训练计划，冷启动时也是显示的
      const panel = document.getElementById('panel-calendar');
      const button = document.querySelector('.panel-toggle[data-panel="panel-calendar"]');
      if (!button) return {};
      const labelExpanded = getComputedStyle(button, '::after').content || '';
      button.click();
      const collapsed = panel.classList.contains('collapsed');
      const buttonVisible = button.offsetParent !== null;
      const labelCollapsed = getComputedStyle(button, '::after').content || '';
      panel.querySelector('.panel-head h2').click();
      const expandedByHeader = !panel.classList.contains('collapsed');
      button.click();
      const collapsedAgain = panel.classList.contains('collapsed');
      button.click();
      const expandedAgain = !panel.classList.contains('collapsed');
      return {
        collapsed, buttonVisible, expandedByHeader, collapsedAgain, expandedAgain,
        labelExpanded, labelCollapsed,
      };
    })();
  `);

  // 收起全部之后，每块面板的标题都应该还在，点一下能恢复
  const bulkTest = await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('collapse-all').click();
      const allCollapsed = document.querySelectorAll('section.panel.collapsed').length;
      const titlesVisible = [...document.querySelectorAll('section.panel')]
        .filter((el) => !el.classList.contains('hidden'))
        .every((el) => el.querySelector('.panel-head h2')?.offsetParent !== null);
      document.getElementById('expand-all').click();
      const afterExpand = document.querySelectorAll('section.panel.collapsed').length;
      return { allCollapsed, titlesVisible, afterExpand };
    })();
  `);

  // 设置里关掉一个模块，它应该整个消失（连导航里的入口一起）
  const moduleTest = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('#module-list [data-module="panel-calendar"]');
      if (!box) return {};
      box.click();
      const panelHidden = document.getElementById('panel-calendar').classList.contains('module-hidden');
      const navHidden = document.querySelector('.subnav a[href="#panel-calendar"]')
        ?.classList.contains('module-hidden') ?? false;
      box.click();
      const backAgain = !document.getElementById('panel-calendar').classList.contains('module-hidden');
      return { panelHidden, navHidden, backAgain };
    })();
  `);

  const checks = [
    ['页面标题正确', restored.title === 'ACM 训练台'],
    ['14 个界面区块都在', restored.panels === 14],
    ['冷启动只显示输入框、日历和设置', cold.visiblePanels.join(',') === 'panel-handle,panel-calendar,panel-settings'],
    ['冷启动时输入框为空', !cold.handle],
    ['比赛日历加载成功', cold.calendarRows > 0],
    ['底部显示版本号', /^v\d+\.\d+\.\d+$/.test(cold.version ?? '')],
    ['主题按钮有 4 个', cold.themeButtons === 4],
    ['默认是暗色主题', cold.theme === 'dark'],
    ['点击可切换主题', themeAfterClick === 'light'],
    ['顶部有交流群入口', /1124017564/.test(cold.qqLink ?? '') && cold.qqInTopbar],
    ['点击弹出二维码', qrPopup.shown === true],
    ['二维码图片能加载', qrPopup.loaded === true],
    ['群名显示正确', (qrPopup.name ?? '').includes('onlyfans club')],
    ['每个内容面板都有折叠按钮', restored.panelToggles === 12],
    ['点击可收起面板', collapseTest.collapsed === true],
    ['收起后按钮仍可见', collapseTest.buttonVisible === true],
    ['按钮文字随状态变化', /收起/.test(collapseTest.labelExpanded) && /展开/.test(collapseTest.labelCollapsed)],
    ['点标题也能展开', collapseTest.expandedByHeader === true],
    ['按钮还能再次收起和展开', collapseTest.collapsedAgain === true && collapseTest.expandedAgain === true],
    ['收起全部能收干净', bulkTest.allCollapsed >= 8],
    ['收起后标题仍可见', bulkTest.titlesVisible === true],
    ['展开全部能恢复', bulkTest.afterExpand === 0],
    ['有独立的设置面板', cold.hasSettingsPanel === true],
    ['模块开关有 12 个', cold.moduleToggles === 12],
    ['有牛客 ID 输入框', cold.hasNowcoderInput === true],
    ['有洛谷 ID 输入框', cold.hasLuoguInput === true],
    ['有排除区间设置', cold.hasFloorGapInput === true],
    ['有做题记录模块', cold.hasRecordsPanel === true],
    ['关掉模块后面板消失', moduleTest.panelHidden === true],
    ['导航入口也一起消失', moduleTest.navHidden === true],
    ['重新打开能恢复', moduleTest.backAgain === true],
    ['重启后自动填好用户名', restored.handle === TEST_HANDLE],
    ['重启后自动填好目标分数', restored.target === '1900'],
    ['重启后自动填好每周题量', restored.weekly === '12'],
    ['重启后自动触发加载', !!restored.status && restored.status !== '未连接'],
  ];

  if (FULL_FLOW) {
    checks.push(
      ['自动加载出概览面板', restored.visiblePanels.includes('panel-overview')],
      ['读到真实 rating', /rating/.test(restored.overviewText ?? '')],
      ['自动生成出训练计划', restored.visiblePanels.includes('panel-plan')],
      ['计划内容非空', /目标/.test(restored.planSummary ?? '')],
      ['训练日程渲染出月历', restored.calendarCells >= 28],
      ['日程摘要非空', /开始/.test(restored.scheduleSummary ?? '')],
      ['每周休息日有 7 个按钮', restored.restChips === 7],
      ['热力图渲染出瓷砖', restored.heatmapCells > 300],
      ['配色可选 5 种', restored.paletteDots === 5],
    );
  }

  console.log('');
  console.log('===== 桌面程序冒烟测试 =====');
  console.log('冷启动:', JSON.stringify(cold, null, 2));
  console.log('恢复后:', JSON.stringify(restored, null, 2));
  console.log('');
  for (const [label, pass] of checks) console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  console.log('');
  console.log('渲染问题:', problems.length ? problems : '无');
  console.log('===========================');

  const failed = checks.filter(([, pass]) => !pass).length + problems.length;
  app.exit(failed ? 1 : 0);
});
