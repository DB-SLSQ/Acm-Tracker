# ACM 训练台（仓库名 Acm-Tracker）

单人本地使用的 Codeforces 训练工具。Electron 桌面程序 + Node 本地服务 + 原生前端，
**零运行时依赖**（后端只用 Node 自带的 `node:sqlite`，前端没有构建步骤）。
作者：DB_SLSQ（GitHub: DB-SLSQ）。交流群 QQ 1124017564。

## 怎么跑 / 怎么打包

```powershell
npm.cmd start          # 网页版，浏览器开 http://127.0.0.1:5173
npm.cmd run desktop    # 桌面窗口（开发模式）
npm.cmd run build      # 生成安装包到 dist\
npm.cmd run train      # 采集比赛数据并训练推题模型（可加 -- --contests 300）
npm.cmd run sync       # 手动刷新题库
```

注意：用户的 PowerShell 禁止运行 `.ps1`，所以**一律用 `npm.cmd`**，不要用 `npm`。

- 打包已在 `package.json` 里配好 `build.electronDist = node_modules/electron/dist`，
  打包时复用本地已装好的 Electron，不会再下载 110MB。
- 国内网络：npm 官方源和 github.com 都不通，要用镜像
  （`--registry=https://registry.npmmirror.com`、`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。

## 数据放在哪

- 打包后的程序：`%APPDATA%\acm-trainer\data\trainer.db`
- 开发模式：项目里的 `data\trainer.db`（已被 .gitignore 忽略）
- 表：`problems`（题库缓存）、`submissions`、`rating_history`、`users`、`contests`、
  `settings`（键值）、`meta`（含训练好的模型 JSON）、`model_samples`（训练样本）、
  `blocked_problems`、`progress`、`platform_stats`、`virtual_sessions`、
  `teams` / `team_members` / `team_assignments`（团队训练）

## 代码约定

- 注释用中文，重点写**为什么**这么做，而不是复述代码在做什么。
- 新增算法要在注释里带实测数据（比如「实测 99 题里 2016 年以前占 43%，加年份权重后降到 18%」）。
- 不引入运行时依赖；需要新工具时优先用 Node 自带能力。
- 答案里不要用「不是 X 而是 Y」这种对比句，也不要写「正确的废话」。

## 已实现的功能

训练计划（按目标 rating 分阶段，钉住不漂、做过的题自动打勾、每行可「换一道」）、
今日任务卡片（当前水平下面：今天哪几题、当日进度条、距计划结束 / 落后几天）、
训练日程（按天排，支持休息日和临时没空、题目顺延）、
活动热力图（5 种配色）、平台数据（洛谷难度分布 + 牛客）、做题记录（屏蔽的题可恢复、
做过的题按通过时间倒序）、能力画像（8 大方向 75 分位 + 置信度）、比赛日历、虚拟参赛、
设置（模块开关、五套主题、水平评估的排除区间、单个标签占比上限、推题模型训练）、
**团队训练**（建队 + 加成员，加人时弹框分别填 CF / AtCoder / 洛谷账号一次抓三个平台、
按知识方向自动分工、团队总览含各平台数据来源、队内不撞题地排题）。

题量分配是**按知识方向的配额制**：八个方向差不多，弱项多分一两道（权重 1 + 0.4 × 强度，
最大余数法取整）。实测 99 题的题单分到 16/14/13/13/13/13/13/4（字符串那档是题源不够，
不是算法问题）。某个方向名额凑不齐时，用**轮转补位**（每个方向轮流补一道）而不是按分数堆——
按分数堆会把 greedy/implementation 顶到 40% 以上，等于把配额制废掉。

训练计划里可以勾「隐藏标签」：题单不显示算法方向，「重点补强」那行也会换成模糊说法
（否则等于把信息泄了）。这个开关存在 settings 的 `hide_tags`。

## 发布流程

1. 改 `package.json` 的 `version`
2. 写更新说明（放 `outputs/release-notes-vX.Y.Z.md`，风格参考旧的那几份：说清改了什么、为什么）
3. 提交并 `git push origin main`
4. 打 tag 推上去：`git push origin vX.Y.Z`

**推完 tag 剩下的交给 GitHub Actions**（`.github/workflows/release.yml`）：它会自动
`npm ci` + `npm run build`，然后把 exe 作为附件建成 Release，正文取自
`outputs/release-notes-<tag>.md`。不用在本机打包，也不用本机存写权限的令牌
——本机那个 GitHub 令牌只有读权限，传不了 Release 附件。

要在本机出安装包（自己装着玩）再 `npm.cmd run build`，产物在 `dist\ACM Trainer Setup x.y.z.exe`。
注意仓库根目录不能有名字坏掉的文件夹（之前几次命令写错环境变量造出来的乱码目录
会让 electron-builder 直接报 lstat ENOENT），`.dev\clean-junk-dirs.mjs` 会清掉它们。

## 踩过的坑（别再踩）

- **Codeforces 接口**：非 gym 比赛的 `contest.standings` 只接受不带任何额外参数的匿名请求，
  加 `from`/`count` 会被直接拒绝。要一页拿全场再自己等距抽样。
- **洛谷 `contest/list` 必须带 cookie**：不带的话会一直 302，Node 的 `fetch` 直接报
  `fetch failed`（看着像网络不通，实际是缺 cookie）。走 `lib/platforms.js` 的
  `fetchLuoguText`，它接下 `set-cookie` 再请求一次。返回的是 HTML，比赛数据嵌在
  `<script id="lentille-context">` 那段 JSON 的 `data.contests.result` 里；
  `rated` 是**数字**（官方 rated 场次 3、ICPC 重现赛 1、不计分 0），按数值判断。
- **洛谷难度是 9 档**（中间有「普及」和「提高」两档），配色对应 `public/app.js` 的 `LUOGU_COLORS`。
- **推题模型**：训练完必须按时间切分出留出集，和「只看难度差」的基线比；AUC 不低于 0.75
  且明显优于基线才启用，否则继续用内置规则，界面要写明原因。
- **水平评估的排除区间**：签到题会把标签的 75 分位拖低，默认忽略比当前 rating 低 400 分的题。
- **单个标签占比上限**默认 40%，可在设置里调；算法在 `lib/plan.js` 的 `pickProblems`。
- **训练日程锚在「计划定下来的那天」**（`plan_snapshots.created_at`，界面上是 `plan.generatedAt`），
  不是锚在今天。锚今天的话，勾掉一题后面的题就往前顶，今天这张卡永远显示 0/2，进度条就没意义了。
  「落后几天」按**今天之前**该做完的题算，把今天算进去的话每天一起床就凭空落后一整天。
- **每天一套题要「四档均分」**：练手 / 进阶 / 提升 / 学习，间距 200 分，相对这一阶段的中心
  （`lib/plan.js` 的 `LADDER_TIER_OFFSETS = [-150, 50, 250, 450]`）。用户原话是
  「1600 练手、1800 进阶、2000 提升、2200-2300 学习」——他 1600 分、目标 1900，
  第一阶段中心正好 1750，所以四档就是 1600/1800/2000/2200，平均正好压在目标分上。
  一天几题就顺着发：四题各一道，两题则是「练手+进阶 → 进阶+提升 → 提升+学习 → 学习+练手」
  循环，长期每档一样多。实测第一阶段四档分到 25/19/14/22 题，方向配额仍然是 11/10/10/10/10/10/10/9。
  之前是把打分排序直接按天发，平均每天难度跨度只有 6 分（天天秒签到题）。
- **上面这条要靠 `PLAN_VERSION` 让老计划失效**：钉住的快照里没有 2000 分以上的题，
  不重挑的话新档位根本发不出来。改挑题算法/区间时记得把 `server.js` 的 `PLAN_VERSION` +1。
- **视觉细节用户很敏感**：截图/视频里出现过横向拉伸、徽章出框、颜色不符合直觉，都会被指出来。
- **改 .cmd 脚本**：必须存成 GBK + CRLF，否则中文 Windows 的 cmd 会读成乱码。
- **加新主题**：`public/style.css` 顶部每套主题一个 `[data-theme='xxx']` 变量块，照抄一块改颜色就行。
  注意样式里凡是用列举写法的选择器（如 `[data-theme='dark'], [data-theme='gray']`）要把新主题名补上。
  主题按钮在侧栏底部和设置页「外观」各有一组，`applyAppearance` 遍历所有 `.theme-btn[data-theme-value]`，
  两处高亮自动同步——加按钮时两处都要加。
- **在 shell 里跑 Electron 验证脚本**要先 `unset ELECTRON_RUN_AS_NODE`（否则 `require('electron')` 是 undefined），
  并且要显式关硬件加速（`disableHardwareAcceleration()` + `disable-gpu` / `in-process-gpu` 等），
  否则 GPU 进程崩了页面加载会 `ERR_FAILED`。
- **伪元素（`::before` / `::after`）的动画不在 `el.getAnimations()` 里**：要验就得看
  `getComputedStyle(el, '::before').animationName`，或者多帧截图比哈希。改伪元素规则时
  一定要连着定位属性（`position: absolute` / `left` / `width`）一起改，漏掉就掉回静态流变成整宽色块。
- **`lib/plan.js` 的 `toClientProblem` 是字段白名单**：数据库查出来的字段不会自动到前端，
  新字段要手动补进白名单（漏了就是前端 `Invalid Date` 这种症状）。
- **长表格列宽用 `table-layout: fixed` + `colgroup`**：表头短、数据长的表格靠 `min-width`
  调不动（表头和数据行各算各的）。改表头文字要连列宽一起改，否则会退化成「一字一行竖排」。
- **`public/app.js` 是 ES module，函数不在 `window` 上**：验证脚本只能靠 DOM 点击驱动，
  `executeJavaScript('loadTeams()')` 会 `is not defined`。`executeJavaScript` 的返回值还必须
  可结构化克隆（返回 `undefined` / DOM 对象会报 `Script failed to execute`），顶层 `await`
  要包在 async IIFE 里。
- **隐藏窗口（`show:false`）的 `capturePage()` 只能拿到已绘制帧**：滚动后再截不可靠，
  截长页面就开一个够高的窗口一次装下整页（团队页用了 1440×2400）。
- **排题要防同一分值被反复取满**：洛谷每个难度档只有一个分值，光「取最接近理想分」会让整份
  题单挤在一个分上。给距离加重复惩罚（`cost = |rating - wantRating| + 该分值已取次数 × 60`）。
- **队内分工只有主攻必须不重叠**，副方向是补短板、允许和别人主攻重叠；三个人的时候八方向
  被主攻占满，副方向若也要求不重叠会一个都分不出来。
- **队内排题要共享一个「已取题」集合**，否则三个人的计划会互相撞题。
- **重做测试库副本（`.dev\data-verify`）别用 `cp`**：上次崩溃残留的 `trainer.db-wal` 会被 SQLite
  重放，把新拷的库搞成 `database disk image is malformed`（症状像功能坏了，其实是数据坏了）。
  用 `VACUUM INTO` 生成无 WAL 的单文件副本；这个环境沙箱还会拦删除，坏副本删不掉时要换新目录
  （`verify-team.mjs` 认 `ACM_TRAINER_VERIFY_DIR`）。
- **加团队成员要抓三个平台，不是只抓 CF**：`syncMemberPlatforms()` 里 CF 走 `loadUser()`、
  AtCoder 走 `syncAtcoderSubmissions()`、洛谷走 `fetchLuogu(uid)`（抓的是公开练习页，
  所以能按人分别统计）。每个平台单独 try，失败原因回给前端而不是静默算成 0——
  缺平台会让知识画像变窄，`assignAxes` 会把人算弱。**先 `addTeamMember` 再抓取**，
  抓取十几秒中途出错不该让「加人」整个失败。
- **`import('../server.js')` 不看 `PORT` 环境变量**：真正监听要靠 `startServer({ port })`。
  而且要**在同一个进程里** `await startServer()` 再 fetch——后台 `node server.js &`
  起的进程在这个沙箱里会被收拾掉，测试会撞 `ECONNREFUSED`。
- **CSS 改动的验证方式是截图**，`public/app.js` / `index.html` 的改动用 `.dev\*.mjs` 走一遍页面。

## 宣传素材

素材不在仓库里，原先放在 C 盘会话目录 `outputs\video-assets`：
4 分半的宣传视频、v0.1.3 更新视频（短版 1 分 22 秒）、封面、二次元头像、
以及生成它们的脚本（在 `work\` 下：`make-video*.mjs`、`make-cover*.ps1`、`make-slides*.ps1`）。
配音用的是 Edge 在线语音（`work/tools/node_modules/msedge-tts`，女声 zh-CN-XiaoxiaoNeural），
**需要联网，而且它偶尔会掐连接**，脚本里已经做了重试和跳过已生成段落。
