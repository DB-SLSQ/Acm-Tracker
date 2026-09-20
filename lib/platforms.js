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
