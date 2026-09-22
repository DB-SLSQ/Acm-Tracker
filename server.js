import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as cf from './lib/cf.js';
import * as db from './lib/db.js';
import { buildPlan, deriveProgress, rankFocusTags, toClientProblem } from './lib/plan.js';
import { buildTagProfile, isNoiseTag } from './lib/knowledge.js';
import {
  analyzeVirtualSession,
  divisionFit,
  parseContestInfo,
  recommendVirtualContests,
} from './lib/contests.js';
import { fetchLuogu, fetchNowcoder, PlatformError } from './lib/platforms.js';
import * as modelModule from './lib/model.js';

// 同一个账号多久之内不重复抓取（毫秒）。手动同步也走这个限制，防止连点。
const SYNC_COOLDOWN_MS = 20_000;
const recentSyncs = new Map();

// 后台训练任务：一次只能跑一个，进度靠这个对象回传，前端轮询。
const training = {
  running: false,
  lines: [],
  startedAt: null,
  finishedAt: null,
  error: null,
};

function pushTrainingLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    training.lines.push(trimmed);
  }
  // 只留最近的一段，前端够显示就行
  if (training.lines.length > 60) training.lines.splice(0, training.lines.length - 60);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const DEFAULT_PORT = Number(process.env.PORT || 5173);
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';

// 版本号取自 package.json，界面底部会显示，方便确认装的是哪个版本
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

const USER_CACHE_MS = 1000 * 60 * 60 * 6; // 用户数据 6 小时内不重复抓
const PROBLEMS_CACHE_MS = 1000 * 60 * 60 * 24; // 题库每天更新一次
const CONTESTS_CACHE_MS = 1000 * 60 * 60 * 12; // 比赛目录每 12 小时更新一次

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
]);

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isFresh(updatedAt, windowMs) {
  return updatedAt != null && Date.now() - updatedAt < windowMs;
}

async function ensureProblems({ force = false } = {}) {
  const count = db.countProblems();
  const updatedAt = Number(db.metaGet('problems_updated_at') || 0);
  if (!force && count > 3000 && isFresh(updatedAt, PROBLEMS_CACHE_MS)) {
    return { count, updatedAt, refreshed: false };
  }
  const data = await cf.getProblemset();
  const inserted = db.replaceProblems(data);
  const now = Date.now();
  db.metaSet('problems_updated_at', now);
  return { count: inserted, updatedAt: now, refreshed: true };
}

async function ensureContests({ force = false } = {}) {
  const count = db.countContests();
  const updatedAt = Number(db.metaGet('contests_updated_at') || 0);
  if (!force && count > 100 && isFresh(updatedAt, CONTESTS_CACHE_MS)) {
    return { count, updatedAt, refreshed: false };
  }
  const list = await cf.getContestList();
  const inserted = db.replaceContests(list);
  const now = Date.now();
  db.metaSet('contests_updated_at', now);
  return { count: inserted, updatedAt: now, refreshed: true };
}

/**
 * 拉取提交记录。
 * 有同步游标时只补新记录（往前多取 24 小时容错），首次同步才全量重建。
 */
async function loadSubmissions(handleKey, handle, { full = false } = {}) {
  const cursor = db.getSyncCursor(handleKey);
  const incremental = !full && cursor > 0;
  const stopBefore = incremental ? cursor - 24 * 3600 : 0;

  const { rows, newest } = await cf.getAllSubmissions(handle, { stopBefore });
  const inserted = incremental
    ? db.appendSubmissions(handleKey, rows)
    : db.replaceSubmissions(handleKey, rows);

  if (newest > 0) db.setSyncCursor(handleKey, Math.max(cursor, newest));
  return inserted;
}

async function loadUser(rawHandle, { force = false } = {}) {
  const handleKey = db.normalizeHandle(rawHandle);
  const cached = db.getUser(handleKey);

  if (!force && cached && isFresh(cached.updatedAt, USER_CACHE_MS)) {
    return { user: cached, refreshed: false };
  }

  const info = await cf.getUser(rawHandle);
  const user = {
    displayHandle: info.handle ?? rawHandle,
    rating: info.rating ?? null,
    maxRating: info.maxRating ?? null,
    rank: info.rank ?? null,
    maxRank: info.maxRank ?? null,
    titlePhoto: info.titlePhoto ?? null,
  };
  db.saveUser(handleKey, user);

  const ratingHistory = await cf.getRatingHistory(rawHandle);
  db.replaceRatingHistory(handleKey, ratingHistory);
  await loadSubmissions(handleKey, rawHandle, { full: force });

  return { user: db.getUser(handleKey), refreshed: true };
}

function buildUserSummary(handleKey) {
  const user = db.getUser(handleKey);
  if (!user) return null;
  const submissions = db.getSubmissions(handleKey);
  const { solved, attempted } = deriveProgress(submissions);
  return {
    ...user,
    submissionCount: submissions.length,
    solvedCount: solved.size,
    attemptedCount: attempted.size,
    ratingHistory: db.getRatingHistory(handleKey),
  };
}

export const THEMES = ['dark', 'light', 'gray', 'eye'];
export const PALETTES = ['green', 'blue', 'pink', 'orange', 'purple'];

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

/** 用户设置：从数据库的字符串还原成有类型的对象。 */
/**
 * 单个标签的占比上限：设置里存百分数，算法里用 0~1。
 * 没设置过用默认 40%，超出范围夹回合法区间，避免脏数据把题单撑爆。
 */
function normalizeTagShare(value) {
  const percent = Number.isFinite(value) ? Math.min(90, Math.max(10, value)) : 40;
  return percent / 100;
}

function readSettings() {
  const raw = db.getSettings();
  return {
    handle: raw.handle ?? null,
    target: raw.target ? Number(raw.target) : null,
    weekly: raw.weekly ? Number(raw.weekly) : null,
    theme: THEMES.includes(raw.theme) ? raw.theme : 'dark',
    heatmapPalette: PALETTES.includes(raw.heatmap_palette) ? raw.heatmap_palette : 'green',
    // 每周固定休息的日子：0=周日 … 6=周六
    restDays: parseJson(raw.rest_days, []),
    // 特定日期无法做题：{ 'YYYY-MM-DD': '聚餐' }
    dayOff: parseJson(raw.day_off, {}),
    // 被收起的面板：{ 'panel-plan': true }
    collapsed: parseJson(raw.collapsed, {}),
    // 被整个隐藏的模块：['panel-virtual', ...]
    hiddenModules: parseJson(raw.hidden_modules, []),
    // 其他平台的账号
    nowcoderUid: raw.nowcoder_uid ?? null,
    luoguUid: raw.luogu_uid ?? null,
      // 评估水平时忽略「比当前 rating 低多少分」以内的题（null = 用默认值）
      floorGap: raw.floor_gap === undefined ? null : Number(raw.floor_gap),
      // 单个标签在题单里的占比上限，存的是百分数（null = 用默认值 40）
      tagShare: raw.tag_share === undefined ? null : Number(raw.tag_share),
      updatedAt: raw.updated_at ? Number(raw.updated_at) : null,
  };
}

async function handlePlan(url) {
  const rawHandle = url.searchParams.get('handle');
  const target = Number(url.searchParams.get('target'));
  const weekly = Number(url.searchParams.get('weekly') || 10);
  const force = url.searchParams.get('refresh') === '1';

  if (!rawHandle) return { status: 400, body: { error: '请先填写 Codeforces 用户名' } };
  if (!Number.isFinite(target) || target < 800 || target > 4000) {
    return { status: 400, body: { error: '目标 rating 需要在 800 到 4000 之间' } };
  }

  const problemsState = await ensureProblems();
  await loadUser(rawHandle, { force });

  // 训练过的推题模型（可能没有，或者没通过验证）
  const model = modelModule.parseModel(db.metaGet(modelModule.MODEL_KEY));

  const handleKey = db.normalizeHandle(rawHandle);
  const user = db.getUser(handleKey);
  const submissions = db.getSubmissions(handleKey);
  const { solved, attempted } = deriveProgress(submissions);

  const plan = buildPlan({
    user,
    solved,
    attempted,
    problems: db.getAllProblems(),
      target: Math.round(target),
      weekly: Number.isFinite(weekly) && weekly > 0 ? Math.round(weekly) : 10,
      floorGap: readSettings().floorGap,
      // 设置里存的是百分数，算法里用 0~1 的比例
      tagShare: normalizeTagShare(readSettings().tagShare),
      model,
      // 题目年份偏好要用：老题在人气分上占便宜，靠比赛开始时间把新题提上来
      contestDates: new Map(db.getContests().map((contest) => [contest.id, contest.startTime])),
      // 用户手动屏蔽的题，永远不再推荐
      blocked: new Set(db.blockedKeys(handleKey)),
    });

  const done = db.getProgress(handleKey, Math.round(target));
  return {
    status: 200,
    body: {
      user: {
        ...user,
        submissionCount: submissions.length,
        solvedCount: solved.size,
        ratingHistory: db.getRatingHistory(handleKey),
      },
      problemsState,
      done,
      plan,
    },
  };
}

function decorateContest(contest) {
  return {
    id: contest.id,
    name: contest.name,
    division: parseContestInfo(contest.name).division,
    startTime: contest.startTime,
    durationSeconds: contest.duration,
    url: `https://codeforces.com/contest/${contest.id}`,
  };
}

/** 比赛日历：未来一段时间内已公布赛程的 Codeforces 比赛。 */
async function handleCalendar(url) {
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days') || 14)));
  const rawHandle = url.searchParams.get('handle');
  const contestsState = await ensureContests();

  const now = Math.floor(Date.now() / 1000);
  const until = now + days * 86400;
  const upcoming = db
    .getUpcomingContests(200)
    .filter((contest) => contest.type === 'CF' && contest.startTime <= until);

  let current = null;
  if (rawHandle) {
    const cached = db.getUser(db.normalizeHandle(rawHandle));
    if (cached?.rating) current = cached.rating;
  }

  return {
    contestsState,
    now,
    days,
    upcoming: upcoming.map((contest) => {
      const info = parseContestInfo(contest.name);
      return {
        id: contest.id,
        name: contest.name,
        division: info.division,
        startTime: contest.startTime,
        durationSeconds: contest.duration,
        url: `https://codeforces.com/contest/${contest.id}`,
        fit: current == null ? null : divisionFit(info.division, current),
      };
    }),
  };
}

/** 虚拟参赛：进行中的场次、推荐场次、赛后复盘、历史记录。 */
async function handleVirtual(url) {
  const rawHandle = url.searchParams.get('handle');
  if (!rawHandle) return { status: 400, body: { error: '请先填写 Codeforces 用户名' } };

  const targetParam = Number(url.searchParams.get('target'));
  await ensureContests();
  await ensureProblems();
  await loadUser(rawHandle);

  const handleKey = db.normalizeHandle(rawHandle);
  const user = db.getUser(handleKey);
  const current = user?.rating && user.rating > 0 ? user.rating : 800;
  const target =
    Number.isFinite(targetParam) && targetParam >= 800 ? Math.round(targetParam) : current + 200;

  const submissions = db.getSubmissions(handleKey);
  const { solved } = deriveProgress(submissions);
  const problems = db.getAllProblems();
  const rated = problems.filter(
    (problem) => problem.type === 'PROGRAMMING' && problem.rating != null,
  );

  const sessions = db.listVirtualSessions(handleKey, 10);
  const running = sessions.find((session) => session.status === 'running') ?? null;

  // 复盘：默认看最近打完的那一场
  const reviewId = Number(url.searchParams.get('reviewId')) || 0;
  const reviewSession = reviewId
    ? sessions.find((session) => session.id === reviewId)
    : sessions.find((session) => session.status !== 'running');
  let review = null;
  if (reviewSession) {
    const contest = db.getContest(reviewSession.contestId);
    const contestProblems = rated.filter((problem) => problem.contestId === reviewSession.contestId);
    if (contest && contestProblems.length) {
      review = analyzeVirtualSession({
        session: reviewSession,
        contest,
        problems: contestProblems,
        submissions,
        current,
        target,
      });
    }
  }

  const history = sessions.map((session) => {
    const contest = db.getContest(session.contestId);
    return {
      id: session.id,
      contestId: session.contestId,
      contestName: contest?.name ?? `比赛 ${session.contestId}`,
      division: contest ? parseContestInfo(contest.name).division : null,
      startedAt: session.startedAt,
      durationSeconds: session.durationSeconds,
      status: session.status,
      url: `https://codeforces.com/contest/${session.contestId}`,
    };
  });

  let runningPayload = null;
  if (running) {
    const contest = db.getContest(running.contestId);
    const contestProblems = rated
      .filter((problem) => problem.contestId === running.contestId)
      .sort((a, b) => a.index.localeCompare(b.index));
    runningPayload = {
      session: running,
      contest: contest ? decorateContest(contest) : null,
      problems: contestProblems.map(toClientProblem),
      remainingSeconds: Math.round(
        (running.startedAt + running.durationSeconds * 1000 - Date.now()) / 1000,
      ),
    };
  }

  let recommendations = [];
  if (!running) {
    // 用和目标区间一致的弱项口径来挑比赛，保证"练的"和"打的"是一回事
    const solvedProblems = rated.filter((problem) =>
      solved.has(`${problem.contestId}-${problem.index}`),
    );
    const tagProfile = buildTagProfile(solvedProblems);
    const bandLower = Math.max(800, target - 250);
    const bandTags = new Set();
    for (const problem of rated) {
      if (problem.rating < bandLower || problem.rating > target + 150) continue;
      for (const tag of problem.tags) if (!isNoiseTag(tag)) bandTags.add(tag);
    }
    const weakTags = new Set(
      rankFocusTags({ tagProfile, bandTags, bandLower, bandCenter: target })
        .slice(0, 10)
        .map((row) => row.tag),
    );

    recommendations = recommendVirtualContests({
      contests: db.getContests(),
      problems,
      solved,
      weakTags,
      current,
      target,
      participatedContestIds: new Set(
        db.getRatingHistory(handleKey).map((entry) => entry.contestId),
      ),
      doneContestIds: new Set(sessions.map((session) => session.contestId)),
    });
  }

  return {
    status: 200,
    body: { current, target, running: runningPayload, recommendations, review, history },
  };
}

async function route(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, problems: db.countProblems() });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, { settings: readSettings() });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const patch = { updated_at: Date.now() };
      if (body.handle !== undefined) patch.handle = String(body.handle).trim();
      if (body.target !== undefined && Number.isFinite(Number(body.target))) {
        patch.target = Math.round(Number(body.target));
      }
      if (body.weekly !== undefined && Number.isFinite(Number(body.weekly))) {
        patch.weekly = Math.round(Number(body.weekly));
      }
      if (body.theme !== undefined) {
        if (!THEMES.includes(body.theme)) return sendError(res, 400, '不支持的主题');
        patch.theme = body.theme;
      }
      if (body.heatmapPalette !== undefined) {
        if (!PALETTES.includes(body.heatmapPalette)) return sendError(res, 400, '不支持的配色');
        patch.heatmap_palette = body.heatmapPalette;
      }
      if (body.restDays !== undefined) {
        if (!Array.isArray(body.restDays)) return sendError(res, 400, 'restDays 需要是数组');
        patch.rest_days = JSON.stringify(
          [...new Set(body.restDays.map(Number).filter((n) => n >= 0 && n <= 6))].sort(),
        );
      }
      if (body.dayOff !== undefined) {
        if (typeof body.dayOff !== 'object' || body.dayOff === null) {
          return sendError(res, 400, 'dayOff 需要是对象');
        }
        const clean = {};
        for (const [date, note] of Object.entries(body.dayOff)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          clean[date] = String(note ?? '').slice(0, 60);
        }
        patch.day_off = JSON.stringify(clean);
      }
      if (body.collapsed !== undefined) {
        if (typeof body.collapsed !== 'object' || body.collapsed === null) {
          return sendError(res, 400, 'collapsed 需要是对象');
        }
        const clean = {};
        for (const [panel, value] of Object.entries(body.collapsed)) {
          if (/^panel-[a-z-]+$/.test(panel) && value) clean[panel] = true;
        }
        patch.collapsed = JSON.stringify(clean);
      }
      if (body.hiddenModules !== undefined) {
        if (!Array.isArray(body.hiddenModules)) {
          return sendError(res, 400, 'hiddenModules 需要是数组');
        }
        patch.hidden_modules = JSON.stringify([
          ...new Set(body.hiddenModules.filter((id) => /^panel-[a-z-]+$/.test(id))),
        ]);
      }
      if (body.nowcoderUid !== undefined) patch.nowcoder_uid = String(body.nowcoderUid).trim();
      if (body.luoguUid !== undefined) patch.luogu_uid = String(body.luoguUid).trim();
      if (body.floorGap !== undefined) {
        const value = Number(body.floorGap);
        if (!Number.isFinite(value) || value < 0 || value > 2000) {
          return sendError(res, 400, '排除区间请填 0 到 2000 之间的数字');
        }
        patch.floor_gap = String(Math.round(value));
      }
      if (body.tagShare !== undefined) {
        const value = Number(body.tagShare);
        if (!Number.isFinite(value) || value < 10 || value > 90) {
          return sendError(res, 400, '单个标签占比上限请填 10 到 90 之间的数字');
        }
        patch.tag_share = String(Math.round(value));
      }
      db.saveSettings(patch);
      return sendJson(res, 200, { settings: readSettings() });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  // ---------- 推题模型：后台训练 + 进度查询 ----------
  if (pathname === '/api/model' && req.method === 'GET') {
    const model = modelModule.parseModel(db.metaGet(modelModule.MODEL_KEY));
    return sendJson(res, 200, {
      samples: db.countModelSamples(),
      training: {
        running: training.running,
        lines: training.lines,
        startedAt: training.startedAt,
        finishedAt: training.finishedAt,
        error: training.error,
      },
      model: model
        ? {
            trainedAt: model.trainedAt ?? null,
            samples: model.samples ?? null,
            contests: model.contests ?? null,
            auc: model.metrics?.auc ?? null,
            baselineAuc: model.baseline?.auc ?? null,
            logLoss: model.metrics?.logLoss ?? null,
            baselineLogLoss: model.baseline?.logLoss ?? null,
            active: modelModule.isModelUseful(model),
          }
        : null,
    });
  }

  if (pathname === '/api/model/train' && req.method === 'POST') {
    if (training.running) return sendError(res, 409, '已经有一个训练任务在跑了');
    const body = await readJsonBody(req).catch(() => ({}));
    const contests = Math.max(1, Math.min(2000, Number(body.contests) || 300));
    const extra = body.reset ? ['--reset'] : [];
    const child = spawn(
      process.execPath,
      ['--no-warnings', join(HERE, 'scripts', 'train-model.js'), '--contests', String(contests), ...extra],
      { cwd: HERE, env: process.env },
    );
    training.running = true;
    training.lines = [`开始采集 ${contests} 场比赛的数据…`];
    training.startedAt = Date.now();
    training.finishedAt = null;
    training.error = null;
    child.stdout.on('data', (chunk) => pushTrainingLine(chunk));
    child.stderr.on('data', (chunk) => pushTrainingLine(chunk));
    child.on('error', (error) => {
      training.error = error.message;
    });
    child.on('close', (code) => {
      training.running = false;
      training.finishedAt = Date.now();
      if (code !== 0 && !training.error) training.error = `训练进程异常退出（代码 ${code}）`;
      pushTrainingLine(code === 0 ? '训练结束。' : '训练中断。');
    });
    return sendJson(res, 202, { started: true, contests });
  }

  if (pathname === '/api/activity') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const handleKey = db.normalizeHandle(rawHandle);
    if (!db.getUser(handleKey)) return sendError(res, 404, '还没有这个用户的数据，请先加载一次');
    const offsetSeconds = Number(url.searchParams.get('offset') || 0);
    const activity = db.getDailyActivity(
      handleKey,
      Number.isFinite(offsetSeconds) ? Math.round(offsetSeconds) : 0,
    );
    return sendJson(res, 200, { activity });
  }

  if (pathname === '/api/platforms' && req.method === 'GET') {
    return sendJson(res, 200, { platforms: db.listPlatformStats() });
  }

  // 手动屏蔽的题目：屏蔽后永远不再出现在推荐里
  if (pathname === '/api/blocked' && req.method === 'GET') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    return sendJson(res, 200, { blocked: db.listBlockedProblems(db.normalizeHandle(rawHandle)) });
  }

  // 做过的题，按首次通过时间倒序
  if (pathname === '/api/solved') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const handleKey = db.normalizeHandle(rawHandle);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    return sendJson(res, 200, {
      total: db.countSolved(handleKey),
      solved: db.recentlySolved(handleKey, limit, offset),
    });
  }

  if (pathname === '/api/blocked' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const contestId = Number(body.contestId);
      if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
      if (!Number.isFinite(contestId) || !body.index) return sendError(res, 400, '题目参数不完整');
      db.blockProblem(handleKey, {
        contestId,
        index: String(body.index),
        name: body.name,
        rating: Number.isFinite(Number(body.rating)) ? Number(body.rating) : null,
        reason: body.reason,
      });
      return sendJson(res, 200, { blocked: db.listBlockedProblems(handleKey) });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/blocked' && req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const contestId = Number(body.contestId);
      if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
      if (!Number.isFinite(contestId) || !body.index) return sendError(res, 400, '题目参数不完整');
      db.unblockProblem(handleKey, contestId, String(body.index));
      return sendJson(res, 200, { blocked: db.listBlockedProblems(handleKey) });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/platforms/sync' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const platform = String(body.platform ?? '');
      const account = String(body.account ?? '').trim();
      if (!['nowcoder', 'luogu'].includes(platform)) {
        return sendError(res, 400, '暂不支持这个平台');
      }
      if (!account) return sendError(res, 400, '请先填写用户 ID');

      const key = `${platform}:${account}`;
      if (Date.now() - (recentSyncs.get(key) ?? 0) < SYNC_COOLDOWN_MS) {
        return sendError(res, 429, '刚刚同步过，等 20 秒再试');
      }
      recentSyncs.set(key, Date.now());

      const result = platform === 'luogu' ? await fetchLuogu(account) : await fetchNowcoder(account);
      db.savePlatformStats(result);
      return sendJson(res, 200, { result, platforms: db.listPlatformStats() });
    } catch (error) {
      const message = error instanceof PlatformError ? error.message : `同步失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/calendar') {
    try {
      return sendJson(res, 200, await handleCalendar(url));
    } catch (error) {
      const message = error instanceof cf.CfError ? error.message : `获取赛程失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/virtual' && req.method === 'GET') {
    try {
      const result = await handleVirtual(url);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      const message =
        error instanceof cf.CfError ? error.message : `读取虚拟参赛失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/virtual/start' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      if (!handleKey) return sendError(res, 400, '请先填写 Codeforces 用户名');
      const contest = db.getContest(Number(body.contestId));
      if (!contest) return sendError(res, 404, '找不到这场比赛，刷新赛程后重试');

      const existing = db.getRunningSession(handleKey);
      if (existing) db.finishVirtualSession(existing.id);

      const durationSeconds =
        Number(body.durationSeconds) > 0 ? Number(body.durationSeconds) : contest.duration;
      const session = db.createVirtualSession(handleKey, contest.id, durationSeconds);
      return sendJson(res, 200, { session });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/virtual/finish' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const running = db.getRunningSession(handleKey);
      if (!running) return sendError(res, 400, '当前没有进行中的虚拟赛');
      return sendJson(res, 200, { session: db.finishVirtualSession(running.id) });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === '/api/user') {
    const rawHandle = url.searchParams.get('handle');
    if (!rawHandle) return sendError(res, 400, '请先填写 Codeforces 用户名');
    const force = url.searchParams.get('refresh') === '1';
    try {
      await ensureProblems();
      await loadUser(rawHandle, { force });
      const summary = buildUserSummary(db.normalizeHandle(rawHandle));
      return sendJson(res, 200, { user: summary });
    } catch (error) {
      const message = error instanceof cf.CfError ? error.message : `抓取失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/plan') {
    try {
      const result = await handlePlan(url);
      return sendJson(res, result.status, result.body);
    } catch (error) {
      const message = error instanceof cf.CfError ? error.message : `生成计划失败：${error.message}`;
      return sendError(res, 502, message);
    }
  }

  if (pathname === '/api/progress' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const handleKey = db.normalizeHandle(body.handle);
      const target = Number(body.target);
      const contestId = Number(body.contestId);
      if (!handleKey || !Number.isFinite(target) || !Number.isFinite(contestId) || !body.index) {
        return sendError(res, 400, '参数不完整');
      }
      db.setProgress(handleKey, target, contestId, String(body.index), Boolean(body.done));
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname.startsWith('/api/')) {
    return sendError(res, 404, '接口不存在');
  }

  return serveStatic(res, pathname);
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, relative));
  const root = normalize(PUBLIC_DIR + sep);

  if (!target.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME.get(extname(target)) ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('页面不存在');
  }
}

const requestHandler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  route(req, res, url).catch((error) => {
    console.error('[server]', error);
    if (!res.headersSent) sendError(res, 500, error.message);
  });
};

/**
 * 启动服务。桌面程序传 port: 0 让系统分配空闲端口，避免和别的程序撞车。
 * 返回 { server, port, url }。
 */
export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, quiet = false } = {}) {
  const server = createServer(requestHandler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const url = `http://${host}:${actualPort}`;
      if (!quiet) {
        console.log('');
        console.log('  ACM 训练台已启动');
        console.log(`  在浏览器里打开：${url}`);
        console.log('  按 Ctrl+C 停止');
        console.log('');
      }
      resolve({ server, port: actualPort, url });
    });
  });
}

// 直接用 node server.js 运行时才自动启动；被桌面程序 import 时不启动。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startServer().catch((error) => {
    console.error('启动失败：', error.message);
    process.exit(1);
  });
}
