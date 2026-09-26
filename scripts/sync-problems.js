// 手动刷新题库（约 1 万道题）。日常不用跑，服务器第一次请求时会自动同步。

import * as cf from './../lib/cf.js';
import * as db from './../lib/db.js';
import { fetchCatalog } from './../lib/atcoder.js';

console.log('正在从 Codeforces 拉取题库…');
const data = await cf.getProblemset();
const inserted = db.replaceProblems(data);
db.metaSet('problems_updated_at', Date.now());

const rated = db.getAllProblems().filter((problem) => problem.rating != null).length;
console.log(`完成：共写入 ${inserted} 道题，其中 ${rated} 道有难度分。`);

// 顺手刷一遍 AtCoder 题库（ABC/ARC/AGC 里有难度估计的那些）。
// 拉不到就跳过：CF 题库已经更新好了，不该因为 Kenkoooo 抖一下就让整条命令失败。
try {
  console.log('正在从 Kenkoooo 拉取 AtCoder 题库…');
  const rows = await fetchCatalog({ onProgress: (text) => console.log(`  ${text}`) });
  const atcoder = db.replaceAtcoderProblems(rows);
  db.metaSet('atcoder_problems_updated_at', Date.now());
  console.log(`完成：AtCoder 写入 ${atcoder} 道题。`);
} catch (error) {
  console.log(`AtCoder 题库这次没拉到（${error.message}），跳过。`);
}

console.log(`数据文件：${db.DATA_DIR}`);
