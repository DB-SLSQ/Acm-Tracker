import {
  buildSchedule,
  dateKey,
  heatmapWeeks,
  monthMatrix,
  parseDateKey,
  todayOverview,
  WEEKDAY_LABELS,
} from './schedule.js';

const state = {
  handle: '',
  target: 1800,
  weekly: 10,
  planData: null,
  done: new Set(),
  // 其中「按提交记录自动打勾」的部分，界面上单独标出来
  doneAuto: new Set(),
  virtual: null,
  reviewId: 0,
  hasSavedTarget: false,
  // 外观
  theme: 'dark',
  palette: 'green',
  // 日程
  restDays: [],
  dayOff: {},
  planProblems: [],
  schedule: null,
  // 计划定下来的那天。日程和「今天」卡片都以它为锚点，
  // 这样每天的题是固定的，勾掉一题不会让后面的题往前顶。
  planStart: null,
  calCursor: null,
  selectedDate: null,
  // 热力图
  activity: null,
  heatmapYear: new Date().getFullYear(),
  heatmapMetric: 'solved',
  // 被整个隐藏的模块
  hiddenModules: [],
  // 当前打开的页面（左边菜单点了就切）和已经拿到数据的页面
  view: 'panel-overview',
  readyView: new Set(),
  // 列表密度：紧凑模式
  compact: false,
  // 做题手感反馈：key -> feel；以及最近一次拉回来的复盘/热身数据
  feedback: new Map(),
  warmup: null,
  retro: null,
  extraTasks: {},
  // 其他平台
  nowcoderUid: null,
  // AtCoder：用户名 + 训练计划里要不要混 AtCoder 的题
  atcoderUid: null,
  atcoderInPlan: false,
  // 洛谷题要不要进训练计划
  luoguInPlan: false,
  // 打卡提醒
  remindAt: null,
  remindLast: null,
  reminderBanner: null,
  // 补题队列
  review: [],
  reviewSort: 'stale',
  // 成长报告
  growth: null,
  // 多账号
  handles: [],
  compare: null,
  compareOther: null,
  // 手动塞进某天的补题：{ 'YYYY-MM-DD': [题目] }
  extras: {},
  platforms: [],
  // 洛谷镜像的 CF 题号集合，用来标记「这题你在洛谷做过」
  luoguKeys: new Set(),
  // 洛谷题库的抓取摘要（抓了几道、抽了哪几页）
  luoguCatalog: null,
  // 训练计划里是否隐藏标签（有些人喜欢不看标签自己想）
  hideTags: false,
  // 做题记录
  blocked: [],
  solved: [],
  solvedTotal: 0,
};

const THEME_LABELS = { dark: '暗色', light: '亮色', gray: '灰色', eye: '护眼' };
const PALETTE_LABELS = { green: '绿', blue: '蓝', pink: '粉', orange: '橙', purple: '紫' };
const PALETTE_COLORS = {
  green: ['#46695a', '#3a8a5e', '#2aa862', '#12c46e'],
  blue: ['#44607e', '#3a7ab0', '#2b95da', '#14aef7'],
  pink: ['#7d5a6d', '#ac6089', '#d664a4', '#f25fbb'],
  orange: ['#7d6349', '#ad7539', '#d9902b', '#f5a81b'],
  purple: ['#5d5878', '#7a5cb0', '#9260dd', '#a866ff'],
};

const $ = (id) => document.getElementById(id);

/**
 * Codeforces 的官方 tag 全是英文，界面上直接显示英文对中文用户不友好。
 * 这里把 37 个官方 tag 全部译成中文；鼠标悬停在标签上还能看到英文原文，
 * 方便去 Codeforces 上按 tag 搜题。表里没有的（平台自己加的标签）原样显示。
 */
const TAG_ZH = {
  implementation: '模拟与实现',
  'brute force': '暴力枚举',
  sortings: '排序',
  'expression parsing': '表达式解析',
  schedules: '调度',
  'data structures': '数据结构',
  dsu: '并查集',
  hashing: '哈希',
  'divide and conquer': '分治',
  graphs: '图论',
  'graph matchings': '图匹配',
  trees: '树',
  'dfs and similar': 'DFS 与遍历',
  'shortest paths': '最短路',
  flows: '网络流',
  '2-sat': '2-SAT',
  dp: '动态规划',
  'meet-in-the-middle': '折半搜索',
  math: '数学',
  'number theory': '数论',
  combinatorics: '组合数学',
  geometry: '计算几何',
  // Codeforces 把这个标签从 probabilistic 改名成了 probabilities，
  // 两个都留着：旧缓存里的题还是前一个写法。
  probabilities: '概率与期望',
  probabilistic: '概率与期望',
  matrices: '矩阵运算',
  'chinese remainder theorem': '中国剩余定理',
  fft: '快速傅里叶变换',
  games: '博弈论',
  'ternary search': '三分查找',
  strings: '字符串',
  'string suffix structures': '后缀结构',
  'binary search': '二分查找',
  'constructive algorithms': '构造',
  interactive: '交互题',
  communication: '通信题',
  greedy: '贪心',
  'two pointers': '双指针',
  bitmasks: '位运算',
  'sqrt decomposition': '根号分治',
};

/** 单个 tag 的中文名。 */
function tagZh(tag) {
  return TAG_ZH[tag] ?? tag;
}

/** 把一组 tag 渲染成中文标签，悬停能看到原文。 */
function tagSpans(tags, limit = 3) {
  return (tags ?? [])
    .slice(0, limit)
    .map((tag) => `<span title="${escapeHtml(tag)}">${escapeHtml(tagZh(tag))}</span>`)
    .join('、');
}

const RANK_STOPS = [
  [1200, '#b9b9b9'],
  [1400, '#6dd36d'],
  [1600, '#57c8c8'],
  [1900, '#6a9dff'],
  [2100, '#c39bff'],
  [2400, '#ffb454'],
  [2600, '#ff7676'],
  [3000, '#ff4d4d'],
  [Infinity, '#b30000'],
];

function ratingColor(rating) {
  if (rating == null) return '#6b7280';
  for (const [limit, color] of RANK_STOPS) if (rating < limit) return color;
  return '#b30000';
}

function ratingBadge(rating) {
  if (rating == null) return '<span class="subtle">未定级</span>';
  return `<span class="rating-badge" style="background:${ratingColor(rating)}">${rating}</span>`;
}

let statusTimer = null;

function setStatus(text, { busy = false } = {}) {
  const el = $('status');
  el.textContent = text;
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (!busy) return;

  const startedAt = Date.now();
  statusTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    el.textContent = `${text}（已等待 ${seconds} 秒）`;
  }, 1000);
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  return payload;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  return payload;
}

/**
 * 保存设置到本地数据库。
 * 不能用浏览器的 localStorage：桌面版每次启动端口随机，存储按「地址+端口」
 * 隔离，重启就丢。所以由服务端记住，网页版和桌面版行为一致。
 */
function saveSettings(patch) {
  postJson('/api/settings', patch).catch(() => {
    /* 静默失败：记不住设置不该影响正常使用 */
  });
}

/** 外观写在 <html> 上，CSS 按属性切换整套颜色变量。 */
function applyAppearance() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.palette = state.palette;
  document.querySelectorAll('#theme-switch .theme-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeValue === state.theme);
  });
}

function bindAppearance() {
  $('theme-switch').addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-value]');
    if (!button) return;
    state.theme = button.dataset.themeValue;
    applyAppearance();
    saveSettings({ theme: state.theme });
    if (state.activity) renderHeatmap();
  });
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

function formatLocalDate(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
}

function formatLocalTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSpan(seconds) {
  if (seconds == null) return '—';
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes} 分 ${seconds % 60} 秒`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function countdownText(startSeconds, durationSeconds) {
  const now = Date.now() / 1000;
  if (now < startSeconds) {
    const diff = Math.round(startSeconds - now);
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    if (days > 0) return `还有 ${days} 天 ${hours} 小时`;
    if (hours > 0) return `还有 ${hours} 小时 ${minutes} 分`;
    return `还有 ${minutes} 分钟`;
  }
  if (now < startSeconds + durationSeconds) return '正在进行';
  return '已结束';
}

/**
 * 提示信息。以前只写进「账号」页那一行小字里——换成左边菜单分页之后，
 * 你在别的页面上就完全看不到错误了，所以现在同步弹一个浮层提示。
 */
function showHint(message, isError = false, action = null) {
  const el = $('handle-hint');
  if (el) {
    el.textContent = message;
    el.classList.toggle('error', isError);
  }
  toast(message, { error: isError, action });
}

/** 右下角浮层提示；带 action 时给一个按钮（比如「重试」）。 */
function toast(message, { error = false, action = null, timeout = 6000 } = {}) {
  const box = $('toast-box');
  if (!box) return;
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  const text = document.createElement('span');
  text.textContent = message;
  item.appendChild(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      item.remove();
      action.run();
    });
    item.appendChild(button);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '✕';
  close.title = '关掉';
  close.addEventListener('click', () => item.remove());
  item.appendChild(close);
  box.appendChild(item);
  if (timeout) {
    setTimeout(() => item.remove(), timeout);
  }
  // 最多留 3 条，多了把最旧的挤掉
  while (box.children.length > 3) box.firstElementChild.remove();
}

function renderStats(user) {
  const cards = [
    ['当前 rating', user.rating ?? '未定级', user.rank ?? '—'],
    ['历史最高', user.maxRating ?? '—', user.maxRank ?? '—'],
    ['通过题目', user.solvedCount, `共提交 ${user.submissionCount} 次`],
    ['做了没过的题', user.attemptedCount, '值得回头重做'],
  ];
  $('stats').innerHTML = cards
    .map(
      ([label, value, note]) => `
        <div class="stat">
          <div class="stat-label">${label}</div>
          <div class="stat-value" style="color:${typeof value === 'number' && label.includes('rating') ? ratingColor(value) : 'inherit'}">${value}</div>
          <div class="stat-note">${note ?? ''}</div>
        </div>`,
    )
    .join('');
}

function renderRatingChart(history) {
  const container = $('rating-chart');
  if (!history || history.length < 2) {
    container.innerHTML = '<p class="subtle">还没有 rated 比赛记录，先打几场再来。</p>';
    return;
  }

  const width = 1000;
  const height = 140;
  const pad = 8;
  const ratings = history.map((entry) => entry.rating);
  const min = Math.min(...ratings) - 50;
  const max = Math.max(...ratings) + 50;
  const span = Math.max(1, max - min);

  const points = history.map((entry, index) => {
    const x = pad + (index / (history.length - 1)) * (width - pad * 2);
    const y = height - pad - ((entry.rating - min) / span) * (height - pad * 2);
    return [x, y];
  });

  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  const last = points[points.length - 1];
  const color = ratingColor(history[history.length - 1].rating);

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35" />
          <stop offset="100%" stop-color="${color}" stop-opacity="0" />
        </linearGradient>
      </defs>
      <polygon points="${area}" fill="url(#fill)" />
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" />
      <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${color}" />
    </svg>
    <p class="subtle">共 ${history.length} 场 rated 比赛，最近一次 ${history[history.length - 1].rating} 分（${history[history.length - 1].name}）</p>
  `;
}

async function loadUser(force = false) {
  const handle = $('handle-input').value.trim();
  if (!handle) {
    showHint('先填一个 Codeforces 用户名吧。', true);
    return;
  }

  state.handle = handle;
  saveSettings({ handle });

  const button = $('load-btn');
  button.disabled = true;
  button.textContent = '加载中…';
  setStatus('正在从 Codeforces 抓取数据', { busy: true });
  showHint('正在抓取，第一次会比较慢（要下载全站题库）。');

  try {
    const { user } = await getJson(
      `/api/user?handle=${encodeURIComponent(handle)}${force ? '&refresh=1' : ''}`,
    );
    renderStats(user);
    renderRatingChart(user.ratingHistory);
    $('overview-handle').textContent = `${user.displayHandle} · 数据更新于 ${new Date(user.updatedAt).toLocaleString('zh-CN')}`;

    // 目标分数只在用户从没设过的时候才给建议值，
    // 否则每次加载账号都会把用户自己定的目标覆盖掉。
    if (!state.hasSavedTarget) {
      const suggested = Math.min(
        3500,
        Math.max(900, Math.round(((user.rating ?? 800) + 200) / 50) * 50),
      );
      $('target-input').value = suggested;
      $('target-range').value = suggested;
      state.target = suggested;
    }

    markViewReady('panel-overview');
    markViewReady('panel-target');
    setStatus(`已同步 ${user.displayHandle} 的数据`);
    showHint('数据抓好了，接着设定目标 rating 就行。');
    loadCalendar();
    loadActivity();
    loadBlocked();
    loadSolved();
    return true;
  } catch (error) {
    setStatus('抓取失败');
    showHint(error.message, true);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = '重新加载';
  }
}

async function generatePlan(force = false, { scroll = true } = {}) {
  if (!state.handle) return;

  const target = Number($('target-input').value);
  const weekly = Number($('weekly-input').value);
  if (!Number.isFinite(target) || target < 800 || target > 4000) {
    showHint('目标 rating 请填 800 到 4000 之间的数字。', true);
    return;
  }

  state.target = Math.round(target);
  state.weekly = Math.max(1, Math.round(weekly) || 10);
  state.hasSavedTarget = true;
  $('weekly-input-2').value = state.weekly;
  saveSettings({ handle: state.handle, target: state.target, weekly: state.weekly });

  const button = $('plan-btn');
  button.disabled = true;
  button.textContent = '生成中…';
  setStatus('正在生成训练计划', { busy: true });

  try {
    const data = await getJson(
      `/api/plan?handle=${encodeURIComponent(state.handle)}&target=${state.target}&weekly=${state.weekly}${force ? '&refresh=1' : ''}`,
    );
    state.planData = data.plan;
    state.done = new Set(data.done ?? []);
    state.doneAuto = new Set(data.doneAuto ?? []);
    // 手感反馈、热身包、复盘卡、临时加题：都跟着计划一起回来
    state.feedback = new Map((data.feedback ?? []).map((row) => [`${row.contestId}-${row.index}`, row.feel]));
    state.warmup = data.warmup ?? null;
    state.retro = data.retro ?? null;
    state.extraTasks = data.extraTasks ?? {};
    state.feedbackShiftValue = data.feedbackShift ?? 0;
    renderWarmup();
    // 计划是钉住的，服务端会告诉我们它是哪天定下来的；日程从这里开始排
    state.planStart = new Date(data.plan.generatedAt ?? Date.now());
    // 手动排进某天的补题（补题队列 → 排进今天）
    state.extras = data.extras ?? {};
    // 把各阶段的题目拍平成一条有序列表，按天排布要用
    state.planProblems = data.plan.stageList.flatMap((stage) =>
      stage.problems.map((problem) => ({ ...problem, stage: stage.index })),
    );
    renderPlan(data.plan);
    renderAxes(data.plan.axes ?? []);
    renderTags(data.plan.weakTags);
    markViewReady('panel-plan');
    markViewReady('panel-tags');
    setStatus('计划已生成');
    if (scroll) $('panel-plan').scrollIntoView({ behavior: 'smooth', block: 'start' });
    rebuildSchedule();
    loadVirtual();
    // 计划生成完顺带把补题队列刷新一下（提交记录可能刚同步过）
    loadReview();
    loadGrowth();
  } catch (error) {
    setStatus(`生成失败：${error.message}`);
    // 失败给一个「重试」按钮，网络抖一下不用自己再找按钮
    showHint(`生成训练计划失败：${error.message}`, true, {
      label: '重试',
      run: () => generatePlan(force, { scroll }),
    });
  } finally {
    button.disabled = false;
    button.textContent = '重新生成计划';
  }
}

function renderPlan(plan) {
  syncPlanFilterOptions(plan);
  const direction = plan.gap > 0 ? `目标 +${plan.gap}` : '巩固当前水平';
  // 完成情况：分成「自己勾的」和「提交记录里已经通过的」，后者是这版新加的自动打勾
  const totalPlanned = plan.stageList.reduce((sum, stage) => sum + stage.problems.length, 0);
  const doneCount = plan.stageList.reduce(
    (sum, stage) =>
      sum + stage.problems.filter((problem) => state.done.has(`${problem.contestId}-${problem.index}`)).length,
    0,
  );
  const autoCount = plan.stageList.reduce(
    (sum, stage) =>
      sum +
      stage.problems.filter((problem) => state.doneAuto.has(`${problem.contestId}-${problem.index}`)).length,
    0,
  );
  const progressLine = doneCount
    ? `已完成 ${doneCount}/${totalPlanned} 题${autoCount ? `（其中 ${autoCount} 题是提交记录里已经通过的，自动打勾）` : ''}。`
    : '';
  $('plan-summary').textContent =
    `当前 ${plan.current} 分 → 目标 ${plan.target} 分（${direction}）。` +
    `按每周 ${plan.weekly} 题估算，全程约 ${plan.totalNeeded} 题、${plan.weeks} 周，分 ${plan.stages} 个阶段推进。` +
    progressLine;

  // 「按天看」时整块换成按天分组的折叠列表，其它（摘要、说明）不变
  $('plan-stages').innerHTML = planByDay
    ? planByDayHtml()
    : plan.stageList
    .map((stage) => {
      const visible = stage.problems.filter(matchesPlanFilter);
      const rows = visible
        .map((problem) => problemRow(problem, stage.targetRating))
        .join('');

      const review = stage.review.length
        ? `<p class="subtle">做过但没通过的题（建议优先补齐）：</p>
           <table class="problem-table">${stage.review.map((problem) => problemRow(problem, stage.targetRating, `失败 ${problem.attempts} 次`)).join('')}</table>`
        : '';

      // 隐藏标签模式下，连「重点补强」那行一起换掉——它就是方向信息，
      // 留着等于把标签泄了。改成只说覆盖了几个方向、几个是盲区。
      const blindCount = stage.focusTags.filter((item) => item.kind === 'untouched').length;
      const focusLine = state.hideTags
        ? `<div class="focus-tags">
             <span class="stage-meta">这份计划覆盖 ${stage.axisPlan?.length ?? 0} 个算法方向${
               blindCount ? `，其中 ${blindCount} 个你还没碰过` : ''
             }。标签已隐藏，自己判断怎么做。</span>
           </div>`
        : `<div class="focus-tags">
             <span class="stage-meta">重点补强：</span>
             ${stage.focusTags
               .map(
                 (item) =>
                   `<span class="tag-pill" title="${escapeHtml(item.tag)}">${escapeHtml(
                     tagZh(item.tag),
                   )}<span class="pill-note">${KIND_LABEL[item.kind] ?? ''}</span></span>`,
               )
               .join('')}
           </div>`;

      const axisLine =
        !state.hideTags && stage.axisPlan?.length
          ? `<div class="axis-plan">${stage.axisPlan
              .map((row) => `${escapeHtml(row.axis)} ${row.count}`)
              .join(' · ')}</div>`
          : '';

      return `
        <div class="stage">
          <div class="stage-head">
            <div>
              <div class="stage-title">${stage.label} · 练 ${stage.band[0]} ~ ${stage.band[1]} 分</div>
              <div class="stage-meta">约 ${stage.count} 题 / ${stage.weeks} 周 · 该区间还有 ${stage.unsolvedSupply} 道你没做过的题${
                visible.length !== stage.problems.length ? ` · 筛选后显示 ${visible.length} 题` : ''
              }</div>
              ${axisLine}
            </div>
            <div class="stage-meta">目标水平 ${stage.targetRating}</div>
          </div>
          <div class="stage-body">
            ${focusLine}
            <table class="problem-table">${rows}</table>
            ${review}
          </div>
        </div>`;
    })
    .join('');

  $('plan-notes').innerHTML = plan.notes.map((note) => `<li>${note}</li>`).join('');
  updatePlanFilterCount();
}

function problemRow(problem, target, extraNote = '') {
  const key = `${problem.contestId}-${problem.index}`;
  const isDone = state.done.has(key);
  const isAuto = state.doneAuto.has(key);
  // 隐藏标签模式：题单里不显示这道题属于哪些方向，自己判断怎么做
  const tags = state.hideTags ? '' : tagSpans(problem.tags, 3);
  const elsewhere = state.luoguKeys.has(key)
    ? '<span class="solved-elsewhere">洛谷做过</span>'
    : '';
  const source = platformBadge(problem);
  // 自动打勾的题单独标一下，免得看着像自己什么时候点过
  const autoBadge = isAuto
    ? '<span class="auto-done" title="提交记录里已经通过了这道题，自动打勾">已通过</span>'
    : '';
  const swapButton = problem.swappedFrom
    ? `<button type="button" class="swap-btn" data-swap-undo="${problem.swappedFrom}" title="换回系统推荐的那道题">还原</button>`
    : `<button type="button" class="swap-btn" data-swap-key="${key}" title="换一道同方向、难度差不多的题">换一道</button>`;
  // 「放到最后」会真的改顺序（日程也跟着变），不是只改显示
  const deferButton = problem.deferred
    ? `<button type="button" class="swap-btn" data-defer-undo="${key}" title="取消「放到最后」">取消</button>`
    : `<button type="button" class="swap-btn" data-defer-key="${key}" title="挪到本阶段最后再做">放最后</button>`;
  const deferredTag = problem.deferred ? '<span class="deferred-tag">已放最后</span>' : '';
  return `
    <tr class="${isDone ? 'done' : ''}" data-key="${key}"${problem.swappedFrom ? ` data-swapped-from="${problem.swappedFrom}"` : ''}>
      <td style="width:28px">
        <input type="checkbox" ${isDone ? 'checked' : ''}
               data-contest="${problem.contestId}" data-index="${problem.index}" />
      </td>
      <td class="problem-code">${problemCodeText(problem)}</td>
      <td>
        <a class="problem-name" href="${problemHref(problem)}" target="_blank" rel="noreferrer">${problem.name}</a>${source}${elsewhere}${autoBadge}${deferredTag}
        ${
          tags || extraNote
            ? `<div class="problem-tags">${tags}${tags && extraNote ? ' · ' : ''}${extraNote}</div>`
            : ''
        }
      </td>
      <td style="width:70px">${ratingBadge(problem.rating)}</td>
      <td style="width:90px" class="problem-tags">${solvedCountText(problem)}</td>
      <td style="width:44px">
        <button type="button" class="block-btn" data-block-key="${key}"
                data-block-contest="${problem.contestId}" data-block-index="${problem.index}"
                data-block-name="${escapeHtml(problem.name)}" data-block-rating="${problem.rating ?? ''}"
                title="永久屏蔽这道题，以后不再推荐">✕</button>
      </td>
      <td style="width:150px"><div class="row-actions">${swapButton}${deferButton}</div></td>
    </tr>`;
}

const KIND_LABEL = {
  untouched: '未接触',
  weak: '偏弱',
  slight: '略有欠缺',
  strong: '已达标',
};

/** 8 个知识方向的能力画像。柱长用固定刻度，方便跨时间对比。 */
function renderAxes(axes) {
  if (!axes.length) {
    $('axis-list').innerHTML = '<p class="subtle">还没有可用的过题数据。</p>';
    return;
  }
  const AXIS_MIN = 800;
  const AXIS_MAX = 3000;

  $('axis-list').innerHTML = axes
    .map((entry) => {
      const has = entry.representative != null;
      const percent = has
        ? Math.max(3, Math.min(100, ((entry.representative - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)) * 100))
        : 0;
      const gap = entry.gapVsSelf;
      const note = has
        ? `${entry.representative} · ${gap >= 0 ? '+' : ''}${gap} · ${entry.count} 题`
        : '还没接触过';
      const noteClass = has ? (gap >= 0 ? 'above' : 'below') : '';
      return `
        <div class="axis-row">
          <span>${entry.axis}</span>
          <div class="axis-track ${has ? '' : 'empty'}">${has ? `<span style="width:${percent}%"></span>` : ''}</div>
          <span class="axis-note ${noteClass}">${note}</span>
        </div>`;
    })
    .join('');
}

function renderTags(weakTags) {
  if (!weakTags?.length) {
    $('tag-list').innerHTML = '<p class="subtle">没有可分析的数据。</p>';
    return;
  }
  $('tag-list').innerHTML = weakTags
    .map((entry) => {
      const detail =
        entry.kind === 'untouched'
          ? '一道都没做过'
          : `做过 ${entry.solvedCount} 题 · 75 分位 ${entry.representative} · 最高 ${entry.maxRating}`;
      return `
        <div class="tag-row">
          <span title="${escapeHtml(entry.tag)}">${escapeHtml(tagZh(entry.tag))}<span class="pill-note">${KIND_LABEL[entry.kind] ?? ''}</span></span>
          <div class="tag-bar"><span style="width:${Math.max(3, entry.weakness)}%"></span></div>
          <span class="problem-tags">${detail}</span>
        </div>`;
    })
    .join('');
}

/**
 * 勾选 / 取消一道题。训练计划里的勾和「今天」卡片里的勾走同一条路。
 *
 * 勾完立刻重画计划摘要和今天卡片（进度条马上跟着变），但**不重排日程**：
 * 日程是按计划定下来的那天排的，勾掉一题不该让别的题往前挪位置。
 */
async function markProblemDone(contestId, index, done) {
  const key = `${contestId}-${index}`;
  if (done) state.done.add(key);
  else state.done.delete(key);
  // 手动动过之后就不再算「提交记录里自动通过的」，把那个徽章去掉
  state.doneAuto.delete(key);
  if (state.planData) renderPlan(state.planData);
  renderTodayCard();

  try {
    await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: state.handle, target: state.target, contestId, index, done }),
    });
  } catch {
    setStatus('进度保存失败，本地勾选仍在');
  }
}

$('plan-stages').addEventListener('change', (event) => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  markProblemDone(Number(checkbox.dataset.contest), checkbox.dataset.index, checkbox.checked);
});

$('today-card').addEventListener('change', (event) => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  markProblemDone(Number(checkbox.dataset.contest), checkbox.dataset.index, checkbox.checked);
});

// 今日卡片里除了打勾，还有三个动作：标手感、复制题单、补一个方向
$('today-card').addEventListener('click', async (event) => {
  const feel = event.target.closest('[data-feel]');
  if (feel) {
    const key = feel.dataset.feelKey;
    const dash = key.indexOf('-');
    sendFeedback(Number(key.slice(0, dash)), key.slice(dash + 1), feel.dataset.feel);
    return;
  }
  if (event.target.closest('#copy-today')) {
    copyTodayList();
    return;
  }
  const add = event.target.closest('#extra-add');
  if (add) {
    const axis = $('extra-axis')?.value;
    if (!axis || !state.handle) return;
    add.disabled = true;
    add.textContent = '正在挑题…';
    try {
      const result = await postJson('/api/plan/extra', {
        handle: state.handle,
        axis,
        date: dateKey(new Date()),
        exclude: state.planProblems.map((problem) => `${problem.contestId}-${problem.index}`),
      });
      toast(`已给今天加了 ${result.problems.length} 道「${axis}」的题。`);
      await generatePlan(false, { scroll: false });
    } catch (error) {
      toast(`加题失败：${error.message}`, { error: true });
    } finally {
      add.disabled = false;
      add.textContent = '今天补一个方向';
    }
  }
});

$('handle-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadUser();
});
// ---------- 永久屏蔽题目 ----------
// 有些题就是不想再做（题目本身有问题、或者不符合你的训练方向）。
// 屏蔽后不会再出现在任何推荐里，但随时可以在设置里恢复。

/**
 * 题号显示：Codeforces 是 1234A，AtCoder 是 ABC300E。
 * 服务端会给好 code，老数据没有这个字段就退回「比赛号 + 题号」。
 */
function problemCodeText(problem) {
  return problem.code ?? `${problem.contestId}${problem.index}`;
}

/** 题目链接：服务端按平台给好了 url，没有就退回 Codeforces 的地址。 */
function problemHref(problem) {
  return (
    problem.url ?? `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`
  );
}

/**
 * 来源角标。CF 的题不标（那是主场，标了反而吵），只标 AtCoder。
 * 鼠标悬停能看到 AtCoder 自己的难度值，方便核对折算对不对。
 */
function platformBadge(problem) {
  if (problem.platform === 'atcoder') {
    const raw = problem.nativeRating != null ? `（AtCoder 难度 ${problem.nativeRating}）` : '';
    return `<span class="platform-tag" title="AtCoder 题${raw}，已折算成练习区间里的分值">AtCoder</span>`;
  }
  if (problem.platform === 'luogu') {
    // LUOGU_SHORT 就是平台数据那儿用的那套难度名，这里复用它，两处别写两套
    const level = LUOGU_SHORT[problem.nativeRating];
    const raw = level ? `（洛谷难度：${level}）` : '';
    return `<span class="platform-tag" title="洛谷题${raw}，已折算成练习区间里的分值">洛谷</span>`;
  }
  return '';
}

/**
 * 题单里那一列「多少人过」。
 * AtCoder 那边我们只抓了难度、没抓过题人数，就显示它自己的难度值——
 * 空着或者写「0 人过」都不对。
 */
function solvedCountText(problem) {
  if (problem.platform === 'atcoder') {
    return problem.nativeRating != null
      ? `<span title="AtCoder 自己的难度估计（Kenkoooo），折算成练习分值是 ${problem.rating}">ATC ${problem.nativeRating}</span>`
      : '—';
  }
  if (problem.platform === 'luogu') {
    const level = LUOGU_SHORT[problem.nativeRating] ?? '';
    return problem.solvedCount
      ? `<span title="洛谷上的通过提交数，难度档：${level}">${problem.solvedCount} 次通过</span>`
      : `<span title="洛谷难度档：${level}">${level}</span>`;
  }
  return `${problem.solvedCount} 人过`;
}

async function loadBlocked() {
  if (!state.handle) return;
  try {
    const { blocked } = await getJson(`/api/blocked?handle=${encodeURIComponent(state.handle)}`);
    state.blocked = blocked;
    renderBlockedList();
  } catch {
    /* 读不到就先不显示 */
  }
}

function renderBlockedList() {
  const box = $('blocked-list');
  if (!state.blocked?.length) {
    box.innerHTML =
      '<p class="subtle">还没有屏蔽任何题目。在训练计划里点题目右侧的 ✕ 就能永久屏蔽。</p>';
    return;
  }
  box.innerHTML = state.blocked
    .map(
      (item) => `<div class="record-row">
        <span class="record-time">${new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
        <span class="record-name">
          <span class="record-code">${problemCodeText(item)}</span>
          <a href="${problemHref(item)}"
             target="_blank" rel="noreferrer">${escapeHtml(item.name ?? '（题库里没有这道题）')}</a>${platformBadge(item)}
        </span>
        <span>${ratingBadge(item.rating)}</span>
        <button type="button" class="btn" data-unblock-contest="${item.contestId}"
                data-unblock-index="${item.index}" style="padding:4px 10px;font-size:12px">恢复</button>
      </div>`,
    )
    .join('');
}

// ---------- 成长报告 ----------
// 按周看做题量和平均难度，并把每场 rated 比赛标出来，附上赛前两周的训练量。
// 目的就一个：让你自己看出「练得多 → 涨分」还是「停一阵 → 掉分」。

async function loadGrowth() {
  if (!state.handle) return;
  try {
    state.growth = await getJson(`/api/growth?handle=${encodeURIComponent(state.handle)}&weeks=26`);
    renderGrowth();
    markViewReady('panel-growth');
    loadHandles();
  } catch {
    /* 读不到就先不显示 */
  }
}

// ---------- 多账号 ----------
// 数据本来就是按账号分开存在库里的，这里只是「记住用过谁」+ 提供切换和对比入口。

async function loadHandles() {
  try {
    const { handles } = await getJson('/api/handles');
    state.handles = handles ?? [];
  } catch {
    state.handles = [];
  }
  const switcher = $('handle-switch');
  const known = $('compare-known');
  if (!switcher || !known) return;

  const current = (state.handle ?? '').toLowerCase();
  switcher.innerHTML = state.handles
    .map(
      (item) =>
        `<option value="${escapeHtml(item.handleKey)}" ${item.handleKey === current ? 'selected' : ''}>${escapeHtml(
          item.display,
        )}</option>`,
    )
    .join('');
  if (!state.handles.length) switcher.innerHTML = '<option value="">还没有账号</option>';

  // 对比那一栏是手打 ID 的输入框，这里只是把「本机加载过的其他账号」做成候选，
  // 点一下就能填进去。没加载过的账号照样能直接打名字。
  known.innerHTML =
    state.handles
      .filter((item) => item.handleKey !== current)
      .map(
        (item) =>
          `<option value="${escapeHtml(item.handleKey)}">${escapeHtml(item.display)}</option>`,
      )
      .join('');
}

$('handle-switch').addEventListener('change', async (event) => {
  const handle = event.target.value;
  if (!handle || handle === (state.handle ?? '').toLowerCase()) return;
  $('handle-input').value = handle;
  // 切换账号只是换当前用哪个：设置、计划、进度都是按账号存的，互不影响
  saveSettings({ handle });
  // 上一个人的对比结果要先清掉，否则看着像是新账号比出来的
  state.compare = null;
  state.compareOther = null;
  $('compare-input').value = '';
  renderCompare();
  await loadUser(true);
  // 计划、日程、成长都是按账号算出来的，切完必须重来一遍，
  // 不然这几块还显示着上一个人的数据，得等手动点「重新生成计划」才对。
  if (state.hasSavedTarget) await generatePlan(false, { scroll: false });
  setStatus(`已切换到 ${handle}`);
});

// 「清除对比」之后要把这句提示恢复成默认的，否则界面上还留着上一对账号的名字
const COMPARE_HINT_DEFAULT = $('compare-hint').textContent.replace(/\s+/g, ' ').trim();

async function loadCompare(rawOther) {
  const other = String(rawOther ?? '').trim();
  const current = (state.handle ?? '').toLowerCase();

  if (!other || !state.handle) {
    state.compare = null;
    state.compareOther = null;
    $('compare-result').innerHTML = '';
    $('compare-hint').textContent = COMPARE_HINT_DEFAULT;
    renderGrowth();
    return;
  }
  if (other.toLowerCase() === current) {
    showHint('这是当前账号自己，换成别人的 ID 吧。', true);
    return;
  }

  // 第一次比某个人的时候要现抓他的数据，会等几秒
  setStatus(`正在读 ${other} 的数据`, { busy: true });
  try {
    state.compare = await getJson(
      `/api/compare?handle=${encodeURIComponent(state.handle)}&other=${encodeURIComponent(other)}`,
    );
    state.compareOther = state.compare.other.handle;
    $('compare-input').value = state.compare.other.display;
    renderCompare();
    renderGrowth();
    setStatus(`已对比 ${state.compare.other.display}`);
    // 刚比过的人现在也算「用过的账号」，候选列表顺手补上
    loadHandles();
  } catch (error) {
    setStatus('对比失败');
    showHint(error.message, true);
  }
}

/** 涨分涂绿、掉分涂红；0 和没数据保持原色，涂绿会让人以为涨了。 */
function signedClass(value) {
  if (value == null || value === 0) return '';
  return value > 0 ? 'growth-up' : 'growth-down';
}

function renderCompare() {
  const data = state.compare;
  const box = $('compare-result');
  if (!data) {
    box.innerHTML = '';
    $('compare-hint').textContent = COMPARE_HINT_DEFAULT;
    return;
  }
  const axisRows = data.axes
    .map((row) => {
      const diff = row.diff;
      const diffText =
        diff == null
          ? '—'
          : `<span class="${signedClass(diff)}">${diff > 0 ? '+' : ''}${diff}</span>`;
      return `<tr>
        <td style="width:180px">${escapeHtml(row.axis)}</td>
        <td style="width:90px" class="problem-tags">${row.base ?? '—'}</td>
        <td style="width:90px" class="problem-tags">${row.other ?? '—'}</td>
        <td>${diffText}</td>
      </tr>`;
    })
    .join('');

  const sharedRows = data.shared
    // 题库里查不到的题（没难度没标签）不显示，只在下面那行提示里报个数
    .filter((row) => row.rating != null)
    .slice(0, 20)
    .map(
      (row) => `<tr>
        <td class="problem-code">${row.contestId}${row.index}</td>
        <td><a class="problem-name" href="https://codeforces.com/problemset/problem/${row.contestId}/${
          row.index
        }" target="_blank" rel="noreferrer">${escapeHtml(row.name)}</a></td>
        <td style="width:70px">${ratingBadge(row.rating)}</td>
        <td style="width:110px" class="problem-tags">${
          row.baseAt ? new Date(row.baseAt * 1000).toLocaleDateString('zh-CN') : '—'
        }</td>
        <td style="width:110px" class="problem-tags">${
          row.otherAt ? new Date(row.otherAt * 1000).toLocaleDateString('zh-CN') : '—'
        }</td>
        <td style="width:110px" class="problem-tags">${row.first === 'base' ? '我先' : '对方先'}</td>
      </tr>`,
    )
    .join('');

  $('compare-hint').textContent =
    `${data.base.display}（${data.base.rating ?? '—'} 分，通过 ${data.base.solvedCount} 题） 对比 ` +
    `${data.other.display}（${data.other.rating ?? '—'} 分，通过 ${data.other.solvedCount} 题）。` +
    `两人都做过的题 ${data.sharedCount} 道，下面列最近 20 道。`;

  box.innerHTML = `
    <table class="problem-table">
      <tr class="growth-head"><td>方向</td><td>${escapeHtml(data.base.display)}</td><td>${escapeHtml(
        data.other.display,
      )}</td><td>差</td></tr>
      ${axisRows}
    </table>
    ${
      data.shared.length
        ? `<h4 class="settings-sub">同一道题谁先做出来</h4>
           <table class="problem-table">
             <tr class="growth-head"><td>题号</td><td>题名</td><td>难度</td><td>${
               escapeHtml(data.base.display)
             }</td><td>${escapeHtml(data.other.display)}</td><td>谁先</td></tr>
             ${sharedRows}
           </table>`
        : '<p class="subtle">两个人还没有共同做过的题。</p>'
    }`;
}

$('compare-go').addEventListener('click', () => loadCompare($('compare-input').value));
$('compare-input').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  loadCompare($('compare-input').value);
});
$('compare-clear').addEventListener('click', () => {
  $('compare-input').value = '';
  loadCompare('');
});

function renderGrowth() {
  const data = state.growth;
  if (!data) return;
  const { weeks, contests, summary } = data;

  $('growth-summary').textContent =
    `最近 ${summary.weeks} 周共做 ${summary.solved} 题${
      summary.avgRating ? `，平均难度 ${summary.avgRating} 分` : ''
    }；同期打了 ${summary.contests} 场 rated，合计${
      summary.delta >= 0 ? `涨 ${summary.delta}` : `掉 ${Math.abs(summary.delta)}`
    } 分。`;

  // 柱状图：一根柱子一周，比赛用小圆点标在对应周上
  const width = 1000;
  const height = 190;
  const pad = 10;
  // 有对比账号时，两个账号共用同一个刻度，柱子才可比
  const otherWeeks = state.compare?.other?.weekly ?? null;
  const maxSolved = Math.max(
    1,
    ...weeks.map((row) => row.solved),
    ...(otherWeeks?.map((row) => row.solved) ?? []),
  );
  const slot = (width - pad * 2) / weeks.length;
  const barWidth = Math.max(4, slot * 0.62);
  const bars = weeks
    .map((row, index) => {
      const barHeight = (row.solved / maxSolved) * (height - pad * 3);
      const x = pad + index * slot + (slot - barWidth) / 2;
      const y = height - pad - barHeight;
      const color = row.avgRating ? ratingColor(row.avgRating) : 'var(--border)';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(
        1,
        barHeight,
      ).toFixed(1)}" rx="2" fill="${color}" opacity="0.75"><title>${row.week} 起这一周：${row.solved} 题${
        row.avgRating ? `，平均 ${row.avgRating} 分` : ''
      }</title></rect>`;
    })
    .join('');

  const markers = contests
    .map((contest) => {
      const index = weeks.findIndex((row) => row.week === contest.week);
      if (index < 0) return '';
      const x = pad + index * slot + slot / 2;
      const up = (contest.delta ?? 0) >= 0;
      const color = contest.delta == null ? 'var(--text-dim)' : up ? 'var(--ok-text, #4ade80)' : 'var(--danger)';
      const label = contest.delta == null ? '?' : `${up ? '+' : ''}${contest.delta}`;
      return `<g><circle cx="${x.toFixed(1)}" cy="${pad + 4}" r="3.5" fill="${color}" /><text x="${x.toFixed(
        1,
      )}" y="${pad - 2}" font-size="9" text-anchor="middle" fill="${color}">${label}</text><title>${
        contest.name
      }：${label} 分</title></g>`;
    })
    .join('');

  // 对比账号的每周题量画成一条细线，叠在同一张图上
  let compareLine = '';
  let compareNote = '';
  if (otherWeeks?.length) {
    const points = otherWeeks
      .map((row, index) => {
        const x = pad + index * slot + slot / 2;
        const y = height - pad - (row.solved / maxSolved) * (height - pad * 3);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    compareLine = `<polyline points="${points}" fill="none" stroke="var(--warn, #d9a441)" stroke-width="2" stroke-dasharray="5 3" />`;
    compareNote = `，虚线是 ${escapeHtml(state.compare.other.display)} 的每周题量`;
  }

  $('growth-chart').innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${bars}${compareLine}${markers}</svg>
    <p class="subtle">柱子是一周做通过的题数（颜色按当周平均难度），上面的小圆点是比赛，写着这场涨跌多少分${compareNote}。</p>
    <div class="reco-actions"><button type="button" class="btn small" id="export-growth">导出图片（SVG）</button></div>`;
  $('export-growth')?.addEventListener('click', exportChartSvg);
  if (data.conclusion) {
    $('growth-summary').textContent += ` ${data.conclusion}`;
  }

  if (!contests.length) {
    $('growth-contests').innerHTML = '<p class="subtle">最近这段时间没有 rated 比赛记录。</p>';
  } else {
    const rows = [...contests]
      .reverse()
      .map(
        (contest) => `<tr>
          <td><a class="problem-name" href="https://codeforces.com/contest/${contest.contestId}"
                 target="_blank" rel="noreferrer">${escapeHtml(contest.name || String(contest.contestId))}</a></td>
          <td class="problem-tags">${new Date(contest.at * 1000).toLocaleDateString('zh-CN')}</td>
          <td style="width:96px" class="${signedClass(contest.delta)}">${
            contest.delta == null ? '—' : `${contest.delta > 0 ? '+' : ''}${contest.delta}`
          }</td>
          <td style="width:120px" class="problem-tags">${
            contest.solvedBefore ? `${contest.solvedBefore} 题` : '没有记录'
          }</td>
          <td style="width:96px" class="problem-tags">${
            contest.avgRatingBefore ? `${contest.avgRatingBefore} 分` : '—'
          }</td>
          <td class="problem-tags">${contest.tag}</td>
        </tr>`,
      )
      .join('');
    $('growth-contests').innerHTML = `<table class="problem-table">
      <tr class="growth-head">
        <td>比赛</td><td>时间</td><td>分数变化</td><td>赛前两周题量</td><td>赛前两周难度</td><td>判断</td>
      </tr>${rows}</table>`;
  }

  if (data.axisTrend?.length) {
    $('growth-axes-hint').textContent = `对比 ${data.axisSnapshots} 周前和这一周的各方向 75 分位。`;
    $('growth-axes').innerHTML = `<table class="problem-table">${data.axisTrend
      .map(
        (row) => `<tr>
          <td style="width:160px">${escapeHtml(row.axis)}</td>
          <td style="width:90px" class="problem-tags">${row.before}</td>
          <td style="width:90px" class="problem-tags">${row.now}</td>
          <td class="${signedClass(row.change)}">${row.change > 0 ? '+' : ''}${row.change}</td>
        </tr>`,
      )
      .join('')}</table>`;
  } else {
    $('growth-axes-hint').textContent =
      '各方向 75 分位每周记一次，攒够两周才能看变化（现在是第 ' + (data.axisSnapshots ?? 0) + ' 份）。';
    $('growth-axes').innerHTML = '';
  }
}

// ---------- 补题队列 ----------
// 提交过但没通过的题单独排一队。数据就是 submissions 里没通过的那些，
// 所以「做出来了」会自动出队；这张列表只额外排掉你标过「已补」和被屏蔽的题。

async function loadReview() {
  if (!state.handle) return;
  try {
    const data = await getJson(
      `/api/review-queue?handle=${encodeURIComponent(state.handle)}&sort=${state.reviewSort}`,
    );
    state.review = data.items ?? [];
    renderReviewQueue();
    // 队列拿到数据以后这块面板才显示出来（和「做题记录」一样的做法）
    markViewReady('panel-review');
  } catch {
    /* 读不到就先不显示 */
  }
}

/** 「补题队列」面板的列表。名字带 Queue，别和虚拟参赛那边的 renderReview 撞了。 */
function renderReviewQueue() {
  const box = $('review-list');
  if (!box) return;
  const items = state.review ?? [];
  $('review-summary').textContent = items.length
    ? `提交过但没通过的题有 ${items.length} 道。补出来的会自动出队；暂时不想看就点「已补」。`
    : '这一队是空的：提交过但没通过的题都处理完了。';

  box.innerHTML = items
    .map(
      (item) => `<div class="review-row">
        <span class="record-code">${item.contestId}${item.index}</span>
        <span class="record-name">
          <a href="${item.url}"
             target="_blank" rel="noreferrer">${escapeHtml(item.name)}</a>
        </span>
        <span>${ratingBadge(item.rating)}</span>
        <span class="problem-tags">失败 ${item.attempts} 次${
          item.idleDays != null ? ` · 搁置 ${item.idleDays} 天` : ''
        }</span>
        <button type="button" class="btn" data-review-today="${item.contestId}-${item.index}"
                style="padding:4px 10px;font-size:12px">排进今天</button>
        <button type="button" class="btn" data-review-done="${item.contestId}-${item.index}"
                style="padding:4px 10px;font-size:12px">已补</button>
      </div>`,
    )
    .join('');
}

$('review-toolbar').addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-sort]');
  if (!button) return;
  state.reviewSort = button.dataset.reviewSort;
  document
    .querySelectorAll('#review-toolbar [data-review-sort]')
    .forEach((el) => el.classList.toggle('active', el === button));
  loadReview();
});

$('review-list').addEventListener('click', async (event) => {
  const doneButton = event.target.closest('[data-review-done]');
  const todayButton = event.target.closest('[data-review-today]');
  if (!doneButton && !todayButton) return;
  const key = doneButton ? doneButton.dataset.reviewDone : todayButton.dataset.reviewToday;
  const contestId = Number(key.slice(0, key.indexOf('-')));
  const index = key.slice(key.indexOf('-') + 1);

  try {
    if (doneButton) {
      await postJson('/api/review-queue/done', {
        handle: state.handle,
        contestId,
        index,
        done: true,
      });
      setStatus('已从补题队列移出');
      await loadReview();
      return;
    }

    // 排进今天：写进日程的额外安排，日程和「今天」卡片都会带上它
    const today = dateKey(new Date());
    await postJson('/api/schedule/extra', { handle: state.handle, date: today, contestId, index });
    setStatus('已排进今天');
    await loadReview();
    if (state.planData) {
      // 重新拉一次计划，把 extras 带回来（比在前端拼一份更省心）
      await generatePlan(false, { scroll: false });
    }
  } catch (error) {
    setStatus('操作失败');
    showHint(error.message, true);
  }
});

/** 做过的题：按首次通过时间从近到远，每次加载 100 道。 */
function renderSolved() {
  const list = state.solved ?? [];
  // 题库里查不到的题（gym、很早的比赛）没有难度和标签，刷训练记录没意义：
  // 列表里不显示，只在上面标一句有多少道，避免看着像数据丢了。
  const visible = list.filter((item) => item.rating != null);
  const missing = list.length - visible.length;
  $('solved-summary').textContent =
    `一共通过 ${state.solvedTotal} 道题，下面是最近的 ${visible.length} 道（按通过时间从近到远）。` +
    (missing ? `另有 ${missing} 道题在题库里查不到（没有难度标签），已隐藏。` : '');
  $('solved-list').innerHTML = visible
    .map(
      (item) => `<div class="record-row">
        <span class="record-time">${new Date(item.firstAcAt * 1000).toLocaleDateString('zh-CN')}</span>
        <span class="record-name">
          <span class="record-code">${problemCodeText(item)}</span>
          <a href="${problemHref(item)}"
             target="_blank" rel="noreferrer">${escapeHtml(item.name ?? '（题库里没有这道题）')}</a>${platformBadge(item)}
        </span>
        <span>${ratingBadge(item.rating)}</span>
        <span class="problem-tags">${tagSpans(item.tags, 2)}</span>
      </div>`,
    )
    .join('');
  $('solved-more').classList.toggle('hidden', list.length >= state.solvedTotal);
}

async function loadSolved({ append = false } = {}) {
  if (!state.handle) return;
  try {
    const offset = append ? state.solved.length : 0;
    const data = await getJson(
      `/api/solved?handle=${encodeURIComponent(state.handle)}&limit=100&offset=${offset}`,
    );
    state.solved = append ? [...state.solved, ...data.solved] : data.solved;
    state.solvedTotal = data.total;
    renderSolved();
    markViewReady('panel-records');
  } catch (error) {
    markViewReady('panel-records');
    $('solved-summary').textContent = `读取做题记录失败：${error.message}`;
  }
}

$('solved-more').addEventListener('click', () => loadSolved({ append: true }));

async function blockProblem(problem) {
  if (!state.handle) return;
  setStatus('正在屏蔽这道题', { busy: true });
  try {
    await postJson('/api/blocked', {
      handle: state.handle,
      contestId: problem.contestId,
      index: problem.index,
      name: problem.name,
      rating: problem.rating,
    });
    await loadBlocked();
    await generatePlan(false, { scroll: false });
    setStatus('已屏蔽，这道题不会再出现');
  } catch (error) {
    setStatus('屏蔽失败');
    showHint(error.message, true);
  }
}

$('plan-stages').addEventListener('click', (event) => {
  // 换一道 / 还原，两个按钮都在同一张表里
  const swap = event.target.closest('[data-swap-key]');
  if (swap) {
    swapProblem(swap.dataset.swapKey);
    return;
  }
  const undo = event.target.closest('[data-swap-undo]');
  if (undo) {
    undoSwap(undo.dataset.swapUndo);
    return;
  }
  const defer = event.target.closest('[data-defer-key]');
  if (defer) {
    setDeferred(defer.dataset.deferKey, true);
    return;
  }
  const undefer = event.target.closest('[data-defer-undo]');
  if (undefer) {
    setDeferred(undefer.dataset.deferUndo, false);
    return;
  }
  const button = event.target.closest('[data-block-key]');
  if (!button) return;
  blockProblem({
    contestId: Number(button.dataset.blockContest),
    index: button.dataset.blockIndex,
    name: button.dataset.blockName,
    rating: button.dataset.blockRating ? Number(button.dataset.blockRating) : null,
  });
});

// ---------- 换一道题 ----------
// 计划里每道题右边有个「换一道」：同方向、难度最接近、你还没做过、也不在现有计划里。
// 换过之后记在后台（plan_swaps），重新生成计划时也会换回去，不会被冲掉。

/** 把某一行换成新题，然后重画计划表和日程。 */
function applySwap(fromKey, nextProblem) {
  if (!state.planData || !nextProblem) return;
  for (const stage of state.planData.stageList) {
    const at = stage.problems.findIndex((problem) => `${problem.contestId}-${problem.index}` === fromKey);
    if (at >= 0) {
      stage.problems[at] = nextProblem;
      break;
    }
  }
  state.planProblems = state.planData.stageList.flatMap((stage) =>
    stage.problems.map((problem) => ({ ...problem, stage: stage.index })),
  );
  renderPlan(state.planData);
  rebuildSchedule();
}

async function swapProblem(key) {
  if (!state.handle) return;
  const dash = key.indexOf('-');
  const contestId = Number(key.slice(0, dash));
  const index = key.slice(dash + 1);
  setStatus('正在挑一道替换的题…', { busy: true });
  try {
    const data = await postJson('/api/plan/replace', {
      handle: state.handle,
      target: state.target,
      contestId,
      index,
      // 现成计划里已有的题不能重复出现，交给后端排掉
      exclude: state.planProblems.map((problem) => `${problem.contestId}-${problem.index}`),
    });
    applySwap(data.fromKey, data.problem);
    setStatus(`已换成 ${data.problem.contestId}${data.problem.index}`);
    // 同一道题反复换的话，直接建议屏蔽——一直换说明它不适合你
    if (data.hint) showHint(data.hint, false);
  } catch (error) {
    setStatus('没有换成功');
    showHint(error.message, true);
  }
}

async function undoSwap(fromKey) {
  if (!state.handle) return;
  try {
    await postJson('/api/plan/swap/clear', {
      handle: state.handle,
      target: state.target,
      fromKey,
    });
    await generatePlan(false, { scroll: false });
    setStatus('已换回系统推荐的题');
  } catch (error) {
    setStatus('还原失败');
    showHint(error.message, true);
  }
}

/**
 * 放到本阶段最后 / 取消。
 *
 * 顺序在服务端重排（不是前端假装的），所以日程会跟着变——这正是用户要的效果：
 * 今天不想做的那道，推到这一阶段后面去。
 */
async function setDeferred(key, deferred) {
  if (!state.handle) return;
  try {
    await postJson('/api/plan/defer', {
      handle: state.handle,
      target: state.target,
      key,
      deferred,
    });
    await generatePlan(false, { scroll: false });
    setStatus(deferred ? '已放到本阶段最后' : '已取消「放到最后」');
  } catch (error) {
    setStatus('操作失败');
    showHint(error.message, true);
  }
}

$('blocked-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-unblock-contest]');
  if (!button || !state.handle) return;
  try {
    await fetch('/api/blocked', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: state.handle,
        contestId: Number(button.dataset.unblockContest),
        index: button.dataset.unblockIndex,
      }),
    });
    await loadBlocked();
    await generatePlan(false, { scroll: false });
    setStatus('已恢复推荐');
  } catch {
    setStatus('恢复失败');
  }
});

$('load-btn').addEventListener('click', () => loadUser(false));
// 这个按钮是「重新挑一批题」，要绕开计划快照，不能只是刷新一下
$('plan-btn').addEventListener('click', () => generatePlan(true));

$('target-range').addEventListener('input', (event) => {
  $('target-input').value = event.target.value;
  state.target = Number(event.target.value);
});
$('target-input').addEventListener('input', (event) => {
  $('target-range').value = event.target.value;
});

function renderQuickPicks() {
  const picks = [800, 1200, 1400, 1600, 1900, 2100, 2400];
  $('quick-picks').innerHTML = picks
    .map((value) => `<span class="chip" data-target="${value}" style="border-color:${ratingColor(value)}55">${value}</span>`)
    .join('');
}

$('quick-picks').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  const value = Number(chip.dataset.target);
  $('target-input').value = value;
  $('target-range').value = value;
  state.target = value;
});

renderQuickPicks();

// ---------- 比赛日历 ----------

let countdownInterval = null;

async function loadCalendar() {
  markViewReady('panel-calendar');
  try {
    const query = state.handle ? `?handle=${encodeURIComponent(state.handle)}` : '';
    renderCalendar(await getJson(`/api/calendar${query}`));
  } catch (error) {
    $('calendar-summary').textContent = `赛程加载失败：${error.message}`;
    $('calendar-list').innerHTML = '';
  }
}

function renderCalendar(data) {
  $('calendar-summary').textContent = data.upcoming.length
    ? `未来 ${data.days} 天有 ${data.upcoming.length} 场 Codeforces 比赛（时间已换算成本机时区）。`
    : `未来 ${data.days} 天还没有已公布的比赛。Codeforces 一般提前几天放出赛程，过阵子再看看。`;

  $('calendar-list').innerHTML = data.upcoming.length
    ? data.upcoming
        .map((contest) => {
          const fit = contest.fit;
          return `
            <div class="contest-row">
              <div class="contest-when">
                <strong>${formatLocalDate(contest.startTime)}</strong>
                ${formatLocalTime(contest.startTime)} · ${(contest.durationSeconds / 3600).toFixed(1)} 小时
              </div>
              <div class="contest-name">
                <a href="${contest.url}" target="_blank" rel="noreferrer">${contest.name}</a>
                <div class="contest-meta">${contest.division}</div>
              </div>
              <div class="contest-tail">
                ${fit ? `<span class="fit-badge fit-${fit.tone}">${fit.label}</span>` : ''}
                <div class="countdown" data-start="${contest.startTime}" data-duration="${contest.durationSeconds}">
                  ${countdownText(contest.startTime, contest.durationSeconds)}
                </div>
              </div>
            </div>`;
        })
        .join('')
    : '<p class="subtle">暂无赛程。</p>';

  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    document.querySelectorAll('.countdown').forEach((element) => {
      element.textContent = countdownText(
        Number(element.dataset.start),
        Number(element.dataset.duration),
      );
    });
  }, 30000);
}

// ---------- 虚拟参赛 ----------

let timerInterval = null;

async function loadVirtual({ reviewId = 0 } = {}) {
  if (!state.handle) return;
  try {
    const suffix = reviewId ? `&reviewId=${reviewId}` : '';
    const data = await getJson(
      `/api/virtual?handle=${encodeURIComponent(state.handle)}&target=${state.target}${suffix}`,
    );
    renderVirtual(data);
  } catch (error) {
    markViewReady('panel-virtual');
    $('virtual-summary').textContent = `虚拟参赛加载失败：${error.message}`;
  }
}

function renderVirtual(data) {
  state.virtual = data;
  const running = data.running ?? null;
  markViewReady('panel-virtual');

  $('virtual-summary').textContent = running
    ? '虚拟赛进行中。做完一题就去 Codeforces 提交，提交记录会自动同步回来做复盘。'
    : `按你的目标 ${data.target} 分和薄弱专题，从已结束的比赛里挑出这些场次。`;

  $('virtual-running').innerHTML = running ? renderRunning(running) : '';
  $('virtual-recommend').innerHTML = running ? '' : renderRecommendations(data.recommendations);
  $('virtual-review').innerHTML = !running && data.review ? renderReview(data.review) : '';
  $('virtual-history').innerHTML = renderHistory(data.history);

  startTimerBar(running);
}

function renderRunning(running) {
  const { session, contest, problems } = running;
  const total = session.durationSeconds;
  const elapsed = Math.max(0, Math.min(total, (Date.now() - session.startedAt) / 1000));

  const rows = problems
    .map(
      (problem) => `
        <tr>
          <td class="problem-code">${problemCodeText(problem)}</td>
          <td><a class="problem-name" href="${problem.url}" target="_blank" rel="noreferrer">${problem.name}</a>
              <div class="problem-tags">${tagSpans(problem.tags, 3)}</div></td>
          <td style="width:70px">${ratingBadge(problem.rating)}</td>
          <td style="width:90px" class="problem-tags">${problem.solvedCount} 人过</td>
        </tr>`,
    )
    .join('');

  return `
    <div class="running-card">
      <div class="running-head">
        <div>
          <div class="stage-title">
            ${contest ? `<a class="problem-name" href="${contest.url}" target="_blank" rel="noreferrer">${contest.name}</a>` : '虚拟赛'}
          </div>
          <div class="stage-meta">${contest?.division ?? ''} · ${problems.length} 题 · 限时 ${(total / 3600).toFixed(1)} 小时</div>
        </div>
        <div class="running-clock" id="running-clock">${formatClock(running.remainingSeconds)}</div>
      </div>
      <div class="progress"><span id="running-progress" style="width:${Math.round((elapsed / total) * 100)}%"></span></div>
      <table class="problem-table">${rows}</table>
      <div class="reco-actions" style="margin-top:16px">
        <button class="btn" id="finish-btn">提前结束并复盘</button>
      </div>
    </div>`;
}

function renderRecommendations(list) {
  if (!list?.length) {
    return '<p class="subtle">暂时没有合适的场次。可能是目标区间里合适的比赛都打过了，调整一下目标 rating 再试。</p>';
  }
  return `
    <div class="stage-meta" style="margin-bottom:10px">推荐场次</div>
    <div class="recommend-grid">
      ${list
        .map(
          (contest) => `
        <div class="reco-card">
          <div class="reco-title">
            <a href="${contest.url}" target="_blank" rel="noreferrer">${contest.name}</a>
          </div>
          <div class="reco-facts">
            <span class="tag-pill">${contest.division}</span>
            <span class="tag-pill">${contest.problemCount} 题</span>
            <span class="tag-pill">难度 ${contest.minRating}~${contest.maxRating}</span>
            <span class="tag-pill">${contest.unsolvedCount} 题没做过</span>
          </div>
          <ul class="reco-reasons">${contest.reasons.map((reason) => `<li>${reason}</li>`).join('')}</ul>
          <div class="reco-actions">
            <button class="btn primary" data-start-contest="${contest.contestId}">开始虚拟赛</button>
            <a class="btn" href="${contest.url}" target="_blank" rel="noreferrer">查看比赛</a>
          </div>
        </div>`,
        )
        .join('')}
    </div>`;
}

function renderReview(review) {
  const stats = [
    ['解出题目', `${review.solvedCount} / ${review.rows.length}`, `共提交 ${review.submissionCount} 次`],
    ['难度加权', review.weightedScore, review.hardestSolved ? `最难题 ${review.hardestSolved} 分` : '没有解出'],
    ['用时', formatSpan(review.usedSeconds), '最后一次提交'],
    [
      '卡住的题',
      `${review.attemptedCount} 题`,
      review.untouchedCount ? `另外 ${review.untouchedCount} 题没碰` : '全部尝试过',
    ],
  ];

  const rows = review.rows
    .map((row) => {
      const label =
        row.status === 'solved'
          ? `解出 · ${formatSpan(row.elapsedSeconds)}`
          : row.status === 'attempted'
            ? `失败 ${row.fails} 次`
            : '未尝试';
      return `
        <tr>
          <td style="width:96px">
            <span class="status-dot dot-${row.status}"></span><span class="problem-code">${row.contestId}${row.index}</span>
          </td>
          <td>
            <a class="problem-name" href="${row.url}" target="_blank" rel="noreferrer">${row.name}</a>
            <div class="problem-tags">${tagSpans(row.tags, 3)}</div>
          </td>
          <td style="width:70px">${ratingBadge(row.rating)}</td>
          <td style="width:120px" class="problem-tags">${label}</td>
        </tr>`;
    })
    .join('');

  return `
    <div class="panel-head sub">
      <h2>赛后复盘 · ${review.contestName}</h2>
      <p>${new Date(review.startedAt).toLocaleString('zh-CN')} 开始，限时 ${(review.durationSeconds / 3600).toFixed(1)} 小时</p>
    </div>
    <div class="review-grid">
      ${stats
        .map(
          ([label, value, note]) => `
        <div class="stat">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${value}</div>
          <div class="stat-note">${note}</div>
        </div>`,
        )
        .join('')}
    </div>
    ${review.highlights.length ? `<ul class="notes">${review.highlights.map((line) => `<li>${line}</li>`).join('')}</ul>` : ''}
    <table class="problem-table" style="margin-top:16px">${rows}</table>`;
}

function renderHistory(history) {
  if (!history?.length) return '';
  return `
    <div class="panel-head sub">
      <h2>往次虚拟赛</h2>
      <p>进度和复盘都存在本地，随时可以回看。</p>
    </div>
    ${history
      .map(
        (session) => `
      <div class="history-row">
        <span>
          ${new Date(session.startedAt).toLocaleDateString('zh-CN')} · ${session.contestName}
          ${session.status === 'running' ? ' <span class="tag-pill">进行中</span>' : ''}
        </span>
        <span>
          <a class="problem-name" href="${session.url}" target="_blank" rel="noreferrer">比赛页</a>
          ${
            session.status === 'running'
              ? ''
              : `　<button class="btn" data-review="${session.id}" style="padding:4px 10px;font-size:12px">看复盘</button>`
          }
        </span>
      </div>`,
      )
      .join('')}`;
}

function startTimerBar(running) {
  const bar = $('timer-bar');
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (!running) {
    bar.classList.add('hidden');
    return;
  }

  const endsAt = running.session.startedAt + running.session.durationSeconds * 1000;
  const total = running.session.durationSeconds * 1000;
  $('timer-name').textContent = running.contest?.name ?? '虚拟赛';
  $('timer-link').href = running.contest?.url ?? 'https://codeforces.com';
  bar.classList.remove('hidden');

  const tick = () => {
    const remaining = Math.round((endsAt - Date.now()) / 1000);
    const text = remaining > 0 ? formatClock(remaining) : '时间到';

    $('timer-clock').textContent = text;
    $('timer-clock').classList.toggle('over', remaining <= 0);

    const panelClock = $('running-clock');
    if (panelClock) {
      panelClock.textContent = text;
      panelClock.classList.toggle('over', remaining <= 0);
    }
    const progress = $('running-progress');
    if (progress) {
      const used = Math.min(100, Math.max(0, ((total - remaining * 1000) / total) * 100));
      progress.style.width = `${used}%`;
    }
    if (remaining <= 0 && timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  };

  tick();
  timerInterval = setInterval(tick, 1000);
}

async function startVirtual(contestId) {
  setStatus('正在开赛', { busy: true });
  try {
    await postJson('/api/virtual/start', { handle: state.handle, contestId });
    await loadVirtual();
    setStatus('虚拟赛进行中');
    $('panel-virtual').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus('开赛失败');
    showHint(error.message, true);
  }
}

async function finishVirtual() {
  setStatus('正在复盘', { busy: true });
  try {
    await postJson('/api/virtual/finish', { handle: state.handle });
    await loadVirtual();
    setStatus('复盘完成');
    $('panel-virtual').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus('复盘失败');
    showHint(error.message, true);
  }
}

$('panel-virtual').addEventListener('click', (event) => {
  const startButton = event.target.closest('[data-start-contest]');
  if (startButton) {
    startVirtual(Number(startButton.dataset.startContest));
    return;
  }
  const reviewButton = event.target.closest('[data-review]');
  if (reviewButton) {
    loadVirtual({ reviewId: Number(reviewButton.dataset.review) });
    return;
  }
  if (event.target.closest('#finish-btn')) finishVirtual();
});

$('timer-finish').addEventListener('click', finishVirtual);

// ---------- 活动热力图 ----------

async function loadActivity() {
  if (!state.handle) return;
  try {
    // 按本机时区归日：数据库里存的是 UTC 秒，这里把偏移量传过去
    const offset = -new Date().getTimezoneOffset() * 60;
    const { activity } = await getJson(
      `/api/activity?handle=${encodeURIComponent(state.handle)}&offset=${offset}`,
    );
    state.activity = activity;
    renderHeatmap();
    markViewReady('panel-heatmap');
  } catch (error) {
    markViewReady('panel-heatmap');
    $('heatmap-summary').textContent = `活动记录加载失败：${error.message}`;
  }
}

/** 按分位数把每日数量分成 0~4 级，深浅随你自己的活跃度自适应。 */
function levelScale(counts) {
  const values = Object.values(counts).filter((n) => n > 0).sort((a, b) => a - b);
  if (!values.length) return () => 0;
  const pick = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
  const q1 = pick(0.25);
  const q2 = pick(0.5);
  const q3 = pick(0.75);
  return (n) => (n <= 0 ? 0 : n <= q1 ? 1 : n <= q2 ? 2 : n <= q3 ? 3 : 4);
}

function renderHeatmap() {
  if (!state.activity) return;
  const isSolved = state.heatmapMetric === 'solved';
  const counts = isSolved ? state.activity.solved : state.activity.submissions;
  const weeks = heatmapWeeks();
  const level = levelScale(counts);
  const unit = isSolved ? '题' : '次';

  const monthLabels = weeks.map((week) => {
    const first = parseDateKey(week[0].date);
    return first.getDate() <= 7 ? `${first.getMonth() + 1}月` : '';
  });

  // 只统计网格覆盖到的这一年，否则会把全部历史算进来，跟图上看到的对不上
  const rangeStart = weeks[0][0].date;
  const rangeEnd = dateKey(new Date());
  const inRange = Object.entries(counts).filter(([date]) => date >= rangeStart && date <= rangeEnd);
  const total = inRange.reduce((sum, [, n]) => sum + n, 0);
  const activeDays = inRange.filter(([, n]) => n > 0).length;
  const best = inRange.length ? Math.max(...inRange.map(([, n]) => n)) : 0;

  $('heatmap-summary').textContent = isSolved
    ? `这块图是最近一年（${rangeStart} 起）：通过 ${total} 道题，分布在 ${activeDays} 天里，单日最多 ${best} 题。`
    : `这块图是最近一年（${rangeStart} 起）：提交 ${total} 次，覆盖 ${activeDays} 天，单日最多 ${best} 次。`;

  const cells = weeks
    .map((week) => {
      const column = week
        .map((cell) => {
          if (cell.future) return '<div class="heatmap-cell" style="visibility:hidden"></div>';
          const n = counts[cell.date] ?? 0;
          return `<div class="heatmap-cell" data-level="${level(n)}" title="${cell.date} · ${n} ${unit}"></div>`;
        })
        .join('');
      return `<div class="heatmap-week">${column}</div>`;
    })
    .join('');

  const monthRow = monthLabels.map((label) => `<span>${label}</span>`).join('');
  $('heatmap-wrap').innerHTML = `
    <div class="heatmap-months">${monthRow}</div>
    <div class="heatmap-grid">${cells}</div>`;

  const legendCells = ['var(--hm-empty)', 'var(--hm1)', 'var(--hm2)', 'var(--hm3)', 'var(--hm4)']
    .map((color) => `<span class="heatmap-cell" style="background:${color}"></span>`)
    .join('');
  $('heatmap-legend').innerHTML =
    `<span>少</span>${legendCells}<span>多</span>` +
    `<span style="margin-left:10px">每天${isSolved ? '首次通过的题数' : '提交次数'}</span>`;

  const metricButtons = `
    <div class="theme-switch" style="margin-right:12px">
      <button type="button" class="theme-btn ${isSolved ? 'active' : ''}" data-metric="solved">过题数</button>
      <button type="button" class="theme-btn ${isSolved ? '' : 'active'}" data-metric="submissions">提交数</button>
    </div>`;
  const dots = Object.entries(PALETTE_COLORS)
    .map(([name, colors]) => {
      const active = state.palette === name ? 'active' : '';
      const style = `background:linear-gradient(135deg, ${colors[1]}, ${colors[3]})`;
      return `<button type="button" class="palette-dot ${active}" data-palette-value="${name}" title="${PALETTE_LABELS[name]}色" style="${style}"></button>`;
    })
    .join('');
  $('palette-switch').innerHTML = metricButtons + dots;
}

$('palette-switch').addEventListener('click', (event) => {
  const metric = event.target.closest('[data-metric]');
  if (metric) {
    state.heatmapMetric = metric.dataset.metric;
    renderHeatmap();
    return;
  }
  const dot = event.target.closest('[data-palette-value]');
  if (dot) {
    state.palette = dot.dataset.paletteValue;
    applyAppearance();
    renderHeatmap();
    saveSettings({ heatmapPalette: state.palette });
  }
});

// ---------- 训练日程 ----------

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text ?? '').replace(/[&<>"']/g, (char) => map[char]);
}

function formatMonthDay(key) {
  const date = parseDateKey(key);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_LABELS[date.getDay()]}`;
}

/** 落后天数：整数就不带小数点，「0.5」这种半天的差距也写出来。 */
function formatDays(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 「今天」卡片里的一行题，勾选用的属性和训练计划里的一致。 */
function todayRow(problem) {
  const key = `${problem.contestId}-${problem.index}`;
  const isDone = state.done.has(key);
  const isAuto = state.doneAuto.has(key);
  const tags = state.hideTags ? '' : tagSpans(problem.tags, 3);
  return `<div class="today-row ${isDone ? 'done' : ''}">
    <input type="checkbox" ${isDone ? 'checked' : ''}
           data-contest="${problem.contestId}" data-index="${problem.index}" />
    <span class="problem-code">${problemCodeText(problem)}</span>
    <span class="today-name">
      <a class="problem-name" href="${problemHref(problem)}" target="_blank" rel="noreferrer">${problem.name}</a>
      ${platformBadge(problem)}
      ${isAuto ? '<span class="auto-done" title="提交记录里已经通过了这道题，自动打勾">已通过</span>' : ''}
      ${state.luoguKeys.has(key) ? '<span class="solved-elsewhere">洛谷做过</span>' : ''}
      ${tags ? `<span class="today-tags">${tags}</span>` : ''}
    </span>
    <span class="today-stage">第 ${problem.stage ?? 1} 阶段</span>
    ${ratingBadge(problem.rating)}
    ${feedbackButtons(key)}
  </div>`;
}

/**
 * 「今天」这张卡片：今天做哪几题、做到哪了、距计划结束还有几天、已经落后几天。
 *
 * 数字都在 todayOverview() 里算（那里写了为什么这么算），这里只管摆放。
 * 卡片里的勾和训练计划里的勾是同一个动作，勾完进度条立刻变。
 */
function renderTodayCard() {
  const box = $('today-card');
  if (!box) return;
  box.classList.remove('hidden');

  if (!state.planData || !state.schedule) {
    box.innerHTML =
      '<div class="today-head"><span class="today-title">今天</span></div>' +
      '<p class="subtle">还没有训练计划。在下面的「设定目标」里填好目标分数、点「生成训练计划」，这里就会显示今天该做哪几题。</p>';
    return;
  }

  const now = new Date();
  const overview = todayOverview({
    problems: state.planProblems,
    weekly: state.weekly,
    restDays: state.restDays,
    dayOff: state.dayOff,
    startDate: state.planStart ?? now,
    today: now,
    doneKeys: state.done,
  });

  const total = overview.todayProblems.length;
  const doneToday = overview.todayDone;
  const allDone = overview.totalProblems > 0 && overview.doneCount >= overview.totalProblems;
  const behind = overview.behindDays;

  const head =
    '<div class="today-head">' +
    `<div class="today-when"><span class="today-title">今天</span>` +
    `<span class="today-date">${formatMonthDay(overview.todayKey)}</span></div>` +
    (total
      ? `<div class="today-progress">
           <div class="today-bar${doneToday === total ? ' full' : ''}">
             <span style="width:${Math.round((doneToday / total) * 100)}%"></span>
           </div>
           <span class="today-count"><b>${doneToday}</b>/${total} 题</span>
           <button type="button" class="btn small" id="copy-today">复制题单</button>
         </div>`
      : '') +
    '</div>';

  const nextText = overview.nextDay
    ? `，下一批在 ${formatMonthDay(overview.nextDay.date)}（${overview.nextDay.problems.length} 题）`
    : '';
  let body;
  if (total) {
    body = `<div class="today-list">${overview.todayProblems.map(todayRow).join('')}</div>`;
  } else if (overview.restDay) {
    body = `<p class="subtle">今天休息${
      overview.restDay.reason ? `（${escapeHtml(overview.restDay.reason)}）` : ''
    }${nextText}。</p>`;
  } else if (allDone) {
    body = '<p class="subtle">计划里的题都做完了。想再来一轮，就在「设定目标」里点「重新生成计划」。</p>';
  } else if (!overview.inRange) {
    body = '<p class="subtle">计划的排期已经走完了，但还有题没做完。点「重新生成计划」可以重新排一份。</p>';
  } else {
    body = '<p class="subtle">今天没有安排题目。</p>';
  }

  const deadline =
    overview.daysLeft > 0
      ? `距计划结束 <b>${overview.daysLeft}</b> 天`
      : overview.daysLeft === 0
        ? '今天是计划的最后一天'
        : `计划已到期 <b>${-overview.daysLeft}</b> 天`;

  const behindText = allDone
    ? '计划里的题都做完了'
    : behind >= 0.5
      ? `落后 <b>${formatDays(behind)}</b> 天（累计欠 ${overview.dueCount - overview.doneCount} 题）`
      : behind <= -0.5
        ? `超前 <b>${formatDays(-behind)}</b> 天`
        : '跟得上计划';
  const behindClass = behind >= 0.5 && !allDone ? 'warn' : 'ok';

  // 从补题队列「排进今天」的那几道：不进进度条（它们不在计划里），
  // 单独列一行，勾选在「训练日程」里做。
  const extras = state.extras?.[overview.todayKey] ?? [];
  const extrasLine = extras.length
    ? `<p class="subtle today-extra">另外从补题队列排进来 ${extras.length} 道：${extras
        .map(
          (problem) =>
            `<a href="${problemHref(problem)}" target="_blank" rel="noreferrer">${problemCodeText(problem)}</a>`,
        )
        .join('、')}（在训练日程里勾选）</p>`
    : '';

  box.innerHTML =
    head +
    body +
    extrasLine +
    (total
      ? `<div class="today-extra">
           <select id="extra-axis" title="选一个方向，临时加三道题进今天">${(state.planData.axes ?? [])
             .map((row) => `<option value="${escapeHtml(row.axis)}">${escapeHtml(row.axis)}</option>`)
             .join('')}</select>
           <button type="button" class="btn small" id="extra-add">今天补一个方向</button>
         </div>`
      : '') +
    `<div class="today-foot">
       <span>${deadline}</span>
       <span class="today-sep">·</span>
       <span class="today-behind ${behindClass}">${behindText}</span>
     </div>` +
    (retroLine(state.retro) ? `<p class="subtle today-retro">${escapeHtml(retroLine(state.retro))}</p>` : '');
}

function rebuildSchedule() {
  if (!state.planProblems.length) return;
  // 从「计划定下来的那天」开始排，而不是从今天开始：
  // 每天的题固定下来，日历不会因为今天勾了一道题就整条往前挪。
  state.schedule = buildSchedule({
    problems: state.planProblems,
    weekly: state.weekly,
    restDays: state.restDays,
    dayOff: state.dayOff,
    startDate: state.planStart ?? new Date(),
  });
  if (!state.calCursor) {
    const now = new Date();
    state.calCursor = { year: now.getFullYear(), month: now.getMonth() };
  }
  if (!state.selectedDate) state.selectedDate = dateKey(new Date());
  renderSchedule();
  renderTodayCard();
}

function renderSchedule() {
  markViewReady('panel-schedule');
  const schedule = state.schedule;
  if (!schedule) {
    $('schedule-summary').textContent = '先生成训练计划，再来排日程。';
    return;
  }

  $('schedule-summary').textContent =
    `从 ${formatMonthDay(schedule.startDate)} 开始，到 ${formatMonthDay(schedule.endDate)} 做完 ${schedule.totalProblems} 题；` +
    `今天安排 ${schedule.byDate.get(dateKey(new Date()))?.problems.length ?? 0} 题。` +
    `平均每个做题日 ${schedule.perActiveDay} 题，中间有 ${schedule.restDates.length} 天不安排任务。`;

  $('rest-picker').innerHTML = WEEKDAY_LABELS.map((label, index) => {
    const active = state.restDays.includes(index) ? 'active' : '';
    return `<button type="button" class="rest-chip ${active}" data-rest-day="${index}">${label}</button>`;
  }).join('');

  renderMonthCalendar();
  renderDayDetail();
  renderUpcoming();
}

function renderMonthCalendar() {
  const { year, month } = state.calCursor;
  $('cal-title').textContent = `${year} 年 ${month + 1} 月`;
  $('cal-weekdays').innerHTML = WEEKDAY_LABELS.map((label) => `<span>${label.slice(1)}</span>`).join('');

  const today = dateKey(new Date());
  const maxQuota = Math.max(1, ...state.schedule.days.map((day) => day.quota));
  const offMap = new Map(state.schedule.restDates.map((item) => [item.date, item]));

  $('cal-grid').innerHTML = monthMatrix(year, month)
    .flat()
    .map((cell) => {
      const day = state.schedule.byDate.get(cell.date);
      const off = offMap.get(cell.date);
      const classes = ['cal-cell'];
      if (!cell.inMonth) classes.push('dim');
      if (cell.date === today) classes.push('today');
      if (cell.date === state.selectedDate) classes.push('selected');
      if (cell.date < today) classes.push('past');

      let body = '<span class="cal-quota">—</span>';
      if (off) {
        body = `<span class="cal-note">${off.reason ? `休息 · ${escapeHtml(off.reason)}` : '休息'}</span>`;
      } else if (day) {
        const level = Math.max(1, Math.min(4, Math.ceil((day.quota / maxQuota) * 4)));
        const width = Math.round((day.quota / maxQuota) * 100);
        body =
          `<span class="cal-quota">${day.quota} 题</span>` +
          `<div class="cal-bar"><span style="width:${width}%;background:var(--hm${level})"></span></div>`;
      }

      return `<div class="${classes.join(' ')}" data-cal-date="${cell.date}"><span class="cal-day">${cell.day}</span>${body}</div>`;
    })
    .join('');

  $('cal-legend').textContent = '点任意一天可标记「这天没空」，后面的安排会自动顺延，总题量不变';
}

// 日程里「额外安排」那几个勾：走和计划、今天卡片同一条路
$('day-detail').addEventListener('change', (event) => {
  const checkbox = event.target.closest('input[data-extra-contest]');
  if (!checkbox) return;
  markProblemDone(Number(checkbox.dataset.extraContest), checkbox.dataset.extraIndex, checkbox.checked);
  renderDayDetail();
});

// 日程里「额外安排」的移除按钮
$('day-detail').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-extra-remove]');
  if (!button || !state.handle || !state.selectedDate) return;
  const key = button.dataset.extraRemove;
  const contestId = Number(key.slice(0, key.indexOf('-')));
  const index = key.slice(key.indexOf('-') + 1);
  const date = state.selectedDate;
  try {
    await fetch('/api/schedule/extra', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: state.handle, date, contestId, index }),
    });
    if (state.extras[date]) {
      state.extras[date] = state.extras[date].filter((p) => `${p.contestId}-${p.index}` !== key);
    }
    renderDayDetail();
    renderTodayCard();
    setStatus('已从这天移除');
  } catch {
    setStatus('移除失败');
  }
});

/** 某一天里「从补题队列排进来的」那几道题。 */
function extrasBlock(dateKeyValue) {
  const extras = state.extras?.[dateKeyValue] ?? [];
  if (!extras.length) return '';
  const rows = extras
    .map(
      (problem) => {
        const key = `${problem.contestId}-${problem.index}`;
        const isDone = state.done.has(key);
        return `
      <tr class="${isDone ? 'done' : ''}">
        <td style="width:28px">
          <input type="checkbox" ${isDone ? 'checked' : ''}
                 data-extra-contest="${problem.contestId}" data-extra-index="${problem.index}" />
        </td>
        <td class="problem-code">${problemCodeText(problem)}</td>
        <td><a class="problem-name" href="${problemHref(problem)}" target="_blank" rel="noreferrer">${escapeHtml(problem.name)}</a>${platformBadge(problem)}
            ${state.hideTags ? '' : `<div class="problem-tags">${tagSpans(problem.tags, 3)}</div>`}</td>
        <td style="width:70px">${ratingBadge(problem.rating)}</td>
        <td style="width:86px"><button type="button" class="swap-btn"
                data-extra-remove="${problem.contestId}-${problem.index}">移除</button></td>
      </tr>`;
      },
    )
    .join('');
  return `<h4 class="settings-sub">额外安排（从补题队列排进来的）</h4>
    <table class="problem-table">${rows}</table>`;
}

function renderDayDetail() {
  const key = state.selectedDate;
  if (!key) {
    $('day-detail').innerHTML = '';
    return;
  }

  const day = state.schedule.byDate.get(key);
  const off = state.schedule.restDates.find((item) => item.date === key);
  const weekdayOff = state.restDays.includes(parseDateKey(key).getDay());
  const isOff = Boolean(off);

  const status = isOff
    ? '这天不安排任务'
    : day
      ? `安排 ${day.problems.length} 题`
      : '不在计划时间范围内';

  let actions;
  if (weekdayOff) {
    actions = '<span class="stage-meta">这天属于每周固定休息，取消上面「每周固定休息」里的勾选即可恢复</span>';
  } else {
    actions =
      `<input type="text" id="day-note" placeholder="原因，例如：聚餐（可留空）" value="${escapeHtml(off?.reason ?? '')}" />` +
      `<button class="btn" id="day-toggle">${isOff ? '这天恢复做题' : '这天不做题'}</button>`;
  }

  const header = `
    <div class="day-detail-head">
      <div><strong>${formatMonthDay(key)}</strong> <span class="stage-meta">${status}</span></div>
      <div class="day-detail-actions">${actions}</div>
    </div>`;

  if (!day || isOff) {
    $('day-detail').innerHTML =
      header +
      `<p class="subtle">${isOff ? '这天休息，题目会自动顺延到后面，总量不变。' : '这一天没有安排题目。'}</p>` +
      extrasBlock(key);
  } else {
    const stageOf = day.problems[0]?.stage ?? 1;
    const rows = day.problems
      .map(
        (problem) => {
          const key = `${problem.contestId}-${problem.index}`;
          // 日程锚在计划开始那天，所以过去的日子会出现在日历上；
          // 做过的题在这里也标出来，免得以为自己漏了。
          const isDone = state.done.has(key);
          return `
      <tr class="${isDone ? 'done' : ''}">
        <td class="problem-code">${problemCodeText(problem)}</td>
        <td><a class="problem-name" href="${problemHref(problem)}" target="_blank" rel="noreferrer">${problem.name}</a>${platformBadge(problem)}
            ${isDone ? '<span class="auto-done">已通过</span>' : ''}
            ${state.luoguKeys.has(key) ? '<span class="solved-elsewhere">洛谷做过</span>' : ''}
            ${state.hideTags ? '' : `<div class="problem-tags">${tagSpans(problem.tags, 3)}</div>`}</td>
        <td style="width:70px">${ratingBadge(problem.rating)}</td>
        <td style="width:86px" class="problem-tags">第 ${problem.stage ?? stageOf} 阶段</td>
      </tr>`;
        },
      )
      .join('');
    $('day-detail').innerHTML =
      header + `<table class="problem-table">${rows}</table>` + extrasBlock(key);
  }

  const toggle = $('day-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      if (Object.hasOwn(state.dayOff, key)) delete state.dayOff[key];
      else state.dayOff[key] = $('day-note')?.value.trim() ?? '';
      saveSettings({ dayOff: state.dayOff });
      rebuildSchedule();
    });
  }

  const note = $('day-note');
  if (note && isOff) {
    note.addEventListener('change', () => {
      state.dayOff[key] = note.value.trim();
      saveSettings({ dayOff: state.dayOff });
      rebuildSchedule();
    });
  }
}

function renderUpcoming() {
  // 过去的日子不用再列了，从今天往后看
  const todayKey = dateKey(new Date());
  const upcoming = state.schedule.days.filter((day) => day.date >= todayKey).slice(0, 10);
  if (!upcoming.length) {
    $('upcoming-list').innerHTML = '';
    return;
  }
  $('upcoming-list').innerHTML =
    '<div class="stage-meta" style="margin-bottom:8px">接下来的安排（点一行可以跳到那天）</div>' +
    upcoming
      .map((day) => {
        const names = day.problems
          .slice(0, 4)
          .map(problemCodeText)
          .join(' · ');
        const more = day.problems.length > 4 ? ` 等 ${day.problems.length} 题` : '';
        return `<div class="upcoming-row" data-cal-date="${day.date}">
          <span class="upcoming-date">${formatMonthDay(day.date)}</span>
          <span class="upcoming-count">${day.problems.length} 题</span>
          <span class="upcoming-problems">${names}${more}</span>
        </div>`;
      })
      .join('');
}

$('panel-schedule').addEventListener('click', (event) => {
  const nav = event.target.closest('[data-cal-nav]');
  if (nav) {
    const cursor = state.calCursor ?? { year: new Date().getFullYear(), month: new Date().getMonth() };
    const next = new Date(cursor.year, cursor.month + Number(nav.dataset.calNav), 1);
    state.calCursor = { year: next.getFullYear(), month: next.getMonth() };
    renderMonthCalendar();
    return;
  }
  const target = event.target.closest('[data-cal-date]');
  if (target && state.schedule) {
    state.selectedDate = target.dataset.calDate;
    renderMonthCalendar();
    renderDayDetail();
  }
});

$('rest-picker').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-rest-day]');
  if (!chip) return;
  const day = Number(chip.dataset.restDay);
  state.restDays = state.restDays.includes(day)
    ? state.restDays.filter((value) => value !== day)
    : [...state.restDays, day].sort((a, b) => a - b);
  saveSettings({ restDays: state.restDays });
  rebuildSchedule();
});

$('schedule-reset').addEventListener('click', () => {
  state.dayOff = {};
  saveSettings({ dayOff: {} });
  rebuildSchedule();
});

/** 两个每周题量输入框绑同一个值，改哪个都同步。 */
function syncWeekly(value, source) {
  const weekly = Math.max(1, Math.round(Number(value) || 10));
  state.weekly = weekly;
  if (source !== 'main') $('weekly-input').value = weekly;
  if (source !== 'schedule') $('weekly-input-2').value = weekly;
  saveSettings({ weekly });
  rebuildSchedule();
}

$('weekly-input').addEventListener('change', (event) => syncWeekly(event.target.value, 'main'));
$('weekly-input-2').addEventListener('change', (event) => syncWeekly(event.target.value, 'schedule'));

loadCalendar();

/** 底部显示版本号，方便确认装的是哪一版。 */
async function loadVersion() {
  try {
    const { version } = await getJson('/api/health');
    if (version) $('app-version').textContent = `v${version}`;
  } catch {
    $('app-version').textContent = '';
  }
}

loadVersion();

/** 页脚的交流群入口：点开显示二维码，点别处收起。 */
$('qq-toggle').addEventListener('click', () => $('qq-pop').classList.toggle('hidden'));
document.addEventListener('click', (event) => {
  const pop = $('qq-pop');
  if (pop.classList.contains('hidden')) return;
  if (event.target.closest('#qq-pop') || event.target.closest('#qq-toggle')) return;
  pop.classList.add('hidden');
});

// ---------- 左边的主菜单 + 页面切换 ----------
//
// 以前是一整页从上滑到底，现在是「左边点菜单、右边换页面」：
// 每个 section.panel 就是一个页面，同时只显示一个。
// 顺序按「每天真正会看的先后」排：先看今天要做什么，再看数据，最后是资料类的。
const NAV_ITEMS = [
  { id: 'panel-overview', label: '当前水平', icon: '📊' },
  { id: 'panel-target', label: '目标设置', icon: '🎯', group: '训练' },
  { id: 'panel-plan', label: '训练计划', icon: '📋' },
  { id: 'panel-schedule', label: '训练日程', icon: '🗓' },
  { id: 'panel-review', label: '补题队列', icon: '🧾' },
  { id: 'panel-tags', label: '能力画像', icon: '🧭', group: '数据' },
  { id: 'panel-growth', label: '成长', icon: '🌱' },
  { id: 'panel-records', label: '做题记录', icon: '📝' },
  { id: 'panel-heatmap', label: '活动记录', icon: '🔥' },
  { id: 'panel-calendar', label: '比赛日历', icon: '🏁', group: '其他' },
  { id: 'panel-virtual', label: '虚拟参赛', icon: '⏱' },
  { id: 'panel-platforms', label: '平台数据', icon: '🔔' },
  { id: 'panel-settings', label: '设置', icon: '⚙️' },
];

const VIEW_IDS = NAV_ITEMS.map((item) => item.id);

/** 画左边那列菜单。group 变了就插一个小标题，把功能分成几段。 */
function renderSideNav() {
  const nav = $('side-nav');
  if (!nav) return;
  let html = '';
  let group = null;
  for (const item of NAV_ITEMS) {
    if (item.group && item.group !== group) {
      group = item.group;
      html += `<div class="side-group">${escapeHtml(group)}</div>`;
    }
    html += `<button type="button" class="side-item" data-view="${item.id}">
      <span class="ico">${item.icon}</span><span>${escapeHtml(item.label)}</span>
    </button>`;
  }
  nav.innerHTML = html;
}

/** 切到某个页面：把其它页面藏起来，菜单高亮跟上，地址栏的 hash 也同步。 */
function showView(id, { save = true } = {}) {
  if (!VIEW_IDS.includes(id)) return;
  state.view = id;
  for (const viewId of VIEW_IDS) {
    const panel = $(viewId);
    if (panel) panel.classList.toggle('hidden', viewId !== id);
  }
  for (const button of document.querySelectorAll('#side-nav .side-item')) {
    button.classList.toggle('active', button.dataset.view === id);
  }
  $('main')?.scrollTo?.({ top: 0 });
  window.scrollTo({ top: 0 });
  if (save) {
    history.replaceState(null, '', `#/${id.replace('panel-', '')}`);
  }
}

/** 某个页面拿到数据了：如果它正开着就重画一下（顺带把菜单项放出来）。 */
function markViewReady(id) {
  state.readyView.add(id);
  if (state.view === id) showView(id, { save: false });
}

$('side-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) showView(button.dataset.view);
});

window.addEventListener('hashchange', () => {
  const id = `panel-${location.hash.replace(/^#\/?/, '')}`;
  if (VIEW_IDS.includes(id) && id !== state.view) showView(id, { save: false });
});

// ---------- 设置：模块显示 ----------

const MODULE_META = [
  { id: 'panel-overview', label: '当前水平' },
  { id: 'panel-target', label: '目标设置' },
  { id: 'panel-plan', label: '训练计划' },
  { id: 'panel-schedule', label: '训练日程' },
  { id: 'panel-calendar', label: '比赛日历' },
  { id: 'panel-virtual', label: '虚拟参赛' },
  { id: 'panel-heatmap', label: '活动记录' },
  { id: 'panel-platforms', label: '平台数据' },
  { id: 'panel-records', label: '做题记录' },
  { id: 'panel-review', label: '补题队列' },
  { id: 'panel-growth', label: '成长' },
  { id: 'panel-tags', label: '能力画像' },
];

function renderModuleList() {
  $('module-list').innerHTML = MODULE_META.map(({ id, label }) => {
    const on = !state.hiddenModules.includes(id);
    return `<label class="module-item ${on ? '' : 'off'}">
      <input type="checkbox" data-module="${id}" ${on ? 'checked' : ''} />
      <span>${label}</span>
    </label>`;
  }).join('');
}

function applyModuleVisibility() {
  for (const { id } of MODULE_META) {
    const hidden = state.hiddenModules.includes(id);
    $(id)?.classList.toggle('module-hidden', hidden);
    // 左边菜单里对应那一项也一起藏掉
    document
      .querySelector(`#side-nav .side-item[data-view="${id}"]`)
      ?.classList.toggle('module-hidden', hidden);
  }
  // 当前正开着的那页被关掉了，就退回「当前水平」
  if (state.hiddenModules.includes(state.view)) showView('panel-overview', { save: false });
}

$('module-list').addEventListener('change', (event) => {
  const input = event.target.closest('[data-module]');
  if (!input) return;
  const id = input.dataset.module;
  state.hiddenModules = input.checked
    ? state.hiddenModules.filter((value) => value !== id)
    : [...new Set([...state.hiddenModules, id])];
  // 只更新这一项的外观，不重建整个列表——重建会把 DOM 换掉，
  // 连续操作时手里的元素就失效了
  input.closest('.module-item')?.classList.toggle('off', !input.checked);
  applyModuleVisibility();
  saveSettings({ hiddenModules: state.hiddenModules });
});

// ---------- 设置：其他平台 ----------

async function loadPlatforms() {
  try {
    const { platforms, luoguCatalog } = await getJson('/api/platforms');
    state.platforms = platforms ?? [];
    state.luoguCatalog = luoguCatalog ?? state.luoguCatalog;
    renderLuoguCatalogHint();
    renderLuoguInPlanHint();
    refreshLuoguKeys();
    renderPlatformCards();
  } catch {
    /* 读不到就先不显示 */
  }
}

  const PLATFORM_LABELS = { nowcoder: '牛客', luogu: '洛谷', atcoder: 'AtCoder' };
const STAT_ORDER = ['题已通过', '题已挑战', '次提交', 'Rating', 'Rating排名'];

// 洛谷官方的难度配色，共 9 档（0-8），和主页「难度统计」的颜色一一对应。
// 第 5 档「提高」是青绿色，是洛谷后加的档位，之前的版本漏了它。
const LUOGU_COLORS = {
  0: '#bfbfbf',
  1: '#fe4c61',
  2: '#f39c11',
  3: '#ffc116',
  4: '#52c41a',
  5: '#13c2c2',
  6: '#3498db',
  7: '#9d3dcf',
  8: '#0e1d69',
};
const LUOGU_SHORT = {
  0: '未评定',
  1: '入门',
  2: '普及−',
  3: '普及',
  4: '普及+/提高−',
  5: '提高',
  6: '提高+/省选−',
  7: '省选/NOI−',
  8: 'NOI/CTSC',
};

  /** 从已同步的平台数据里取出洛谷镜像的 CF 题号。 */
  function refreshLuoguKeys() {
    const luogu = state.platforms.find((entry) => entry.platform === 'luogu');
    state.luoguKeys = new Set(luogu?.extra?.cfProblems ?? []);
  }

/** 平台数据面板：每同步一个平台就多一张卡片，洛谷额外画难度分布图。 */
function renderPlatformCards() {
  if (!state.platforms.length) {
    // 没同步过就别把这个面板摆出来，免得空占一块
    $('platform-charts').innerHTML =
      '<p class="subtle">还没有同步任何平台。到「设置」里填入洛谷或牛客的用户 ID，点同步即可。</p>';
    return;
  }
  markViewReady('panel-platforms');
  $('platform-charts').innerHTML = state.platforms
    .map((entry) => {
      const keys = [
        ...STAT_ORDER.filter((key) => key in entry.stats),
        ...Object.keys(entry.stats).filter((key) => !STAT_ORDER.includes(key)),
      ];
      const stats = keys
        .map((key) => `<div class="platform-stat"><b>${entry.stats[key]}</b>${key}</div>`)
        .join('');
      const who = `${escapeHtml(entry.nickname ?? '')} · ID ${entry.account} · 同步于 ${new Date(entry.fetchedAt).toLocaleString('zh-CN')}`;
      return `<div class="platform-card">
        <h4>${PLATFORM_LABELS[entry.platform] ?? entry.platform}</h4>
        <div class="who">${who}</div>
        <div class="platform-stats">${stats}</div>
        ${renderLuoguChart(entry)}
      </div>`;
    })
    .join('');
}

/** 洛谷难度分布柱状图。 */
function renderLuoguChart(entry) {
  const difficulty = entry.extra?.difficulty;
  if (!difficulty) return '';

  const rows = Object.entries(difficulty).sort((a, b) => Number(a[0]) - Number(b[0]));
  const max = Math.max(1, ...rows.map(([, count]) => count));
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  const hard = rows
    .filter(([level]) => Number(level) >= 5)
    .reduce((sum, [, count]) => sum + count, 0);

  const columns = rows
    .map(([level, count]) => {
      const height = Math.max(6, Math.round((count / max) * 168));
      const color = LUOGU_COLORS[level] ?? '#8c8c8c';
      const name = LUOGU_SHORT[level] ?? `难度 ${level}`;
      return `<div class="chart-col">
        <span class="chart-value">${count}</span>
        <div class="chart-bar" style="height:${height}px;background:${color}" title="${name} · ${count} 题"></div>
        <span class="chart-label">${escapeHtml(name)}</span>
      </div>`;
    })
    .join('');

  const percent = total ? Math.round((hard / total) * 100) : 0;
  return `<div class="chart-title">洛谷难度分布</div>
    <div class="luogu-chart">${columns}</div>
    <p class="subtle" style="margin-top:12px">
      共 ${total} 题，其中提高+/省选− 及以上 ${hard} 题，占 ${percent}%。
    </p>`;
}

/** 两个平台的同步按钮走同一套逻辑。 */
function bindPlatformSync({ platform, inputId, hintId, buttonId, label, settingsKey }) {
  $(buttonId).addEventListener('click', async () => {
    const account = $(inputId).value.trim();
    const hint = $(hintId);
    const button = $(buttonId);

    if (!account) {
      hint.textContent = `先填${label}用户 ID 再同步。`;
      hint.classList.add('error');
      return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '同步中…';
    hint.classList.remove('error');
    hint.textContent = '正在抓取，只请求一次…';

    try {
      const data = await postJson('/api/platforms/sync', { platform, account });
      state.platforms = data.platforms;
      refreshLuoguKeys();
      renderPlatformCards();
      applyLuoguMarks();
      saveSettings({ [settingsKey]: account });
      hint.textContent = `同步成功：已通过 ${data.result.solved ?? '?'} 题。`;
    } catch (error) {
      hint.textContent = error.message;
      hint.classList.add('error');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}

bindPlatformSync({
  platform: 'nowcoder',
  inputId: 'nowcoder-input',
  hintId: 'nowcoder-hint',
  buttonId: 'nowcoder-sync',
  label: '牛客',
  settingsKey: 'nowcoderUid',
});

bindPlatformSync({
  platform: 'luogu',
  inputId: 'luogu-input',
  hintId: 'luogu-hint',
  buttonId: 'luogu-sync',
  label: '洛谷',
  settingsKey: 'luoguUid',
});

// ---------- 洛谷题库 ----------
// 练习页只能告诉我「你做过哪些题」，题目本身（难度、标签、通过人数）得从题目列表页抓。
// 这一步按难度档等距抽页，抓完进本地库，训练计划靠它排除做过的洛谷题。

/** 上次抓洛谷题库的结果，直接显示在设置里，不用重新点一遍才知道抓到什么。 */
function renderLuoguCatalogHint() {
  const hint = $('luogu-catalog-hint');
  if (!hint) return;
  const info = state.luoguCatalog;
  if (!info?.count) {
    hint.textContent = '还没抓过洛谷题库。';
    hint.classList.remove('error');
    return;
  }
  // 按难度档列：哪一档抓了多少道、哪一档还没抓
  const levels = Object.entries(info.levels ?? {})
    .map(([level, row]) => ({ level: Number(level), ...row }))
    .sort((a, b) => a.level - b.level)
    .map(
      (row) =>
        `${row.label} ${row.taken ?? 0} 题${
          row.failed ? `（${row.failed} 页没抓到）` : ''
        }`,
    );
  hint.textContent =
    `题库共 ${info.count} 道，最近一次抓于 ${new Date(info.updatedAt).toLocaleString('zh-CN')}。` +
    (levels.length ? ` 各档：${levels.join('、')}。` : '');
}

$('luogu-catalog').addEventListener('click', async () => {
  const button = $('luogu-catalog');
  const hint = $('luogu-catalog-hint');
  const levels = $('luogu-levels').value
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n));
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '抓取中…';
  hint.classList.remove('error');
  hint.textContent = `正在按难度档抽页（${levels.length} 档，每档 8 页），大约 ${
    levels.length * 9
  } 个请求、${Math.round((levels.length * 9 * 1.7) / 60)} 分钟左右…`;

  try {
    const data = await postJson('/api/luogu/catalog', {
      handle: state.handle,
      levels,
      // 单次请求上限跟着档数走：每档最多 9 页 + 第 1 页重复算一次，留点余量
      budget: Math.min(200, levels.length * 11 + 5),
    });
    state.luoguCatalog = data.catalog ?? null;
    renderLuoguCatalogHint();
    renderLuoguInPlanHint();
    const marked = data.solvedMarked?.inserted;
    if (marked) {
      hint.textContent += ` 另外认出了 ${marked} 道你做过的题。`;
    }
  } catch (error) {
    hint.textContent = error.message;
    hint.classList.add('error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

// ---------- AtCoder：题库 + 提交记录（决定训练计划里有没有 AtCoder 题） ----------

/**
 * AtCoder 的同步和牛客/洛谷不一样：它既要抓题库，也要抓提交记录，
 * 而且记录是挂在当前这个 Codeforces 账号下面的（计划和进度都按这个号存）。
 */
$('atcoder-sync').addEventListener('click', async () => {
  const account = $('atcoder-input').value.trim();
  const hint = $('atcoder-hint');
  const button = $('atcoder-sync');

  if (!account) {
    hint.textContent = '先填 AtCoder 用户名再同步。';
    hint.classList.add('error');
    return;
  }
  if (!state.handle) {
    hint.textContent = '先在上面填 Codeforces 用户名——AtCoder 的记录要挂在这个账号下面。';
    hint.classList.add('error');
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '同步中…';
  hint.classList.remove('error');
  hint.textContent = '正在抓题库和提交记录，第一次会慢一点…';

  try {
    const data = await postJson('/api/atcoder/sync', {
      account,
      handle: state.handle,
      force: true,
    });
    state.platforms = data.platforms ?? state.platforms;
    state.atcoderUid = account;
    renderPlatformCards();
    saveSettings({ atcoderUid: account });
    const added = data.submissions?.added ?? 0;
    hint.textContent =
      `同步成功：题库 ${data.catalog?.count ?? '?'} 道题，这次写入 ${added} 条提交记录，` +
      `累计通过 ${data.result?.solved ?? '?'} 道。`;
    // 记录变了，把计划重新拉一次：做过的题会自动打勾、也不会再推荐
    if (state.planData) generatePlan(false, { scroll: false });
  } catch (error) {
    hint.textContent = error.message;
    hint.classList.add('error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

/**
 * 勾选框改了要重新出计划：计划指纹里带了这一项，服务端会自动重挑一批题。
 * 没勾就是纯 Codeforces，和以前完全一样。
 */
$('atcoder-in-plan').addEventListener('change', () => {
  const on = $('atcoder-in-plan').checked;
  state.atcoderInPlan = on;
  saveSettings({ atcoderInPlan: on });
  if (on && !state.atcoderUid) {
    $('atcoder-hint').textContent = '填上 AtCoder 用户名并同步一次，题单里才会有 AtCoder 的题。';
  }
  if (state.handle && state.target) generatePlan(false, { scroll: false });
});

// 洛谷题进题单：题库要先抓过；没抓的话给一句提示，别让人以为勾了没反应
$('luogu-in-plan').addEventListener('change', () => {
  const on = $('luogu-in-plan').checked;
  state.luoguInPlan = on;
  saveSettings({ luoguInPlan: on });
  renderLuoguInPlanHint();
  if (state.handle && state.target) generatePlan(false, { scroll: false });
});

/** 「加入洛谷题」旁边那行小字：题库抓了没有、抓了多少。 */
function renderLuoguInPlanHint() {
  const hint = $('luogu-in-plan-hint');
  if (!hint) return;
  const count = state.luoguCatalog?.count ?? 0;
  hint.textContent = count
    ? `洛谷题库已有 ${count} 道题，勾上就会按份额进题单（每天最多一道）。`
    : '洛谷题进题单之前，先到下面「洛谷」那里抓一次题库（约 1 分钟）。';
}

  /** 洛谷同步后，重新渲染计划，把「洛谷做过」的标记刷出来。 */
  function applyLuoguMarks() {
    if (state.planData) renderPlan(state.planData);
    if (state.schedule) renderDayDetail();
  }

  // ---------- 设置：水平评估的排除区间 ----------
  // 签到题会把某些标签的分位数拖低（做过的贪心里大半是签到题），
  // 所以允许忽略比当前 rating 低一段的题。默认 400。

  $('floor-gap-save').addEventListener('click', async () => {
    const hint = $('floor-gap-hint');
    const value = Number($('floor-gap-input').value);
    if (!Number.isFinite(value) || value < 0 || value > 2000) {
      hint.textContent = '请填 0 到 2000 之间的数字。';
      hint.classList.add('error');
      return;
    }

    saveSettings({ floorGap: Math.round(value) });
    hint.classList.remove('error');
    hint.textContent = value === 0 ? '已关闭排除，正在重新生成计划…' : `已设为 ${value} 分，正在重新生成计划…`;

    if (state.handle) await generatePlan(false, { scroll: false });
    hint.textContent =
      value === 0
        ? '已关闭排除。所有做过的题都会计入水平评估。'
        : `已忽略低于 ${state.planData?.analysisFloor ?? '—'} 分的题（共 ${state.planData?.excludedFromAnalysis ?? 0} 道）。`;
  });

  // ---------- 设置：单个标签在题单里的占比上限 ----------
  // 一份计划里同一个专题刷太多遍，别的方向就练不到，所以给个默认 40% 的上限。

  $('tag-share-save').addEventListener('click', async () => {
    const hint = $('tag-share-hint');
    const value = Number($('tag-share-input').value);
    if (!Number.isFinite(value) || value < 10 || value > 90) {
      hint.textContent = '请填 10 到 90 之间的数字。';
      hint.classList.add('error');
      return;
    }

    saveSettings({ tagShare: Math.round(value) });
    hint.classList.remove('error');
    hint.textContent = `已设为 ${Math.round(value)}%，正在重新生成计划…`;

    if (state.handle) await generatePlan(false, { scroll: false });
    hint.textContent = `同一个标签最多占题单的 ${Math.round(value)}%；填得越低，题目越杂。`;
  });

  // ---------- 训练计划：隐藏标签 ----------
  // 有些人不想被标签剧透，只想拿到题单自己判断。开着的时候连「重点补强」
  // 那行也一起换掉，否则方向信息还是漏出去了。

  $('hide-tags').addEventListener('change', () => {
    state.hideTags = $('hide-tags').checked;
    saveSettings({ hideTags: state.hideTags });
    // 计划和日程都要重画：这个开关管的是「所有训练相关的界面」
    if (state.planData) renderPlan(state.planData);
    if (state.schedule) renderSchedule();
    renderTodayCard();
  });

  // ---------- 设置：训练推题模型 ----------
  // 训练在后台进程里跑，这边只负责启动和显示进度。

  let trainingTimer = null;

  function renderTraining(info) {
    const log = $('train-log');
    const hint = $('train-hint');
    const lines = info?.training?.lines ?? [];
    log.classList.toggle('hidden', !lines.length);
    log.textContent = lines.slice(-16).join('\n');
    log.scrollTop = log.scrollHeight;

    if (info?.training?.running) {
      hint.textContent = '正在训练，可以去做别的，跑完会停。';
      hint.classList.remove('error');
      return;
    }
    if (info?.training?.error) {
      hint.textContent = `训练没跑完：${info.training.error}`;
      hint.classList.add('error');
      return;
    }
    hint.classList.remove('error');
    const model = info?.model;
    if (!model) {
      hint.textContent = `还没有训练过模型，当前存了 ${info?.samples ?? 0} 条比赛样本。`;
      return;
    }
    const auc = model.auc == null ? '—' : model.auc.toFixed(3);
    const base = model.baselineAuc == null ? '—' : model.baselineAuc.toFixed(3);
    hint.textContent =
      `样本 ${model.samples ?? '—'} 条 · 来自 ${model.contests ?? '—'} 场比赛 · ` +
      `留出集 AUC ${auc}（基线 ${base}）· ${model.active ? '已启用' : '未启用（没明显超过基线）'}`;
  }

  async function refreshTraining() {
    try {
      const info = await getJson('/api/model');
      renderTraining(info);
      if (info.training?.running && !trainingTimer) {
        trainingTimer = setInterval(refreshTraining, 3000);
      }
      if (!info.training?.running && trainingTimer) {
        clearInterval(trainingTimer);
        trainingTimer = null;
      }
      return info;
    } catch {
      return null;
    }
  }

  $('train-model').addEventListener('click', async () => {
    const hint = $('train-hint');
    const contests = Number($('train-contests-input').value);
    if (!Number.isFinite(contests) || contests < 20 || contests > 2000) {
      hint.textContent = '请填 20 到 2000 之间的数字。';
      hint.classList.add('error');
      return;
    }
    hint.classList.remove('error');
    hint.textContent = '正在启动训练…';
    try {
      const result = await postJson('/api/model/train', { contests: Math.round(contests) });
      hint.textContent = `已开始，采集 ${result.contests} 场比赛。`;
    } catch (error) {
      hint.textContent = `启动失败：${error.message}`;
      hint.classList.add('error');
      return;
    }
    trainingTimer = setInterval(refreshTraining, 3000);
    await refreshTraining();
  });

/** 启动时自动恢复上次的账号、目标分数和训练计划，不用重新输一遍。 */
async function restoreSession() {
  let settings = null;
  try {
    ({ settings } = await getJson('/api/settings'));
  } catch {
    /* 读不到就用默认外观 */
  }

  if (settings) {
    state.theme = settings.theme ?? 'dark';
    state.palette = settings.heatmapPalette ?? 'green';
    state.restDays = Array.isArray(settings.restDays) ? settings.restDays : [];
    state.dayOff = settings.dayOff ?? {};
    state.hiddenModules = Array.isArray(settings.hiddenModules) ? settings.hiddenModules : [];
    if (settings.nowcoderUid) {
      state.nowcoderUid = settings.nowcoderUid;
      $('nowcoder-input').value = settings.nowcoderUid;
    }
    if (settings.luoguUid) $('luogu-input').value = settings.luoguUid;
    state.atcoderUid = settings.atcoderUid ?? null;
    if (settings.atcoderUid) $('atcoder-input').value = settings.atcoderUid;
    state.atcoderInPlan = Boolean(settings.atcoderInPlan);
    $('atcoder-in-plan').checked = state.atcoderInPlan;
    state.luoguInPlan = Boolean(settings.luoguInPlan);
    $('luogu-in-plan').checked = state.luoguInPlan;
    if (settings.floorGap !== null && settings.floorGap !== undefined) {
      $('floor-gap-input').value = settings.floorGap;
    }
    state.hideTags = Boolean(settings.hideTags);
    $('hide-tags').checked = state.hideTags;
    state.remindAt = settings.remindAt ?? null;
    state.remindLast = settings.remindLast ?? null;
    if (settings.tagShare !== null && settings.tagShare !== undefined) {
      $('tag-share-input').value = settings.tagShare;
    }
  }
  applyAppearance();
  state.compact = Boolean(settings?.compact);
  document.body.classList.toggle('compact', state.compact);
  bindDataTools();
  renderModuleList();
  applyModuleVisibility();
  renderSideNav();
  // 地址栏里带着 #/plan 这种就恢复过去，否则从「当前水平」开始
  const fromHash = `panel-${location.hash.replace(/^#\/?/, '')}`;
  // 还没填账号就先停在「账号」页，填过的话停在地址栏指向的页面（默认当前水平）
  // 账号和当前水平合并成一页了，冷启动也停在这一页
  showView(VIEW_IDS.includes(fromHash) ? fromHash : 'panel-overview', { save: false });
  loadPlatforms();

  if (!settings?.handle) {
    setStatus('未连接');
    return;
  }

  $('handle-input').value = settings.handle;
  if (settings.target) {
    $('target-input').value = settings.target;
    $('target-range').value = settings.target;
    state.target = settings.target;
    state.hasSavedTarget = true;
  }
  if (settings.weekly) {
    $('weekly-input').value = settings.weekly;
    $('weekly-input-2').value = settings.weekly;
    state.weekly = settings.weekly;
  }

  // 用户名加载失败时不要再往下生成计划——那样只会连着失败两次
  const loaded = await loadUser(false);
  if (loaded && settings.target) {
    await generatePlan(false, { scroll: false });
  }
  // 没计划的时候也要把「今天」卡片画出来，提示先去生成计划
  renderTodayCard();
  // 设置读完再起提醒，不然会把「已设好的提醒时间」当成没设
  startReminder();
}

// ---------- 题单筛选与导出 ----------
// 计划有上百道题时靠眼睛翻不现实。筛选只影响显示，不动计划本身，
// 导出的是「当前筛选出来的这几道」，粘群里或者存下来都能直接用。

const planFilter = { keyword: '', axis: '', year: '', min: null, max: null };

function planFilterActive() {
  return Boolean(
    planFilter.keyword || planFilter.axis || planFilter.year || planFilter.min != null || planFilter.max != null,
  );
}

function matchesPlanFilter(problem) {
  if (planFilter.axis && !(problem.axes ?? []).includes(planFilter.axis)) return false;
  if (planFilter.year && String(problem.year ?? '') !== String(planFilter.year)) return false;
  if (planFilter.min != null && (problem.rating ?? 0) < planFilter.min) return false;
  if (planFilter.max != null && (problem.rating ?? 9999) > planFilter.max) return false;
  if (planFilter.keyword) {
    // 用界面上的题号（ABC300E）参与搜索，这样搜 "abc" 也能筛出 AtCoder 的题
    const haystack = `${problemCodeText(problem)} ${problem.name}`.toLowerCase();
    if (!haystack.includes(planFilter.keyword.toLowerCase())) return false;
  }
  return true;
}

/** 把计划里出现过的方向和年份填进下拉框，选项跟着计划走。 */
function syncPlanFilterOptions(plan) {
  const axisSelect = $('plan-filter-axis');
  const yearSelect = $('plan-filter-year');
  if (!axisSelect || !yearSelect) return;
  const axes = new Set();
  const years = new Set();
  for (const stage of plan.stageList) {
    for (const problem of stage.problems) {
      for (const axis of problem.axes ?? []) axes.add(axis);
      if (problem.year) years.add(problem.year);
    }
  }
  axisSelect.innerHTML =
    '<option value="">全部方向</option>' +
    [...axes]
      .sort()
      .map((axis) => `<option value="${escapeHtml(axis)}">${escapeHtml(axis)}</option>`)
      .join('');
  yearSelect.innerHTML =
    '<option value="">全部年份</option>' +
    [...years]
      .sort((a, b) => b - a)
      .map((year) => `<option value="${year}">${year} 年</option>`)
      .join('');
  axisSelect.value = axes.has(planFilter.axis) ? planFilter.axis : '';
  yearSelect.value = years.has(Number(planFilter.year)) ? String(planFilter.year) : '';
}

function updatePlanFilterCount() {
  const box = $('plan-filter-count');
  if (!box) return;
  const plan = state.planData;
  if (!plan) {
    box.textContent = '';
    return;
  }
  const all = plan.stageList.reduce((sum, stage) => sum + stage.problems.length, 0);
  const visible = plan.stageList.reduce(
    (sum, stage) => sum + stage.problems.filter(matchesPlanFilter).length,
    0,
  );
  box.textContent = planFilterActive() ? `筛选后 ${visible} / ${all} 题` : `共 ${all} 题`;
}

function readPlanFilterInputs() {
  planFilter.keyword = $('plan-filter-keyword').value.trim();
  planFilter.axis = $('plan-filter-axis').value;
  planFilter.year = $('plan-filter-year').value;
  const min = Number($('plan-filter-min').value);
  const max = Number($('plan-filter-max').value);
  planFilter.min = Number.isFinite(min) && min > 0 ? min : null;
  planFilter.max = Number.isFinite(max) && max > 0 ? max : null;
}

for (const id of ['plan-filter-keyword', 'plan-filter-min', 'plan-filter-max']) {
  $(id).addEventListener('input', () => {
    readPlanFilterInputs();
    if (state.planData) renderPlan(state.planData);
  });
}
for (const id of ['plan-filter-axis', 'plan-filter-year']) {
  $(id).addEventListener('change', () => {
    readPlanFilterInputs();
    if (state.planData) renderPlan(state.planData);
  });
}

$('plan-filter-reset').addEventListener('click', () => {
  $('plan-filter-keyword').value = '';
  $('plan-filter-min').value = '';
  $('plan-filter-max').value = '';
  $('plan-filter-axis').value = '';
  $('plan-filter-year').value = '';
  readPlanFilterInputs();
  if (state.planData) renderPlan(state.planData);
});

/** 下载一个文本文件。桌面版会直接落到下载目录，网页版走浏览器下载。 */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportPlan(format) {
  const plan = state.planData;
  if (!plan) return;
  const problems = plan.stageList
    .flatMap((stage) => stage.problems)
    .filter(matchesPlanFilter);
  if (!problems.length) {
    setStatus('当前筛选没有题目，没什么可导出的');
    return;
  }

  const stamp = dateKey(new Date());
  if (format === 'csv') {
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = [['题号', '题名', '难度', '方向', '链接']];
    for (const problem of problems) {
      rows.push([
        problemCodeText(problem),
        problem.name,
        problem.rating ?? '',
        (problem.axes ?? []).join(' / '),
        problem.url,
      ]);
    }
    // 带 BOM，Excel 打开中文表头才不会乱码
    downloadText(`acm-plan-${stamp}.csv`, `\ufeff${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`);
  } else {
    const lines = [`# ACM 训练台题单 · 目标 ${plan.target} 分`, '', '| 题号 | 题名 | 难度 | 方向 |', '| --- | --- | --- | --- |'];
    for (const problem of problems) {
      lines.push(
        `| [${problemCodeText(problem)}](${problemHref(problem)}) | ${problem.name} | ${
          problem.rating ?? '—'
        } | ${(problem.axes ?? []).join(' / ') || '—'} |`,
      );
    }
    downloadText(`acm-plan-${stamp}.md`, lines.join('\n'));
  }
  setStatus(`已导出 ${problems.length} 道题`);
}

$('plan-export-md').addEventListener('click', () => exportPlan('md'));
$('plan-export-csv').addEventListener('click', () => exportPlan('csv'));

// ---------- 打卡提醒 ----------
// 到点还没打勾就提醒一次。只在本机、只在这程序开着的时候生效，不联网。
// 系统通知被系统设置挡掉时，退回到「今天」卡片上写一行，至少不会白设。

let remindTimer = null;

function renderReminderHint() {
  const hint = $('remind-hint');
  if (!hint) return;
  hint.classList.remove('error');
  if (!state.remindAt) {
    hint.textContent = '默认关闭。设好时间后，到点当天还有没打勾的题才会提醒。';
    return;
  }
  hint.textContent = `每天 ${state.remindAt} 提醒${
    state.remindLast ? `（上次提醒：${state.remindLast}）` : '（今天还没提醒过）'
  }。`;
}

async function showReminder(title, body) {
  try {
    if (typeof Notification === 'undefined') return false;
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/** 到点检查一次。同一天只提醒一次，题都打勾了就不打扰。 */
async function checkReminder() {
  if (!state.remindAt || !state.handle || !state.schedule) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm < state.remindAt) return;

  const todayKey = dateKey(now);
  if (state.remindLast === todayKey) return;

  // 今天还剩几题：直接用「今天」卡片那套算法，免得两处口径不一样
  const overview = todayOverview({
    problems: state.planProblems,
    weekly: state.weekly,
    restDays: state.restDays,
    dayOff: state.dayOff,
    startDate: state.planStart ?? now,
    today: now,
    doneKeys: state.done,
  });
  const remaining = overview.todayProblems.filter(
    (problem) => !state.done.has(`${problem.contestId}-${problem.index}`),
  ).length;
  if (remaining <= 0) return;

  state.remindLast = todayKey;
  saveSettings({ remindLast: todayKey });
  const delivered = await showReminder(`今天还有 ${remaining} 题`, 'ACM 训练台：做完记得回来打勾。');
  state.reminderBanner = delivered
    ? `已在 ${hhmm} 提醒你：今天还有 ${remaining} 题`
    : `到 ${hhmm} 了，今天还有 ${remaining} 题（系统通知没弹出来，检查一下 Windows 的通知设置）`;
  renderTodayCard();
  renderReminderHint();
}

function startReminder() {
  renderReminderHint();
  if ($('remind-at')) $('remind-at').value = state.remindAt ?? '';
  if (remindTimer) clearInterval(remindTimer);
  // 半分钟查一次，够及时也不费电
  remindTimer = setInterval(checkReminder, 30_000);
  checkReminder();
}

$('remind-save').addEventListener('click', () => {
  const value = $('remind-at').value;
  if (!/^\d{2}:\d{2}$/.test(value)) {
    const hint = $('remind-hint');
    hint.textContent = '先选一个时间。';
    hint.classList.add('error');
    return;
  }
  state.remindAt = value;
  // 换了时间，今天就重新算一次，不然改早了当天不会再提醒
  state.remindLast = null;
  state.reminderBanner = null;
  saveSettings({ remindAt: value, remindLast: '' });
  renderReminderHint();
  renderTodayCard();
  setStatus(`已设置每天 ${value} 提醒`);
});

$('remind-off').addEventListener('click', () => {
  state.remindAt = null;
  state.remindLast = null;
  state.reminderBanner = null;
  if ($('remind-at')) $('remind-at').value = '';
  saveSettings({ remindAt: '', remindLast: '' });
  renderReminderHint();
  renderTodayCard();
  setStatus('已关闭提醒');
});

bindAppearance();
// 冷启动时先把「今天」卡片摆出来；还没生成计划的话它会提示去生成
renderTodayCard();
restoreSession();
// 启动时把上次的训练结果读出来。原来只在点「开始训练」之后才刷新，
// 重启程序后「推题模型」那栏又会显示成「还没有训练过」。
refreshTraining();

// ---------- 数据安全：备份 / 导出 / 导入 / 检查更新 ----------
//
// 都是本机操作，不联网的只有「检查更新」那一个（要问 GitHub 最新 Release）。

function bindDataTools() {
  const hint = $('data-hint');
  const say = (text, error = false) => {
    hint.textContent = text;
    hint.classList.toggle('error', error);
  };

  $('backup-btn')?.addEventListener('click', async () => {
    say('正在备份…');
    try {
      const result = await postJson('/api/backup', {});
      say(`已备份到 ${result.dir}（${result.name}，${Math.round(result.size / 1024)} KB）`);
    } catch (error) {
      say(`备份失败：${error.message}`, true);
    }
  });

  $('export-btn')?.addEventListener('click', async () => {
    say('正在导出…');
    try {
      const data = await getJson('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `acm-trainer-data-${dateKey(new Date())}.json`;
      link.click();
      URL.revokeObjectURL(url);
      say('已导出：设置、勾选进度、屏蔽表、虚拟赛记录、做题手感都在里面。');
    } catch (error) {
      say(`导出失败：${error.message}`, true);
    }
  });

  $('import-btn')?.addEventListener('click', () => $('import-file')?.click());
  $('import-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    say('正在导入…');
    try {
      const text = await file.text();
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '导入失败');
      say(
        `导入完成：进度 ${result.progress} 条、屏蔽 ${result.blocked} 条、虚拟赛 ${result.virtual} 条、手感 ${result.feedback} 条。刷新一下页面生效。`,
      );
    } catch (error) {
      say(`导入失败：${error.message}`, true);
    } finally {
      event.target.value = '';
    }
  });

  $('update-btn')?.addEventListener('click', async () => {
    say('正在问 GitHub…');
    try {
      const info = await getJson('/api/update-check');
      if (info.newer) {
        say(`有新版本 ${info.latest}（当前 ${info.current}）：${info.url}`);
      } else {
        say(`已经是最新的（${info.current}）。`);
      }
    } catch (error) {
      say(`检查更新失败：${error.message}`, true);
    }
  });

  const compact = $('compact-mode');
  if (compact) {
    compact.checked = Boolean(state.compact);
    document.body.classList.toggle('compact', state.compact);
    compact.addEventListener('change', () => {
      state.compact = compact.checked;
      document.body.classList.toggle('compact', state.compact);
      saveSettings({ compact: state.compact });
    });
  }
}

// ---------- 今日卡片上的几个小动作 ----------

/** 把今天的题单复制成一段 Markdown，方便贴群里或记到笔记里。 */
async function copyTodayList() {
  const today = state.schedule?.days.find((day) => day.date === dateKey(new Date()));
  const items = today?.problems ?? [];
  if (!items.length) {
    toast('今天没有安排题目。');
    return;
  }
  const text = [
    `【今天要做的题】${formatMonthDay(dateKey(new Date()))}`,
    ...items.map(
      (problem, index) =>
        `${index + 1}. ${problemCodeText(problem)} ${problem.name}（${problem.rating ?? '?'} 分）${problemHref(problem)}`,
    ),
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制今天的 ${items.length} 道题。`);
  } catch {
    toast('浏览器不让复制，手动选一下吧。', { error: true });
  }
}

/** 给某道题标一下「这道题对我来说是什么难度」，用来微调后面的练习区间。 */
async function sendFeedback(contestId, index, feel) {
  try {
    await postJson('/api/feedback', { handle: state.handle, contestId, index, feel });
    state.feedback.set(`${contestId}-${index}`, feel);
    toast(`已记下：${FEEL_LABELS[feel]}`);
  } catch (error) {
    toast(`记录失败：${error.message}`, { error: true });
  }
}

const FEEL_LABELS = { too_easy: '秒了', ok: '刚好', hard: '卡住', read_editorial: '看题解' };

/** 今日卡片上排一行「秒了 / 刚好 / 卡住 / 看题解」。 */
function feedbackButtons(key) {
  const current = state.feedback.get(key);
  return `<span class="feel-row">${Object.entries(FEEL_LABELS)
    .map(
      ([value, label]) =>
        `<button type="button" class="feel-btn${current === value ? ' active' : ''}" data-feel="${value}" data-feel-key="${key}">${label}</button>`,
    )
    .join('')}</span>`;
}

/** 赛前热身包：24 小时内有比赛时显示在今日卡片上面。 */
function renderWarmup() {
  const box = $('warmup-card');
  const warmup = state.warmup;
  if (!box || !warmup?.problems?.length) {
    box?.classList.add('hidden');
    return;
  }
  const when = new Date(warmup.contest.startTime * 1000).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  box.className = 'today-card';
  box.innerHTML = `
    <div class="today-head">
      <div class="today-when"><span class="today-title">赛前热身</span>
        <span class="today-date">${escapeHtml(warmup.contest.name)} · ${when}</span></div>
    </div>
    <div class="today-list">${warmup.problems
      .map(
        (problem) => `<div class="today-row">
          <span class="problem-code">${problemCodeText(problem)}</span>
          <span class="today-name"><a class="problem-name" href="${problemHref(problem)}" target="_blank" rel="noreferrer">${escapeHtml(problem.name)}</a></span>
          ${ratingBadge(problem.rating)}
        </div>`,
      )
      .join('')}</div>
    <p class="subtle" style="margin:10px 0 0">比赛当天别碰新知识点，这两道热热身就行。</p>`;
}

/** 复盘卡：最近 20 题 vs 再往前 20 题。 */
function retroLine(retro) {
  if (!retro?.current) return null;
  const { current, previous, delta, oneShotDelta } = retro;
  const parts = [`最近 20 题平均 ${current.avgRating} 分，一次过 ${current.oneShot}%`];
  if (previous && delta != null) {
    const trend = delta > 0 ? `比上一轮高 ${delta} 分` : delta < 0 ? `比上一轮低 ${-delta} 分` : '和上一轮持平';
    const smooth = oneShotDelta > 0 ? '，一次过变多了' : oneShotDelta < 0 ? '，一次过变少了' : '';
    parts.push(`${trend}${smooth}`);
  }
  if (current.topAxes?.length) {
    parts.push(`主要练了 ${current.topAxes.map((row) => `${row.axis} ${row.count}`).join('、')}`);
  }
  return parts.join('；');
}

/** 把成长曲线那张 SVG 存成文件（不引入作图库，直接序列化）。 */
function exportChartSvg() {
  const svg = document.querySelector('#growth-chart svg');
  if (!svg) {
    toast('成长曲线还没画出来，先去「成长」页看一眼。', { error: true });
    return;
  }
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `acm-trainer-growth-${dateKey(new Date())}.svg`;
  link.click();
  URL.revokeObjectURL(url);
}

// ---------- 键盘操作 ----------
// 计划表很长，鼠标点checkbox 累；↑/↓ 移动高亮行，空格打勾。
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select')) return;
  if (!['ArrowUp', 'ArrowDown', ' '].includes(event.key)) return;
  const rows = [...document.querySelectorAll('#plan-stages tr[data-key]')];
  if (!rows.length) return;
  const current = rows.findIndex((row) => row.classList.contains('cursor'));

  if (event.key === ' ') {
    event.preventDefault();
    const row = current < 0 ? rows[0] : rows[current];
    row.querySelector('input[type="checkbox"]')?.click();
    if (current < 0) {
      rows[0].classList.add('cursor');
      rows[0].scrollIntoView({ block: 'nearest' });
    }
    return;
  }

  event.preventDefault();
  const next =
    event.key === 'ArrowDown'
      ? Math.min(rows.length - 1, current + 1)
      : Math.max(0, current < 0 ? 0 : current - 1);
  rows.forEach((row) => row.classList.remove('cursor'));
  rows[next].classList.add('cursor');
  rows[next].scrollIntoView({ block: 'nearest' });
});

// ---------- 计划页：按天看 ----------
// 默认按「阶段」看（一长条）；点「按天看」就把整份计划按日程分组，
// 一天一个可折叠的小块，符合「今天要做哪几题」的使用习惯。
let planByDay = false;

function planByDayHtml() {
  const days = (state.schedule?.days ?? []).filter((day) => day.problems.length);
  if (!days.length) {
    return '<p class="subtle">日程还没排出来，先生成计划。</p>';
  }
  const today = dateKey(new Date());
  return days
    .map((day) => {
      const ratings = day.problems.map((problem) => problem.rating ?? 0);
      const spread = ratings.length > 1 ? Math.max(...ratings) - Math.min(...ratings) : 0;
      const done = day.problems.filter((problem) =>
        state.done.has(`${problem.contestId}-${problem.index}`),
      ).length;
      const span = spread >= 100 ? ` · 跨度 ${spread}` : '';
      const flag = day.date === today ? ' class="day-group today"' : ' class="day-group"';
      return `<details${flag}${day.date === today ? ' open' : ''}>
        <summary>
          <span class="day-date">${formatMonthDay(day.date)}</span>
          <span class="day-meta">${day.problems.length} 题 · ${ratings.join(' / ')} 分${span} · 已完成 ${done}/${day.problems.length}</span>
        </summary>
        <table class="problem-table">${day.problems
          .map((problem) => problemRow(problem, problem.rating))
          .join('')}</table>
      </details>`;
    })
    .join('');
}

$('plan-day-toggle').addEventListener('click', () => {
  planByDay = !planByDay;
  $('plan-day-toggle').textContent = planByDay ? '按阶段看' : '按天看';
  $('plan-day-toggle').classList.toggle('primary', planByDay);
  if (state.planData) renderPlan(state.planData);
});
