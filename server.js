import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const DEFAULT_PORT = Number(process.env.PORT || 5173);
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';

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
    return sendJson(res, 200, { ok: true, problems: db.countProblems() });
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
