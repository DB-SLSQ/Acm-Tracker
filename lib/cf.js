// Codeforces 官方 API 客户端。
// 官方建议：同一时间只发一个请求，且两次请求间隔至少 2 秒。
// 这里用一个串行队列 + 最小间隔来满足，避免被限流。

const BASE = 'https://codeforces.com/api';
const MIN_GAP_MS = 2200;
const USER_AGENT = 'acm-trainer/0.1 (local, single-user)';

export class CfError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'CfError';
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let chain = Promise.resolve();
let lastCallAt = 0;

function enqueue(task) {
  const run = chain.then(task);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function cleanComment(comment) {
  return String(comment ?? '').replace(/^\s*\d+:\s*/, '').trim();
}

async function callOnce(method, params) {
  const url = new URL(`${BASE}/${method}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CfError(`Codeforces 返回了无法解析的内容（HTTP ${response.status}）`, true);
  }

  if (payload.status === 'OK') return payload.result;

  const comment = cleanComment(payload.comment ?? `HTTP ${response.status}`);
  const retryable = /limit|try again|too many|unavailable|temporar/i.test(comment);
  throw new CfError(comment, retryable);
}

async function call(method, params, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(1200 * attempt);
    try {
      return await enqueue(async () => {
        await throttle();
        return callOnce(method, params);
      });
    } catch (error) {
      lastError = error;
      const retryable = error instanceof CfError && error.retryable;
      if (!retryable) throw error;
    }
  }
  throw lastError;
}

export async function getUser(handle) {
  const result = await call('user.info', { handles: handle });
  const user = Array.isArray(result) ? result[0] : result;
  if (!user) throw new CfError(`找不到用户 ${handle}`);
  return user;
}

export async function getRatingHistory(handle) {
  try {
    return await call('user.rating', { handle });
  } catch (error) {
    // 没打过 rated 比赛的用户会直接报错，属于正常情况
    if (error instanceof CfError && /not participated|not found|no such/i.test(error.message)) return [];
    throw error;
  }
}

/**
 * 分页拉取提交记录。
 * stopBefore > 0 时做增量同步：翻到比这个时间更早的页面就停，不用每次全量重拉。
 */
export async function getAllSubmissions(handle, { stopBefore = 0, onProgress } = {}) {
  const pageSize = 10000;
  const maxPages = 40;
  const rows = [];
  let newest = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await call('user.status', {
      handle,
      from: page * pageSize + 1,
      count: pageSize,
    });
    if (!batch.length) break;

    rows.push(...batch);
    const times = batch.map((item) => Number(item.creationTimeSeconds ?? 0));
    newest = Math.max(newest, ...times);
    onProgress?.(rows.length);

    if (batch.length < pageSize) break;
    if (stopBefore > 0 && Math.min(...times) <= stopBefore) break;
  }

  return { rows, newest };
}

export async function getProblemset() {
  return call('problemset.problems');
}

export async function getContestList() {
  return call('contest.list', {});
}
