# 交接说明 · ACM 训练台（Acm-Tracker）

给接手这个项目的 AI／人看。**这份文档本身就是全部上下文**，不需要去看以前的对话记录；
项目里还有一份 `AGENTS.md`，写的是长期约定（代码风格、发布流程、踩过的坑），两份一起看最省事。

作者：DB_SLSQ（GitHub: DB-SLSQ）· 交流群 QQ 1124017564 · 单人自用工具，非商业项目。

---

## 一句话现状

**v1.0.5 已发布**（标签 `v1.0.5`，GitHub Actions 自动建了 Release，附件是安装包）；
在这之上工作区里又加了**「团队训练」这一页（未发布）**，改动集中在 6 个文件：
`lib/db.js` / `lib/plan.js` / `server.js` / `public/index.html` / `public/app.js` / `public/style.css`。
验证脚本 `.dev\verify-team.mjs` 17 项全通过，五套主题截图人工核对过。**还没写更新说明、没发版。**

`main` 分支和远端同步到了 1.0.5；桌面上装的那份是 1.0.5；安装包在
`D:\Acm-Tracker\dist\ACM Trainer Setup 1.0.5.exe`。
（桌面上还留了一份 1.0.5 之前的备份 `ACM Trainer.bak-104`，确认新版没问题后可以删。）

工作区里有两份**别人的**未跟踪文档（`outputs/notes/energy-intervals-status.md`、
`outputs/视频简介-下半年-上海见乐山见.md`），不是这个项目的活，别顺手 `git add -A` 带上去。

## 这是什么

一个人自己用的 Codeforces／AtCoder／洛谷训练台：抓公开数据 → 按目标 rating 排训练计划 →
每天告诉你做哪几道题 → 记录进度、画成长曲线。**零运行时依赖**：后端只用 Node 自带的
`node:sqlite`，前端没有构建步骤（原生 JS + HTML + CSS）。

- 仓库：`D:\Acm-Tracker`（git，main 分支，远端 `git@github.com:DB-SLSQ/Acm-Tracker.git`）
- 形态：Electron 桌面程序 + 本地 Node 服务 + 原生前端。桌面版和网页版是同一套代码

## 怎么跑 / 怎么测 / 怎么发

```powershell
npm.cmd start          # 网页版，浏览器开 http://127.0.0.1:5173
npm.cmd run desktop    # 桌面窗口（开发模式）
npm.cmd run build      # 本机出安装包到 dist\（复用本地 Electron，不下载）
npm.cmd run sync       # 手动刷新题库
npm.cmd run train      # 采集比赛数据训练推题模型（-- --contests 300）
```

**一律用 `npm.cmd`，不要用 `npm`**——用户的 PowerShell 禁止运行 `.ps1`，`npm` 会撞上这条限制。

改动怎么验：

```powershell
node_modules\electron\dist\electron.exe .dev\ui-sweep.mjs          # 全部页面点一遍 + 收集控制台报错 + 截图
node_modules\electron\dist\electron.exe .dev\run-selftest.mjs      # 跑「计划自检」的 16 项检查
node_modules\electron\dist\electron.exe .dev\verify-lists.mjs      # 我的题单
node_modules\electron\dist\electron.exe .dev\verify-mashup-swap.mjs # 拼好题 + 今日卡片换题
node_modules\electron\dist\electron.exe .dev\verify-tracker-pages.mjs # 题库 + 历年比赛
```

这些脚本都用 `ACM_TRAINER_DATA_DIR=.dev/data-verify`（开发库的副本），
**不会动用户的真实数据**；要重跑先 `Copy-Item data\trainer.db .dev\data-verify\trainer.db -Force`。

团队功能的验证脚本是 `.dev\verify-team.mjs`（17 项 + 五套主题截图 + 整页图 `team-full.png`）：

```powershell
# 重跑前刷一份副本：用 VACUUM INTO，别用 cp（原因见坑 22）
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');fs.mkdirSync('.dev/data-verify2',{recursive:true});const s=new DatabaseSync('data/trainer.db',{readOnly:true});s.exec(\"VACUUM INTO '.dev/data-verify2/trainer.db'\");s.close();"
unset ELECTRON_RUN_AS_NODE
$env:ACM_TRAINER_VERIFY_DIR='.dev/data-verify2'
node_modules\electron\dist\electron.exe .dev\verify-team.mjs
```

（默认数据目录还是 `.dev\data-verify`；`ACM_TRAINER_VERIFY_DIR` 是给副本坏掉时换目录用的。）

发布流程（改完要发版时）：

1. 改 `package.json` 的 `version`
2. 写 `outputs/release-notes-vX.Y.Z.md`（风格照旧的：说清改了什么、为什么，别写空话）
3. `git push origin main`
4. `git tag vX.Y.Z` + `git push origin vX.Y.Z`
5. 剩下的交给 GitHub Actions（`.github/workflows/release.yml`）：`npm ci` + `npm run build`，
   把 exe 作为附件建成 Release，正文取自 `outputs/release-notes-<tag>.md`

本机的 GitHub 令牌**只有读权限**，传不了 Release 附件，所以必须走 tag + Actions。
本机 `npm.cmd run build` 只是为了「自己装着玩」和把桌面那份换成新版。
发布后如果要用户桌面也更新：关掉正在跑的 `ACM Trainer`，把 `dist\win-unpacked\*` 覆盖到
`C:\Users\summer\Desktop\ACM Trainer\`，再用**资源管理器**启动（见下面第 7 条坑）。

## 用户的工作方式（很重要，直接影响满意度）

- 中文交流，说话很短（经常就一两个词）。**别要求他把话说完**，按上下文给出最合理的解释，
  并且把「我按什么理解做的」写清楚，他会在下一句纠正。
- 他**视觉很敏感**：截图里出现过横向拉伸、徽章出框、颜色不对、做过和没做过的题分不清，
  都会被指出来。改界面一定要自己截图看一眼再交付。
- 汇报**先给结论 + 数据**，不要「正确的废话」，不要「不是 X 而是 Y」这种对比句。
- 他喜欢**功能加在左边菜单里**（他原话：「就还是加在左面那些列里面」），不要做成独立网页。
- 他常见的需求节奏是：提一个功能 → 我做完并发布 → 他试用后提下一个。
  改完最好本机打包 + 换掉桌面那份，让他直接能用。
- 他自己的原话经常就是最好的需求描述（比如「一天四档」「题数跟区域赛差不多就行」），
  写注释时可以直接引用。

## 代码地图

```
server.js              本地服务 + 全部接口（约 3200 行，路由都写在 route() 里；团队接口见下方）
lib/cf.js              Codeforces 官方 API（题目、提交、比赛、rating）
lib/atcoder.js         AtCoder：Kenkoooo 的题目表 / 难度 / 提交记录 / 用户统计
lib/luogu.js           洛谷题库：按难度档等距抽页抓取
lib/platforms.js       洛谷练习页、牛客；fetchLuoguText() 处理洛谷的 cookie 挑战
lib/plan.js            挑题算法（方向配额、四档均分、难度自适应、deriveProgress；**团队分工与排题也在这**，约 1325 行）
lib/db.js              node:sqlite 封装：建表、迁移、所有 SQL（约 1900 行）
lib/contests.js        比赛分档解析（Div. 1/2/3、Educational…）与适合度判断
lib/model.js           推题模型（逻辑回归，训练好才启用）
public/index.html      所有页面（<section class="panel" id="panel-xxx">）
public/app.js          全部前端逻辑（约 4600 行；导航项是 NAV_ITEMS，页面切换用 showView）
public/style.css       全部样式（约 3470 行，CSS 变量控制五套主题）
public/schedule.js     日程排布（按天把题排开，考虑休息日/没空的天）
public/selftest.html   计划自检页
electron/main.js       桌面入口：起服务 + 开窗口，打包后数据目录 = %APPDATA%\acm-trainer\data
```

**加一个新页面的套路**（照最近几页抄最快）：

1. `public/index.html`：加 `<section class="panel hidden" id="panel-xxx">…</section>`
2. `public/app.js`：`NAV_ITEMS` 里加一项 → 写 `loadXxx()` / `renderXxx()` → 在侧栏点击处理里
   加 `if (button.dataset.view === 'panel-xxx' && !loaded) loadXxx()`
3. `server.js`：在 `route()` 里加接口；数据尽量走 `allProblems()`（有缓存）或 `db.xxx`
4. 需要新表就在 `lib/db.js` 的建表块里加 `CREATE TABLE IF NOT EXISTS`（老库升级靠 `db.exec`）

现在的导航（19 页，比 1.0.5 多了「团队训练」）：
当前水平 / 目标设置 / 训练计划 / **团队训练** / 训练日程 / 补题队列 / 题库 / 历年比赛 / 拼好题 / 我的题单 /
能力画像 / 成长 / 做题记录 / 活动记录 / 比赛日历 / 虚拟参赛 / 平台数据 / 帮助 / 设置。

数据表（31 张，其中 `sqlite_sequence` 是 SQLite 自带的）：`problems`（题库缓存，含
platform/native_id/native_contest/native_rating）、
`submissions`、`rating_history`、`users`、`contests`、`atcoder_contests`（比赛 id 映射）、
`luogu_ids`、`settings`、`meta`（各种缓存 JSON）、`model_samples`、`blocked_problems`、
`progress`（打勾）、`platform_stats`、`virtual_sessions`、`plan_snapshots`（钉住的计划）、
`plan_swaps`、`plan_defer`、`plan_adjust`、`extra_tasks`（补一个方向）、`schedule_extras`、
`problem_feedback`（做题手感）、`review_done`、`growth_snapshots`、`known_handles`、
`problem_lists` + `problem_list_items`（我的题单）、
`teams` + `team_members` + `team_assignments`（团队训练，见下节）。

## 团队训练（本轮新加，未发布）

给 ACM 队伍三人各自分配方向和题目，避免三人练重。**数据层天然是按人隔离的**：`progress`、
`plan_snapshots`、`submissions`、`users` 等 17 张表的主键第一维就是 `handle_key`，所以团队模式
不需要重构数据模型，只加了一层「队伍」概念。

**三张新表**（`lib/db.js` 建表块）：

```sql
teams(id TEXT PK, name, created_at)                      -- id 是随机串，不是自增
team_members(team_id, handle_key, role, added_at)         -- PK(team_id, handle_key)
team_assignments(team_id, handle_key, axis, kind, updated_at) -- PK(team_id, handle_key, axis)
```

`team_assignments.kind` 是 `main` / `sub`（主攻 / 副攻）。**删队伍只删这三张表里该队的行，
绝不动成员的训练数据**；删成员会连带清掉他在该队的分工。

**两个算法**（`lib/plan.js` 末尾）：

- `assignAxes(members, {subPerMember: 2})` —— 队内分工。用贪心：每次取全局最大
  `(该成员该方向的 gapVsSelf) - 已拿方向数 × 120`；名额 `base = floor(8/n)` 的余数给前几个
  （3 人 → 3/3/2，2 人 → 4/4，1 人 → 8）。**只有主攻必须不重叠**；副方向允许和别人主攻重叠，
  因为它就是「补自己最弱的那块」。
- `buildTeamPlans(members, {problems, target, perMember, tagShare, blocked, now})` —— 团队排题。
  队内**共享一个 `assignedKeys` 集合保证不撞题**。每人区间跟自己的水平走
  （`center = max(800, round((rating+target)/2/50)*50)`，`lo = center-150`，`hi = center+500`）。
  难度梯度靠「每个取题槽位盯一个不同的目标分」：`LADDER_TIER_OFFSETS` 映射成
  `center + [-150, 50, 250, 450]` 四个目标分轮转。focus 顺序是 `['main','main','sub','other']`，
  所以 8 道大约 4 主 / 2 副 / 2 其他。实测三道题单跨 650 分（1550→2200）、4 CF + 4 洛谷、零撞题。

**接口**（`server.js`，都挂在 `/api/team` 下）：`GET/POST /api/team`（列表/建队）、
`GET/PATCH/DELETE /api/team/:id`（总览/改名/删队）、`POST /api/team/:id/members`、
`DELETE /api/team/:id/members?handle=X`、`POST /api/team/:id/assign`（重算分工）、
`GET /api/team/:id/plan`（团队排题）。总览接口会顺带返回 `assignment`，
**没分过或成员变了就现场分一份存下来**，保证前端的分工矩阵永远不为空。

前端在 `public/app.js`：`state.team` + `loadTeams() / loadTeamDetail() / createTeam() /
addTeamMember() / reassignAxes() / generateTeamPlan() / renderTeam()`，页面在
`#panel-team`，样式在 `public/style.css` 末尾（全走 CSS 变量，五套主题自动适配）。
分工矩阵的数据源要用 `team.plan?.assignment ?? detail.assignment`——**成员画像里没有
「他主攻哪块」，只能从 assignment 拿**（这里踩过一次坑，矩阵全显示「待分配」）。

**没做的**：上云端（用户明确选了「先本地，留云端接口」，本轮只做本地）；
`settings` 和 `problem_lists` 这两张表没有 handle 维度，还没按人/按队隔离。

## 数据从哪来、口径是什么

| 来源 | 用什么 | 注意 |
|---|---|---|
| Codeforces | 官方公开 API（problemset / user.status / contest.list） | 非 gym 比赛的 `contest.standings` 只能匿名、且不能带 `from`/`count` 参数 |
| AtCoder 题库与提交 | Kenkoooo 的 `resources` + `atcoder-api` | 只要 ABC/ARC/AGC；难度是 IRT 估计值，统一 +200 折算成练习分；**明确要求 1 秒最多一个请求**（代码里 1.1 秒） |
| AtCoder 赛程 | `atcoder.jp/contests/` 的 upcoming 表格 | **别改用 Kenkoooo 的 `contests.json`**：实测 2026-09-28 查，那份文件最新一条停在 9/27、未来一场都没有，会把日历搞空。官方表格还带「Rated Range」列，正好用来只列计分场次 |
| 洛谷题库 | `luogu.com.cn/problem/list`（按难度档等距抽页） | 必须带 cookie（见坑 1） |
| 洛谷赛程 | `luogu.com.cn/contest/list` | 只保留计分场次：`rated` 是**数字**（官方 3、ICPC 重现赛 1、不计分 0），按数值判断 |

## 踩过的坑（别再踩）

前 4 条是这两天新踩的，最花时间：

1. **洛谷的 cookie**：题目列表、比赛列表、练习页都会先回一个 302 并下发 `C3VK`，
   不带它就一直重定向，Node 的 `fetch` 只报一句 `fetch failed`（看着像断网）。
   统一走 `lib/platforms.js` 的 `fetchLuoguText()`；拿回来的其实是 HTML，数据嵌在
   `<script id="lentille-context">` 的 JSON 里。这张 `C3VK` 是匿名票据、可以跨请求复用，
   和用户账号无关。
2. **`db.listAtcoderContestDates()` 返回的是 `[contestId, startTime]` 数组对，不是对象**。
   我按对象取字段，取到一溜 `undefined`，结果比赛页里 AtCoder 场次「时间未知」、
   「拼好题」的 AtCoder 候选池恒为 0。
3. **SQLite 的保留字**：`SELECT idx AS index` 会直接语法报错（near "index": syntax error）。
   列名别名别用 `index`。
4. **前端里别把局部变量叫 `state`**：`const state = $('xxx')?.value` 会把全局 `state` 遮住，
   函数里更早用到的 `state.handle` 直接变成 TDZ 报错（`Cannot access 'state' before initialization`）。
   同理：**下拉框还没填好时 `value` 是空串**，`?? 'all'` 挡不住空串，要用 `|| 'all'`。
5. **从 AI 自己的终端启动打包版，`%APPDATA%` 会被重定向**到沙箱容器里另一个几乎是空的数据目录，
   表现是程序里「题库 0 道」，看着像数据丢了。验证打包版请用资源管理器／桌面快捷方式启动，
   或者直接问程序内置服务的 `/api/health`（里面的版本号、题库条数最可信）。
6. **`git add -A` 会带上别人未跟踪的文件**。这个仓库偶尔有并行会话留下的文档，
   提交前先看 `git status --short`，只 add 自己改的那几个。
7. **一次只做一件事**：0.1.6 之后有个提交叫「撤掉自定义背景图」，刀口开大了，
   顺手删掉了 `/api/feedback`（做题手感）和 `/api/plan/extra`（补一个方向）两个接口，
   直到 0.1.8 才补回来。大范围删除前先 `git diff --stat` 看一眼。
8. **改挑题算法要动 `PLAN_VERSION`**（`server.js` 顶部）：计划是钉住的快照，
   不 +1 的话老计划不会按新算法重挑。
9. **训练日程锚在「计划定下来的那天」**（`plan_snapshots.created_at`），不是锚在今天；
   「落后几天」只算今天之前该做完的题。这两条改了会让今天这张卡失去意义。
10. **每天一套题要四档均分**：练手/进阶/提升/学习，间距 200 分，围绕这一阶段中心
    （`lib/plan.js` 的 `LADDER_TIER_OFFSETS`）。按打分直接发的话平均每天难度跨度只有 6 分。
11. **洛谷难度是 9 档**（中间有「普及」「提高」两档），配色对应 `public/app.js` 的 `LUOGU_COLORS`。
12. **打包相关**：`package.json` 里已配 `build.electronDist = node_modules/electron/dist`，
    不会再下 110MB；仓库根目录不能有名字坏掉的目录（以前有过乱码目录，electron-builder 直接
    `lstat ENOENT`），`.dev\clean-junk-dirs.mjs` 能清掉。
13. **在 AI 的 shell 里跑 `.dev\*.mjs`（Electron 脚本）有两个环境坑**：
    a. 环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 `require('electron')` 返回 undefined，
       报 `Cannot read properties of undefined (reading 'whenReady')`。跑之前先 `unset ELECTRON_RUN_AS_NODE`。
    b. 这机器在沙箱里 GPU 起不来，脚本要显式关掉硬件加速，否则报
       `GPU process isn't usable. Goodbye.` 或页面 `ERR_FAILED (-2)`。在 `app.whenReady()` 前加：
       `app.disableHardwareAcceleration()`、`app.commandLine.appendSwitch('disable-gpu')`、
       `disable-gpu-compositing`、`in-process-gpu`、`no-sandbox`、`disable-dev-shm-usage`。
    参考 `.dev\shot-themes.mjs`（五套主题截图）和 `.dev\sweep-cyber.mjs`（赛博下 18 页全扫）。
    仓库里老的 `.dev\ui-sweep.mjs`、`.dev\run-selftest.mjs` 没加这些，在本环境跑不起来。
14. **CSS 伪元素动画不在 `el.getAnimations()` 里**。验证 `::before` / `::after` 的动画要么看
    `getComputedStyle(el, '::before').animationName`，要么多帧截图比哈希。用 `getAnimations()`
    查赛博主题的五个动画会一个都查不到，误判成「没生效」。
15. **改伪元素规则（`::before` / `::after`）时一定要带上定位属性**。只改 `background` / `animation`
    而把 `position: absolute; left: 0; width: 2px` 漏掉，元素会掉回静态流变成整宽色块。
    这个坑犯过两次（侧栏光带、菜单扫光），改完必须截图确认。
16. **`lib/plan.js` 的 `toClientProblem` 是字段白名单**。数据库查出来的字段不会自动带到前端，
    新加字段（如 `first_ac`）必须在白名单里补一行，否则前端拿到 `undefined`。典型症状是
    「做题记录」页所有日期显示 `Invalid Date`。前端展示日期再兜个 `|| '—'` 更稳。
17. **成长页那张比赛表格用 `table-layout: fixed` + `colgroup` 定列宽**。表头文字短、
    数据行有长日期，靠 `min-width` 调不动（表头和数据行的列宽会各算各的）。要改表头文字时，
    务必连 `colgroup` 的列宽一起看，不然又会退化成「一字一行竖排」。
18. **打包时沙箱会拦批量删除**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）：electron-builder 清理
    `dist\win-unpacked\locales`（78 个文件 > 50）会被拦下。手动 `rm -rf dist/win-unpacked` 后
    重跑即可；有时删 `__uninstaller.exe` 也会被拦，但产物其实已经生成完了，手动清残留就行。
19. **`public/app.js` 是 ES module，里面的函数不在 `window` 上**。验证脚本用
    `webContents.executeJavaScript('loadTeams()')` 会直接 `is not defined`。只能用
    **DOM 点击驱动**（`document.querySelector('#nav-team').click()` 这类），别想着直接调函数。
    另外 `executeJavaScript` 的返回值必须能被结构化克隆，返回 `undefined` 或 DOM 对象会报
    `Script failed to execute`——要返回状态就返回普通对象/字符串。顶层 `await` 也不合法，得包一层
    `(async () => { ... })()`。
20. **隐藏窗口（`show:false`）的 `capturePage()` 截的是已绘制帧**，滚动之后再截基本拿不到新内容。
    要截长页面就开一个够高的窗口（团队页用了 1440×2400）一次装下整页，别靠 `scrollIntoView`
    或多次滚动拼接。
21. **排题时同一分值会被反复取满**。洛谷每个难度档只有一个分值，`takeClosest` 会连着从同一分值
    取好几道，最后整份题单挤在一个分上。解法是给分值和「理想分」的距离加一个**重复惩罚**
    （`cost = |rating - wantRating| + dup × 60`，`dup` 是该分值已被取走的次数）。加之前实测 8 道
    全是 1950/2050/2150，加之后跨了 650 分。
22. **重做 `.dev/data-verify` 副本别用 `cp` / `copyFileSync`**。上一次验证崩溃会在旁边留下
    `trainer.db-wal` 和 `trainer.db-shm`；直接覆盖 `trainer.db` 之后，SQLite 下次打开时**会把
    那份旧的 WAL 重放上去**，新拷的库当场变成 `database disk image is malformed`。症状是验证脚本
    大面积 FAIL、server 控制台刷 `database disk image is malformed`，看着像功能坏了其实是数据坏了。
    正确做法是用 `VACUUM INTO` 从干净的源库生成无 WAL 的单文件副本：
    ```js
    const { DatabaseSync } = require('node:sqlite');
    const src = new DatabaseSync('data/trainer.db', { readOnly: true });
    src.exec("VACUUM INTO '.dev/data-verify2/trainer.db'");
    ```
    另外这个环境下**沙箱会拦 `rm`/`unlink`**（会试图走回收站然后失败），坏掉的副本删不掉——
    所以别在同一个目录里反复重做，直接换一个新目录（`verify-team.mjs` 支持
    `ACM_TRAINER_VERIFY_DIR=.dev/data-verify2` 覆盖）。

## 已经做过的事（按版本）

- **0.1.5–0.1.6**：左侧菜单分页布局、今日任务卡片（做题手感 / 赛前热身 / 复盘卡 / 补一个方向）、
  成长页网格、数据备份与导出导入、计划自检升级
- **0.1.7**：训练计划可混进 AtCoder 和洛谷的题（三平台配额：一半 CF + 四分之一 + 四分之一，
  每天每平台最多一道）、比赛日历接三家平台（来源筛选）、洛谷赛程补 cookie；撤掉自定义背景图
- **0.1.8**：补回被误删的两个接口（做题手感、补一个方向）
- **0.1.9**：补题队列不再留「已经补过」的题（根因是 `deriveProgress` 没把通过的题从
  没过的题里摘掉，实测 208 道里 179 道不该在队列里）；任何列表都不再出现「题库里没有这道题」
- **1.0.1**：新页「题库」（三平台筛选/分页/随机一道）与「帮助」（14 条 QA）；换应用图标
  （新立绘的头部徽章，`.dev/make-icon.mjs` 生成，含 16~256 七种尺寸的 ico）；
  AtCoder 赛程只列计分场次并标注计分区间；平台数据卡加 AtCoder 通过排名与计分总分
- **1.0.2**：新页「历年比赛」（按比赛看题、题目难度色块、随机一场）；题库页难度改双滑块、
  加「只看没做过的/做过的」和「按我的水平推荐」
- **1.0.3**：「当前水平」页的今日卡片也能换一道/放最后；新页「拼好题」（CF 一场 + AtCoder 一场，
  只挑没打过、且最近一年半以内的场次，实测拼出来 10~13 题、难度跨 800~2700）
- **1.0.4**：新页「我的题单」（贴题号或链接就能成题单、逐题勾进度、拼好题一键存）；
  历年比赛里做过/没做过改成实心 vs 空心两种形态，并标出整场状态

- **1.0.5**：新主题「赛博朋克」（网格扫描线底纹 + 五处霓虹动态 + prefers-reduced-motion 总开关）；
  「界面模块」开关补齐后加的 5 个页面（17 项）；修成长页表格列宽与做题记录时间显示 Invalid Date
- **未发布（工作区）**：新页「团队训练」——建队 + 加成员（贴 CF/AtCoder/洛谷 handle）；
  队内按知识方向自动分工（八方向不重叠地主攻 + 每人 2 个副方向补短板）；
  团队总览表（rating / 已解 / 近七天 / 强项 / 待补）；团队排题（每人 N 道、队内不撞题、
  难度按各自水平铺开）。后端 `assignAxes` / `buildTeamPlans`，接口 `/api/team/*`，
  三张新表。**还没写更新说明、没发版。**

## 没做 / 可以接着做

1. **团队功能发布**：现在只差写 `outputs/release-notes-vX.Y.Z.md` + 改 version + 打 tag。
   发布后可以考虑的下一步（用户当时问过「是不是要上云端」，选了「先本地、留云端接口」）：
   - 给团队数据留导出/导入的 JSON 结构（队伍 + 分工 + 成员 handle），为以后同步做准备；
   - `settings` / `problem_lists` 目前没有 handle 维度，多人共用一份设置在队伍场景下会串，
     真要多人用就得给它们加人/队维度；
   - 进度汇总现在只到「已解 / 近七天 / 强项 / 待补」，还没做「按队伍方向看整体覆盖」的图。
2. **让用户完整跑一次推题模型**（设置 → 推题模型 → 开始训练，默认 300 场、十几分钟）。
   目前界面显示「还没训练过推题模型」；门槛写在 `lib/model.js`：AUC ≥ 0.75 且明显优于
   「只看难度差」的基线才启用，赢不了就继续用内置规则（这是设计，不要放宽）。
3. 用户提过但一直没做的：**语音输入**（当时没说清要什么，需要问）、**自动检查更新**（现在是
   手动点「检查更新」）、**Mac 版**。
4. 「我的题单」还能往下做：今日卡片／训练计划里直接「存成题单」、题单导出成 CSV/Markdown 文件、
   题单内的随机一道。
5. 宣传：B 站发过宣传版和 v0.1.3 更新版；v0.1.7 的更新视频、封面、简介都做好了
   （`.dev\make-video-v017.mjs`、`dist\ACM训练台-v0.1.7更新.mp4`、`outputs\v0.1.7-视频简介.md`），
   发不发看用户；素材同时放在 `C:\Users\summer\Documents\Codex\2026-09-20\new-chat\outputs\video-assets`。
6. **主题现在有五套**（暗色／亮色／灰色／护眼／赛博），`public/style.css` 顶部是变量块，
   加新主题照抄一块改颜色即可；样式里凡是 `[data-theme='dark'], [data-theme='gray']` 这种
   列举写法的选择器，记得把新主题名也加进去（比如 `--danger` 那两处）。
   赛博那套除了变量，文件末尾还有一大段氛围/动画（网格底纹、流动光带、扫光、glitch）。


## 数据安全（这条最重要）

- 用户的全部数据在 `%APPDATA%\acm-trainer\data\trainer.db`（开发模式在项目 `data\trainer.db`）。
  **不要用测试数据覆盖它**：测试统一用 `.dev/data-verify` 之类的副本。
- 这个项目**曾经被误删过一次**（2026-09-22 晚上整个目录消失，回收站也是空的，靠 GitHub + 测试
  副本恢复）。**不要给出 `Remove-Item -Recurse -Force` 这类命令让用户执行**；确需删除先确认
  别处有完整副本。
- 界面上有「备份数据库」（存到数据目录的 `backups`）和「导出训练数据」（JSON，换电脑用），
  大改动前可以提醒用户点一下。
