// 手动刷新题库（约 1 万道题）。日常不用跑，服务器第一次请求时会自动同步。

import * as cf from './../lib/cf.js';
import * as db from './../lib/db.js';

console.log('正在从 Codeforces 拉取题库…');
const data = await cf.getProblemset();
const inserted = db.replaceProblems(data);
db.metaSet('problems_updated_at', Date.now());

const rated = db.getAllProblems().filter((problem) => problem.rating != null).length;
console.log(`完成：共写入 ${inserted} 道题，其中 ${rated} 道有难度分。`);
console.log(`数据文件：${db.DATA_DIR}`);
