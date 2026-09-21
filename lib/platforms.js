// 其他 OJ 平台的数据抓取。
//
// 设计原则：只抓「汇总数字」，不抓逐题记录。
// 逐题记录要翻很多页，正是把人 IP 抓封的原因；而汇总数字一个请求就够。

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export class PlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformError';
  }
}

async function fetchText(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new PlatformError(`对方返回了 HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new PlatformError('请求超时');
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(`网络错误：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 洛谷有一套 cookie 挑战：第一次请求返回 302 并下发一个 cookie，
 * 带上它再请求才是真正的页面。所以这里手动处理一次跳转。
 */
async function fetchLuoguText(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' };

  try {
    let response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });

    if (response.status >= 300 && response.status < 400) {
      const cookies = (response.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(';')[0])
        .join('; ');
      if (!cookies) throw new PlatformError('洛谷要求 cookie 却没有下发，可能被风控拦了');
      response = await fetch(url, {
        headers: { ...headers, Cookie: cookies },
        redirect: 'follow',
        signal: controller.signal,
      });
    }

    if (!response.ok) throw new PlatformError(`洛谷返回了 HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new PlatformError('请求洛谷超时');
    throw error instanceof PlatformError ? error : new PlatformError(`网络错误：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 牛客：练习统计页是服务端渲染的，一个请求就能拿到所有汇总数字。
 * 页面结构形如：<div class="status-item">…数字…<span>题已通过</span></div>
 */
export async function fetchNowcoder(uid) {
  const account = String(uid).trim();
  if (!/^\d{3,12}$/.test(account)) {
    throw new PlatformError('牛客用户 ID 应该是纯数字（在个人主页地址栏里）');
  }

  const url = `https://ac.nowcoder.com/acm/contest/profile/${account}/practice-coding`;
  const html = await fetchText(url);

  const stats = {};
  // 牛客的统计卡片有几种容器名（status-item、my-state-item…），
  // 统一按「class 里带 item 的 div + 后面跟一个 <span>标签</span>」来抓，
  // 这样它改类名也不会立刻失效。
  for (const item of html.matchAll(
    /<div class="[^"]*item[^"]*"[^>]*>([\s\S]{0,400}?)<span>\s*([^<]+?)\s*<\/span>/g,
  )) {
    const value = item[1].match(/>\s*(\d+)\s*</);
    if (value) stats[item[2].trim()] = Number(value[1]);
  }

  if (!Object.keys(stats).length) {
    throw new PlatformError('没能从牛客页面里解析出数据，可能是页面结构变了或者这个 ID 不存在');
  }

  const title = html.match(/<title>([^<]+)<\/title>/);
  const nickname = title ? title[1].replace(/的比赛主页$/, '').trim() : null;

  return {
    platform: 'nowcoder',
    account,
    nickname,
    stats,
    solved: stats['题已通过'] ?? null,
    url: `https://ac.nowcoder.com/acm/contest/profile/${account}/practice-coding`,
  };
}

// 洛谷的难度分级，共 9 档（0-8）。
// 注意：洛谷在中间插入过新档位（「普及」「提高」），所以从第 3 档起和老资料对不上，
// 这里是按用户主页「难度统计」的实际顺序核对过的。
const LUOGU_DIFFICULTY = {
  0: '暂无评定',
  1: '入门',
  2: '普及−',
  3: '普及',
  4: '普及+/提高−',
  5: '提高',
  6: '提高+/省选−',
  7: '省选/NOI−',
  8: 'NOI/NOI+/CTSC',
};

/**
 * 洛谷：练习页把「做过的每一道题」整个放进一个 JSON，一个请求就够。
 * 每条形如 {type:'P', name:'…', difficulty:4, pid:'P1004'}；
 * type 为 CF 的是洛谷镜像的 Codeforces 题，pid 形如 CF916D，
 * 正好能和本站的 Codeforces 计划对上，用来标记「这题你在洛谷也做过」。
 */
export async function fetchLuogu(uid) {
  const account = String(uid).trim();
  if (!/^\d{1,12}$/.test(account)) {
    throw new PlatformError('洛谷用户 ID 是主页地址里的数字，例如 luogu.com.cn/user/123456');
  }

  const url = `https://www.luogu.com.cn/user/${account}/practice`;
  const html = await fetchLuoguText(url);

  const block = html.match(
    /<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!block) throw new PlatformError('没能从洛谷页面读到数据，可能这个 ID 不存在，或者页面结构变了');

  let context;
  try {
    context = JSON.parse(block[1]);
  } catch {
    throw new PlatformError('洛谷返回的数据解析失败');
  }

  const data = context.data ?? {};
  if (data.privacy === true) {
    throw new PlatformError(
      '这位用户把练习数据设成了私密，公开页面读不到。让对方在洛谷设置里放开隐私后重试。',
    );
  }

  const user = data.user ?? {};
  const passed = Array.isArray(data.passed) ? data.passed : [];

  const difficulty = {};
  const cfProblems = [];
  for (const item of passed) {
    const level = Number(item?.difficulty ?? 0);
    difficulty[level] = (difficulty[level] ?? 0) + 1;
    const mirror = typeof item?.pid === 'string' ? item.pid.match(/^CF(\d+)([A-Z]\d?)$/) : null;
    if (mirror) cfProblems.push(`${mirror[1]}-${mirror[2]}`);
  }

  const stats = { 通过题目: passed.length || Number(user.passedProblemCount ?? 0) };
  const submitted = Number(user.submittedProblemCount ?? 0);
  const ranking = Number(user.ranking ?? 0);
  if (submitted) stats.提交题目 = submitted;
  if (ranking) stats.排名 = ranking;

  return {
    platform: 'luogu',
    account,
    nickname: user.name ?? null,
    stats,
    solved: stats['通过题目'] ?? 0,
    extra: { difficulty, cfProblems, difficultyLabels: LUOGU_DIFFICULTY },
    url,
  };
}
