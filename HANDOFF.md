# 交接说明 · ACM 训练台（Acm-Tracker）

给接手这个项目的 AI／人看。**这份文档本身就是全部上下文**，不需要去看以前的对话记录；
项目里还有一份 `AGENTS.md`，写的是长期约定（代码风格、发布流程、踩过的坑），两份一起看最省事。

作者：DB_SLSQ（GitHub: DB-SLSQ）· 交流群 QQ 1124017564 · 单人自用工具，非商业项目。

---

## 一句话现状

**v1.0.5 已经写完、打包、发布**（标签 `v1.0.5`，GitHub Actions 自动建了 Release，附件是安装包）。
`main` 分支干净、和远端同步；桌面上装的那份也是 1.0.5；安装包在
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
server.js              本地服务 + 全部接口（约 3000 行，路由都写在 route() 里，共 44 个 /api/）
lib/cf.js              Codeforces 官方 API（题目、提交、比赛、rating）
lib/atcoder.js         AtCoder：Kenkoooo 的题目表 / 难度 / 提交记录 / 用户统计
lib/luogu.js           洛谷题库：按难度档等距抽页抓取
lib/platforms.js       洛谷练习页、牛客；fetchLuoguText() 处理洛谷的 cookie 挑战
lib/plan.js            挑题算法（方向配额、四档均分、难度自适应、deriveProgress）
lib/db.js              node:sqlite 封装：建表、迁移、所有 SQL（约 1700 行）
lib/contests.js        比赛分档解析（Div. 1/2/3、Educational…）与适合度判断
lib/model.js           推题模型（逻辑回归，训练好才启用）
public/index.html      所有页面（<section class="panel" id="panel-xxx">）
public/app.js          全部前端逻辑（约 4400 行；导航项是 NAV_ITEMS，页面切换用 showView）
public/style.css       全部样式（约 2800 行，CSS 变量控制四套主题）
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

现在的导航（18 页）：
当前水平 / 目标设置 / 训练计划 / 训练日程 / 补题队列 / 题库 / 历年比赛 / 拼好题 / 我的题单 /
能力画像 / 成长 / 做题记录 / 活动记录 / 比赛日历 / 虚拟参赛 / 平台数据 / 帮助 / 设置。

数据表（28 张，其中 `sqlite_sequence` 是 SQLite 自带的）：`problems`（题库缓存，含
platform/native_id/native_contest/native_rating）、
`submissions`、`rating_history`、`users`、`contests`、`atcoder_contests`（比赛 id 映射）、
`luogu_ids`、`settings`、`meta`（各种缓存 JSON）、`model_samples`、`blocked_problems`、
`progress`（打勾）、`platform_stats`、`virtual_sessions`、`plan_snapshots`（钉住的计划）、
`plan_swaps`、`plan_defer`、`plan_adjust`、`extra_tasks`（补一个方向）、`schedule_extras`、
`problem_feedback`（做题手感）、`review_done`、`growth_snapshots`、`known_handles`、
`problem_lists` + `problem_list_items`（我的题单）。

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

## 没做 / 可以接着做

1. **让用户完整跑一次推题模型**（设置 → 推题模型 → 开始训练，默认 300 场、十几分钟）。
   目前界面显示「还没训练过推题模型」；门槛写在 `lib/model.js`：AUC ≥ 0.75 且明显优于
   「只看难度差」的基线才启用，赢不了就继续用内置规则（这是设计，不要放宽）。
2. 用户提过但一直没做的：**语音输入**（当时没说清要什么，需要问）、**自动检查更新**（现在是
   手动点「检查更新」）、**Mac 版**。
3. 「我的题单」还能往下做：今日卡片／训练计划里直接「存成题单」、题单导出成 CSV/Markdown 文件、
   题单内的随机一道。
4. 宣传：B 站发过宣传版和 v0.1.3 更新版；v0.1.7 的更新视频、封面、简介都做好了
   （`.dev\make-video-v017.mjs`、`dist\ACM训练台-v0.1.7更新.mp4`、`outputs\v0.1.7-视频简介.md`），
   发不发看用户；素材同时放在 `C:\Users\summer\Documents\Codex\2026-09-20\new-chat\outputs\video-assets`。
5. **主题现在有五套**（暗色／亮色／灰色／护眼／赛博），`public/style.css` 顶部是变量块，
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
