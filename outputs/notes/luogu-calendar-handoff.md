# 比赛日历接洛谷赛程：交接与结论（2026-09-26）

给新线程看的一页纸。这里是「洛谷赛程抓取」这条线的全部结论，不依赖对话记忆。

## 当前状态

- 抓取已修好并验证通过：**带 cookie 请求 + 从页面内嵌 JSON 取数据**。
- 尚未提交。工作区里同时躺着「洛谷题库」那条线的未提交改动，见下面「现场风险」。

## 洛谷接口的真实行为（本机实测）

接口：`https://www.luogu.com.cn/contest/list?_contentOnly=1`

1. **必须带 cookie。** 不带 cookie 会一直 302，Node 的 `fetch` 直接抛 `fetch failed`
   （不是超时、不是 403，就是这句，很容易误判成网络不通）。
   正确做法：第一次请求用 `redirect: 'manual'`，读 `set-cookie` 带上再请求一次。
   这个逻辑已经在 `lib/platforms.js` 的 `fetchLuoguText()` 里，别重复写。
2. **返回的是 HTML，不是 JSON。** `_contentOnly=1` 也好、`x-luogu-type: content-only`
   也好、`Accept: application/json` 也好，三种都试过，一律返回 `text/html`（约 13 KB）。
   比赛数据嵌在 `<script id="lentille-context" type="application/json">` 里，
   取 `data.contests.result`。代码里同时兼容了「哪天真的返回纯 JSON」（那时挂在
   `currentData` 下）的情况。
3. **列表按开赛时间倒序，一页 20 条。** 第一页就是「最近一场往回排」，往后翻
   （`&page=2`）全是已经打完的比赛。所以只看第一页就够，不要去翻页。
   实测第一页覆盖约三周（2026-09-17 → 2026-10-18）。
4. **字段**：`id / startTime / endTime / name / method / visibility /
   invitationCodeType / rated / host / squad / problemCount`（`*Time` 是秒级时间戳）。
   `ratedLimit` 这个字段现在**不存在**，是之前误传的。
5. **`rated` 是数字，不是布尔**：实测分布 `3`（洛谷官方 rated 场次，如 LGR / 月赛 /
   SCP 模拟）、`1`（ICPC 区域赛重现赛、以及部分公开赛）、`0`（不计分的娱乐赛）。
   所以判断写成 `Number(row.rated) > 0`，把 `0` 丢掉即可；写 `!!rated` 在字符串
   `"0"` 的情况下会误判。
6. `visibility` 有 1 / 2 / 11 三种值，但三种都会出现在洛谷自己的列表页上，
   不需要按它过滤。

## 改了什么

`server.js`：

- 新增 `parseLuoguContests(text)`：从 HTML 里挖 `lentille-context`，兼容纯 JSON。
- `fetchLuoguContests()` 改走 `fetchLuoguText()`（带 cookie），过滤条件改成数值判断。
- 顶部 import 加上 `fetchLuoguText`。

## 怎么验证

```powershell
npm.cmd start
# 另开一个窗口
Invoke-RestMethod "http://127.0.0.1:5173/api/calendar?days=30"
```

实测结果（2026-09-26）：`days=30` 拿到 21 场，其中洛谷 16 场、AtCoder 3 场、
Codeforces 2 场；唯一那条 `rated = 0` 的娱乐赛（LABOI Round 1）被正确排除。
界面截图在 `.dev/shots/calendar-all.png` 和 `.dev/shots/calendar-luogu.png`
（用 `node_modules\electron\dist\electron.exe .dev\shot-calendar.mjs` 重跑）。

## 现场风险（比抓取本身更要紧）

**提交 `2e2611b` 是坏的：它引用了没有提交的文件。**

- `server.js` 里有 `from './lib/atcoder.js'` 和 `from './lib/luogu.js'`，
  但这两个文件至今没被 `git add` 过（还是 `??` 未跟踪状态）。
- 用 `git archive HEAD` 解出一份干净副本再 `node server.js`，报
  `ERR_MODULE_NOT_FOUND: Cannot find module lib\atcoder.js`。
  也就是说**别人克隆下来跑不起来**，本机能跑只是因为磁盘上有这两个文件。
- 同一个坑还有一处：`fetchLuoguText` 的 `export` 也在未提交的 `lib/platforms.js` 改动里，
  日历这次就是靠它。只提交 `server.js` 会把仓库搞得更坏。

结论：提交时要**把两条线一起提交**（`lib/luogu.js`、`lib/atcoder.js`、
`lib/platforms.js`、`lib/db.js`、`lib/plan.js`、`lib/knowledge.js`、
`scripts/sync-problems.js`、`README.md` + `server.js`），
或者先确认洛谷题库那条线做到哪一步、能不能独立落地。
以后一条线一个提交，别在同一个 `server.js` 上两个人同时改。

## 没做、可以接着做的

- 每行下面那行小字（`division`）洛谷和 AtCoder 都只是重复了左边的来源徽章
  （洛谷写「洛谷」、AtCoder 写「AtCoder」），看着像冗余。要改的话得先想清楚
  洛谷那边 `rated` 的 3 和 1 各自的中文说法，别硬编。
- 洛谷第一页只覆盖约三周，`?days=60` 时洛谷那边会提前截断。
  真要支持长窗口就得翻页，但第二页开始是过去的比赛，收益不大。
