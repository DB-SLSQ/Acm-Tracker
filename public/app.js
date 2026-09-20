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

      return `
        <div class="stage">
          <div class="stage-head">
            <div>
              <div class="stage-title">${stage.label} · 练 ${stage.band[0]} ~ ${stage.band[1]} 分</div>
              <div class="stage-meta">约 ${stage.count} 题 / ${stage.weeks} 周 · 该区间还有 ${stage.unsolvedSupply} 道你没做过的题</div>
            </div>
            <div class="stage-meta">目标水平 ${stage.targetRating}</div>
          </div>
          <div class="stage-body">
            <div class="focus-tags">
              <span class="stage-meta">重点补强：</span>
              ${stage.focusTags
                .map(
                  (item) =>
                    `<span class="tag-pill">${item.tag}<span class="pill-note">${KIND_LABEL[item.kind] ?? ''}</span></span>`,
                )
                .join('')}
            </div>
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
  const tags = problem.tags.slice(0, 3).join('、');
  return `
    <tr class="${isDone ? 'done' : ''}" data-key="${key}">
      <td style="width:28px">
        <input type="checkbox" ${isDone ? 'checked' : ''}
               data-contest="${problem.contestId}" data-index="${problem.index}" />
      </td>
      <td class="problem-code">${problem.contestId}${problem.index}</td>
      <td>
        <a class="problem-name" href="${problem.url}" target="_blank" rel="noreferrer">${problem.name}</a>
        <div class="problem-tags">${tags}${extraNote ? ` · ${extraNote}` : ''}</div>
      </td>
      <td style="width:70px">${ratingBadge(problem.rating)}</td>
      <td style="width:90px" class="problem-tags">${problem.solvedCount} 人过</td>
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
          <span>${entry.tag}<span class="pill-note">${KIND_LABEL[entry.kind] ?? ''}</span></span>
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
              <div class="problem-tags">${problem.tags.slice(0, 3).join('、')}</div></td>
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
            <div class="problem-tags">${row.tags.slice(0, 3).join('、')}</div>
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
            <div class="problem-tags">${problem.tags.slice(0, 3).join('、')}</div></td>
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
  }
  applyAppearance();
  setupPanelToggles();
  applyCollapsed();

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
