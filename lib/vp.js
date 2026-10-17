// 区域赛 VP 链接抓取：QOJ 比赛列表 + Codeforces 比赛列表。
//
// 两个源的可达性（2026-10 实测）：
// - QOJ：/contests 公开可抓，但**必须带浏览器 UA**，否则吃 Cloudflare 403；
//   用户主页/提交列表要登录，抓不了（所以「平台数据」不放 QOJ 战绩）。
// - CF：gym 要登录，但 codeforces.com/api/contest.list 公开且不带挑战，
//   很多区域赛在 CF 是正式赛（能 VP 也能看题）。
//
// 结果按 meta 'vp_cache' 缓存 24 小时——600KB 的 QOJ 页面没必要每次都拉。

import { spawnSync } from 'node:child_process';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CACHE_KEY = 'vp_cache';
const CACHE_TTL = 24 * 60 * 60 * 1000;

// 区域赛相关的名字特征。宁多勿漏：筛选交给界面上的搜索框，
// 这里只把明显无关的（Div. 2、Educational、AtCoder 之类）挡在外面。
const VP_NAME_RE = /ICPC|CCPC|Regional|Qualifier|Invitational|Provincial|China Final|EC-Final|World Finals/i;

async function get(url, { tries = 3, timeoutMs = 25000, accept = 'text/html,application/xhtml+xml' } = {}) {
  let lastError;
  let lastStatus = 0;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        lastStatus = response.status;
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  // Cloudflare 按 TLS 指纹拦 Node 的 fetch（换什么浏览器头都一样，实测 403），
  // 但系统 curl 的指纹能过。403 时用 curl 兜一把——Windows 10+ 自带，Linux 更不用说。
  if (lastStatus === 403) {
    try {
      return curlGet(url);
    } catch (curlError) {
      throw new Error(`HTTP 403（fetch 与 curl 都被 Cloudflare 拦下）`);
    }
  }
  throw lastError;
}

/** 用系统 curl 抓一页文本。绕开 Node fetch 的 TLS 指纹问题。 */
function curlGet(url) {
  const result = spawnSync(
    'curl',
    ['-s', '--max-time', '30', '--noproxy', '*', '-L', '-A', USER_AGENT, '-H', 'Accept: text/html', url],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 35000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`curl 退出码 ${result.status}`);
  const text = result.stdout;
  if (!text || text.includes('Just a moment')) throw new Error('curl 也被 Cloudflare 挑战');
  return text;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * QOJ 比赛列表。/contests 一页给了全部比赛（3500+），表格行结构：
 *   <td><a href="/contest/4538">名字</a></td><td>时间（可空）</td><td>时长</td><td>人数</td>
 * 时间在 <time datetime="..."> 里，VP 库里的比赛很多没设时间（「-」），照常收。
 */
async function fetchQojContests() {
  const html = await get('https://qoj.ac/contests');
  const items = [];
  const seen = new Set();
  const rowRe = /<td><a href="\/contest\/(\d+)">([\s\S]*?)<\/a><\/td><td>([\s\S]*?)<\/td>/g;
  let match;
  while ((match = rowRe.exec(html))) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = decodeEntities(match[2].replace(/<[^>]+>/g, ''));
    if (!VP_NAME_RE.test(name)) continue;
    const timeMatch = match[3].match(/datetime="([^"]+)"/);
    const time = timeMatch ? Date.parse(timeMatch[1]) : null;
    items.push({
      platform: 'qoj',
      id,
      name,
      url: `https://qoj.ac/contest/${id}`,
      time: Number.isFinite(time) ? time : null,
    });
  }
  return items;
}

/**
 * CF 比赛列表。官方 API，gym 不含（要登录），但区域赛/邀请赛大多是正式赛。
 * 返回按 id 倒序（最新的在前），startTimeSeconds 是开赛时间。
 */
async function fetchCfContests() {
  const raw = await get('https://codeforces.com/api/contest.list?gym=false', {
    accept: 'application/json',
  });
  const data = JSON.parse(raw);
  if (data.status !== 'OK' || !Array.isArray(data.result)) {
    throw new Error(data.comment || 'CF API 返回异常');
  }
  const items = [];
  for (const contest of data.result) {
    if (!VP_NAME_RE.test(contest.name ?? '')) continue;
    items.push({
      platform: 'cf',
      id: String(contest.id),
      name: contest.name,
      url: `https://codeforces.com/contest/${contest.id}`,
      time: contest.startTimeSeconds ? contest.startTimeSeconds * 1000 : null,
    });
  }
  return items;
}

/** 现抓两个源。单个源挂了不拖死整体——返回 errors 里带上原因。 */
export async function fetchVpList() {
  const items = [];
  const errors = {};
  const sources = [
    ['qoj', fetchQojContests],
    ['cf', fetchCfContests],
  ];
  await Promise.all(
    sources.map(async ([key, fn]) => {
      try {
        items.push(...(await fn()));
      } catch (error) {
        errors[key] = error.message;
      }
    }),
  );
  // 有时间的按时间倒排（新比赛在前），没时间的（VP 库大部分）按平台+名称排后面
  items.sort((a, b) => {
    if (a.time && b.time) return b.time - a.time;
    if (a.time) return -1;
    if (b.time) return 1;
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { items, errors };
}

/**
 * 带 24h 缓存的入口。refresh=true（界面上的「刷新」按钮）或缓存过期才真抓。
 * 全挂且没缓存时返回空列表 + errors；有旧缓存就用旧的，别让一次网络抖动清空界面。
 */
export async function getVpList(db, { refresh = false } = {}) {
  let cached = null;
  try {
    const raw = db.metaGet(CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch {
    cached = null;
  }
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL;
  if (!refresh && fresh && cached.items?.length) {
    return { items: cached.items, errors: cached.errors ?? {}, cached: true, fetchedAt: cached.fetchedAt };
  }
  const result = await fetchVpList();
  if (result.items.length) {
    db.metaSet(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), items: result.items, errors: result.errors }));
    return { ...result, cached: false, fetchedAt: Date.now() };
  }
  // 两个源都挂：有旧缓存给旧的，没旧缓存就空手而归（错误带上）
  if (cached?.items?.length) {
    return { items: cached.items, errors: result.errors, cached: true, fetchedAt: cached.fetchedAt };
  }
  return { items: [], errors: result.errors, cached: false, fetchedAt: null };
}
