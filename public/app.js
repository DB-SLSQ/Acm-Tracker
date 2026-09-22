import { buildSchedule, dateKey, heatmapWeeks, monthMatrix, parseDateKey, WEEKDAY_LABELS } from './schedule.js';

const state = {
  handle: '',
  target: 1800,
  weekly: 10,
  planData: null,
  done: new Set(),
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
  calCursor: null,
  selectedDate: null,
  // 热力图
  activity: null,
  heatmapYear: new Date().getFullYear(),
  heatmapMetric: 'solved',
  // 被收起的面板
  collapsed: {},
  // 被整个隐藏的模块
  hiddenModules: [],
  // 其他平台
  nowcoderUid: null,
  platforms: [],
  // 洛谷镜像的 CF 题号集合，用来标记「这题你在洛谷做过」
  luoguKeys: new Set(),
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

function showHint(message, isError = false) {
  const el = $('handle-hint');
  el.textContent = message;
  el.classList.toggle('error', isError);
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

    $('panel-overview').classList.remove('hidden');
    $('panel-target').classList.remove('hidden');
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
    // 把各阶段的题目拍平成一条有序列表，按天排布要用
    state.planProblems = data.plan.stageList.flatMap((stage) =>
      stage.problems.map((problem) => ({ ...problem, stage: stage.index })),
    );
    renderPlan(data.plan);
    renderAxes(data.plan.axes ?? []);
    renderTags(data.plan.weakTags);
    $('panel-plan').classList.remove('hidden');
    $('panel-tags').classList.remove('hidden');
    $('subnav').classList.remove('hidden');
    setStatus('计划已生成');
    if (scroll) $('panel-plan').scrollIntoView({ behavior: 'smooth', block: 'start' });
    rebuildSchedule();
    loadVirtual();
  } catch (error) {
    setStatus('生成失败');
    showHint(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '重新生成计划';
  }
}

function renderPlan(plan) {
  const direction = plan.gap > 0 ? `目标 +${plan.gap}` : '巩固当前水平';
  $('plan-summary').textContent =
    `当前 ${plan.current} 分 → 目标 ${plan.target} 分（${direction}）。` +
    `按每周 ${plan.weekly} 题估算，全程约 ${plan.totalNeeded} 题、${plan.weeks} 周，分 ${plan.stages} 个阶段推进。`;

  $('plan-stages').innerHTML = plan.stageList
    .map((stage) => {
      const rows = stage.problems
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
              <div class="stage-meta">约 ${stage.count} 题 / ${stage.weeks} 周 · 该区间还有 ${stage.unsolvedSupply} 道你没做过的题</div>
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
}

function problemRow(problem, target, extraNote = '') {
  const key = `${problem.contestId}-${problem.index}`;
  const isDone = state.done.has(key);
  // 隐藏标签模式：题单里不显示这道题属于哪些方向，自己判断怎么做
  const tags = state.hideTags ? '' : tagSpans(problem.tags, 3);
  const elsewhere = state.luoguKeys.has(key)
    ? '<span class="solved-elsewhere">洛谷做过</span>'
    : '';
  return `
    <tr class="${isDone ? 'done' : ''}" data-key="${key}">
      <td style="width:28px">
        <input type="checkbox" ${isDone ? 'checked' : ''}
               data-contest="${problem.contestId}" data-index="${problem.index}" />
      </td>
      <td class="problem-code">${problem.contestId}${problem.index}</td>
      <td>
        <a class="problem-name" href="${problem.url}" target="_blank" rel="noreferrer">${problem.name}</a>${elsewhere}
        ${
          tags || extraNote
            ? `<div class="problem-tags">${tags}${tags && extraNote ? ' · ' : ''}${extraNote}</div>`
            : ''
        }
      </td>
      <td style="width:70px">${ratingBadge(problem.rating)}</td>
      <td style="width:90px" class="problem-tags">${problem.solvedCount} 人过</td>
      <td style="width:44px">
        <button type="button" class="block-btn" data-block-key="${key}"
                data-block-contest="${problem.contestId}" data-block-index="${problem.index}"
                data-block-name="${escapeHtml(problem.name)}" data-block-rating="${problem.rating ?? ''}"
                title="永久屏蔽这道题，以后不再推荐">✕</button>
      </td>
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

$('plan-stages').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;

  const contestId = Number(checkbox.dataset.contest);
  const index = checkbox.dataset.index;
  const key = `${contestId}-${index}`;
  const done = checkbox.checked;
  const row = checkbox.closest('tr');
  row.classList.toggle('done', done);
  if (done) state.done.add(key);
  else state.done.delete(key);

  try {
    await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: state.handle, target: state.target, contestId, index, done }),
    });
  } catch {
    setStatus('进度保存失败，本地勾选仍在');
  }
});

$('handle-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadUser();
});
// ---------- 永久屏蔽题目 ----------
// 有些题就是不想再做（题目本身有问题、或者不符合你的训练方向）。
// 屏蔽后不会再出现在任何推荐里，但随时可以在设置里恢复。

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
          <span class="record-code">${item.contestId}${item.index}</span>
          <a href="https://codeforces.com/problemset/problem/${item.contestId}/${item.index}"
             target="_blank" rel="noreferrer">${escapeHtml(item.name ?? '（题库里没有这道题）')}</a>
        </span>
        <span>${ratingBadge(item.rating)}</span>
        <button type="button" class="btn" data-unblock-contest="${item.contestId}"
                data-unblock-index="${item.index}" style="padding:4px 10px;font-size:12px">恢复</button>
      </div>`,
    )
    .join('');
}

/** 做过的题：按首次通过时间从近到远，每次加载 100 道。 */
function renderSolved() {
  const list = state.solved ?? [];
  $('solved-summary').textContent =
    `一共通过 ${state.solvedTotal} 道题，下面是最近的 ${list.length} 道（按通过时间从近到远）。`;
  $('solved-list').innerHTML = list
    .map(
      (item) => `<div class="record-row">
        <span class="record-time">${new Date(item.firstAcAt * 1000).toLocaleDateString('zh-CN')}</span>
        <span class="record-name">
          <span class="record-code">${item.contestId}${item.index}</span>
          <a href="https://codeforces.com/problemset/problem/${item.contestId}/${item.index}"
             target="_blank" rel="noreferrer">${escapeHtml(item.name ?? '（题库里没有这道题）')}</a>
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
    $('panel-records').classList.remove('hidden');
  } catch (error) {
    $('panel-records').classList.remove('hidden');
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
  const button = event.target.closest('[data-block-key]');
  if (!button) return;
  blockProblem({
    contestId: Number(button.dataset.blockContest),
    index: button.dataset.blockIndex,
    name: button.dataset.blockName,
    rating: button.dataset.blockRating ? Number(button.dataset.blockRating) : null,
  });
});

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
$('plan-btn').addEventListener('click', () => generatePlan(false));

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
  $('panel-calendar').classList.remove('hidden');
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
    $('panel-virtual').classList.remove('hidden');
    $('virtual-summary').textContent = `虚拟参赛加载失败：${error.message}`;
  }
}

function renderVirtual(data) {
  state.virtual = data;
  const running = data.running ?? null;
  $('panel-virtual').classList.remove('hidden');

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
          <td class="problem-code">${problem.contestId}${problem.index}</td>
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
    $('panel-heatmap').classList.remove('hidden');
  } catch (error) {
    $('panel-heatmap').classList.remove('hidden');
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

function rebuildSchedule() {
  if (!state.planProblems.length) return;
  state.schedule = buildSchedule({
    problems: state.planProblems,
    weekly: state.weekly,
    restDays: state.restDays,
    dayOff: state.dayOff,
    startDate: new Date(),
  });
  if (!state.calCursor) {
    const now = new Date();
    state.calCursor = { year: now.getFullYear(), month: now.getMonth() };
  }
  if (!state.selectedDate) state.selectedDate = dateKey(new Date());
  renderSchedule();
}

function renderSchedule() {
  $('panel-schedule').classList.remove('hidden');
  const schedule = state.schedule;
  if (!schedule) {
    $('schedule-summary').textContent = '先生成训练计划，再来排日程。';
    return;
  }

  $('schedule-summary').textContent =
    `从今天（${formatMonthDay(schedule.startDate)}）开始，到 ${formatMonthDay(schedule.endDate)} 做完 ${schedule.totalProblems} 题；` +
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
      `<p class="subtle">${isOff ? '这天休息，题目会自动顺延到后面，总量不变。' : '这一天没有安排题目。'}</p>`;
  } else {
    const stageOf = day.problems[0]?.stage ?? 1;
    const rows = day.problems
      .map(
        (problem) => `
      <tr>
        <td class="problem-code">${problem.contestId}${problem.index}</td>
        <td><a class="problem-name" href="${problem.url}" target="_blank" rel="noreferrer">${problem.name}</a>
            ${state.luoguKeys.has(`${problem.contestId}-${problem.index}`) ? '<span class="solved-elsewhere">洛谷做过</span>' : ''}
            <div class="problem-tags">${tagSpans(problem.tags, 3)}</div></td>
        <td style="width:70px">${ratingBadge(problem.rating)}</td>
        <td style="width:86px" class="problem-tags">第 ${problem.stage ?? stageOf} 阶段</td>
      </tr>`,
      )
      .join('');
    $('day-detail').innerHTML = header + `<table class="problem-table">${rows}</table>`;
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
  const upcoming = state.schedule.days.slice(0, 10);
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
          .map((problem) => `${problem.contestId}${problem.index}`)
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

// ---------- 面板展开 / 收起 ----------

// 第一个面板是输账号的入口，始终保持展开
const COLLAPSIBLE_PANELS = [
  'panel-overview',
  'panel-target',
  'panel-plan',
  'panel-schedule',
  'panel-calendar',
  'panel-virtual',
  'panel-heatmap',
  'panel-platforms',
  'panel-records',
  'panel-tags',
];

function setupPanelToggles() {
  for (const id of COLLAPSIBLE_PANELS) {
    const panel = $(id);
    if (!panel || panel.querySelector('.panel-toggle')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-toggle';
    button.dataset.panel = id;
    button.title = '收起或展开这一块';
    panel.appendChild(button);
  }
}

function applyCollapsed() {
  for (const id of COLLAPSIBLE_PANELS) {
    const panel = $(id);
    if (panel) panel.classList.toggle('collapsed', Boolean(state.collapsed[id]));
  }
}

function setCollapsed(id, collapsed, { save = true } = {}) {
  if (collapsed) state.collapsed[id] = true;
  else delete state.collapsed[id];
  const panel = $(id);
  if (panel) panel.classList.toggle('collapsed', collapsed);
  if (save) saveSettings({ collapsed: state.collapsed });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('.panel-toggle');
  if (button) {
    setCollapsed(button.dataset.panel, !state.collapsed[button.dataset.panel]);
    return;
  }
  // 已经收起的面板，点它任意位置都展开——误触之后不用去找按钮
  const collapsed = event.target.closest('section.panel.collapsed');
  if (collapsed && COLLAPSIBLE_PANELS.includes(collapsed.id)) {
    setCollapsed(collapsed.id, false);
  }
});

// 从导航点进去时，如果那块是收起的就先展开，否则跳过去什么都看不到
$('subnav').addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#panel-"]');
  if (!link) return;
  const id = link.getAttribute('href').slice(1);
  if (state.collapsed[id]) setCollapsed(id, false);
});

$('expand-all').addEventListener('click', () => {
  state.collapsed = {};
  applyCollapsed();
  saveSettings({ collapsed: {} });
});

$('collapse-all').addEventListener('click', () => {
  state.collapsed = Object.fromEntries(COLLAPSIBLE_PANELS.map((id) => [id, true]));
  applyCollapsed();
  saveSettings({ collapsed: state.collapsed });
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
    const link = document.querySelector(`.subnav a[href="#${id}"]`);
    if (link) link.classList.toggle('module-hidden', hidden);
    // 模块整个藏起来了，它的收起状态就没意义了
    if (hidden) delete state.collapsed[id];
  }
  applyCollapsed();
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
      const { platforms } = await getJson('/api/platforms');
      state.platforms = platforms;
      refreshLuoguKeys();
      renderPlatformCards();
  } catch {
    /* 读不到就先不显示 */
  }
}

const PLATFORM_LABELS = { nowcoder: '牛客', luogu: '洛谷' };
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
    $('panel-platforms').classList.add('hidden');
    $('platform-charts').innerHTML =
      '<p class="subtle">还没有同步任何平台。到「设置」里填入洛谷或牛客的用户 ID，点同步即可。</p>';
    return;
  }
  $('panel-platforms').classList.remove('hidden');
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
    if (state.planData) renderPlan(state.planData);
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
    state.collapsed = settings.collapsed ?? {};
    state.hiddenModules = Array.isArray(settings.hiddenModules) ? settings.hiddenModules : [];
    if (settings.nowcoderUid) {
      state.nowcoderUid = settings.nowcoderUid;
      $('nowcoder-input').value = settings.nowcoderUid;
    }
    if (settings.luoguUid) $('luogu-input').value = settings.luoguUid;
    if (settings.floorGap !== null && settings.floorGap !== undefined) {
      $('floor-gap-input').value = settings.floorGap;
    }
    state.hideTags = Boolean(settings.hideTags);
    $('hide-tags').checked = state.hideTags;
    if (settings.tagShare !== null && settings.tagShare !== undefined) {
      $('tag-share-input').value = settings.tagShare;
    }
  }
  applyAppearance();
  setupPanelToggles();
  applyCollapsed();
  renderModuleList();
  applyModuleVisibility();
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
}

bindAppearance();
restoreSession();
