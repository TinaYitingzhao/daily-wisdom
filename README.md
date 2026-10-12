# 每日智慧 · 微博相册

每天自动抓取 [索达吉堪布的微博](https://m.weibo.cn/u/1769787285)，把文字和原图保存到仓库，并生成一个适合在 iPad / 电脑上长时间播放的静态网页。

- **两种播放模式**：自动缓慢向上滚动；幻灯片（每条停留若干秒后淡入切换，长文会自动多停一会儿）
- 可调速度（1–10 档）、可暂停、可全屏，最新内容在最前
- 跟随系统深色模式，也可手动切换（按钮循环：跟随系统 → 浅色 → 深色）
- 支持 iPad / iPhone “添加到主屏幕”，打开后没有浏览器地址栏
- 播放时防止屏幕自动熄灭（浏览器支持 Wake Lock 时生效，iPadOS 16.4+ 的 Safari 支持）
- 控制栏几秒不动后自动隐藏，轻点屏幕或移动鼠标再出现
- 键盘：空格 = 播放/暂停，← → = 上/下一条（幻灯片模式），F = 全屏

## 目录结构

```
scripts/fetch_weibo.py        抓取脚本（只用 Python 标准库）
docs/                         网页（部署到 GitHub Pages 的就是这个目录）
  index.html / app.js / style.css / sw.js / manifest.webmanifest / icons/
  data/posts.json             抓到的微博（时间、正文、图片路径）
  images/                     下载下来的原图
.github/workflows/daily.yml   每天定时抓取 + 部署
.github/workflows/pages.yml   修改网页代码后自动部署
```

---

## 一、第一次部署（只需做一次）

### 1. 确认 cookie 已经存进 Secrets

仓库 → **Settings** → **Secrets and variables** → **Actions**，应该能看到名为 `WEIBO_COOKIE` 的 secret。没有的话按下面“三、如何获取 / 更新 cookie”添加。

### 2. 开启 GitHub Pages

仓库 → **Settings** → **Pages** → **Build and deployment** → **Source** 选 **GitHub Actions**。

> 注意选的是 “GitHub Actions”，不是 “Deploy from a branch”。

### 3. 确认 Actions 有写权限

仓库 → **Settings** → **Actions** → **General** → 最下面 **Workflow permissions** 选 **Read and write permissions**，保存。

### 4. 手动跑一次抓取

仓库 → **Actions** 标签 → 左侧选 **每日抓取微博** → 右侧 **Run workflow** → 分支选 `main` → 点绿色的 **Run workflow**。

第一次会抓最近约 100 条（可以在弹出框里改数字），带图片下载大概需要 5–15 分钟。完成后：

- 仓库里会多一个“每日更新：……”的提交，里面是 `docs/data/posts.json` 和 `docs/images/`
- 页面会自动部署，地址是 `https://<你的用户名>.github.io/daily-wisdom/`（也可以在 Settings → Pages 顶部看到）

### 5. 在 iPad 上添加到主屏幕

用 Safari 打开上面的网址 → 点分享按钮 → **添加到主屏幕**。之后从主屏幕图标打开就是全屏的。

建议同时在 iPad **设置 → 显示与亮度 → 自动锁定** 里设成“永不”，作为 Wake Lock 不生效时的兜底。

---

## 二、每日自动更新

`daily.yml` 每天 **北京时间早上 7:00** 自动运行：抓取新微博 → 有新内容就提交到仓库 → 重新部署网页。已经保存过的微博不会重复保存（按微博 ID 去重）。

页面打开期间每小时会检查一次新内容，在下一轮播放开始时自动换上，不用手动刷新。

### 如何调整更新时间

编辑 `.github/workflows/daily.yml` 里这一行：

```yaml
    - cron: "0 23 * * *"
```

GitHub 用的是 **UTC 时间**，比北京时间慢 8 小时，所以 **北京时间 = UTC + 8**。格式是 `分 时 日 月 星期`。几个例子：

| 想要的北京时间 | 写成 |
|---|---|
| 每天 7:00 | `"0 23 * * *"` |
| 每天 6:30 | `"30 22 * * *"` |
| 每天 9:00 | `"0 1 * * *"` |
| 每天 7:00 和 19:00 两次 | `"0 23,11 * * *"` |

> GitHub 的定时任务在高峰时段可能会晚几分钟到几十分钟才开始，这是正常的。
> 另外，仓库如果 60 天没有任何提交，GitHub 会自动停用定时任务；本项目每天有新内容提交，一般不会触发。如果被停用，在 Actions 页面点 **Enable workflow** 即可。

### 抓取失败会怎样

脚本遇到问题会让 Action **明确失败（红色 ✗）**，GitHub 默认会给你发邮件。点进失败的运行记录，“抓取微博”那一步会用红字写明原因，常见的有：

| 报错 | 原因与处理 |
|---|---|
| `没有找到 WEIBO_COOKIE` | Secret 没设置或名字写错，见下一节 |
| `微博要求登录：WEIBO_COOKIE 无效或已过期` | cookie 过期了，按下一节重新获取 |
| `请求失败（HTTP 403/418/432）` | 被微博风控，一般隔天会自动恢复；持续出现就换一个新 cookie |
| `N 条微博保存失败（下次运行会自动重试）` | 个别图片下载失败；成功的部分已经提交，失败的下次自动补 |

---

## 三、如何获取 / 更新 cookie

微博的接口需要登录才能看到内容，所以要把浏览器里的登录 cookie 交给 Action 使用。cookie 一般能用几周到几个月，过期后 Action 会报“微博要求登录”，这时重新做一遍下面的步骤即可。

> 建议用一个小号登录。cookie 等于登录凭证，只放在 GitHub Secrets 里，不要发给别人、不要写进代码。

### 获取 cookie（电脑上的 Chrome / Edge）

1. 打开 <https://m.weibo.cn> ，登录你的微博账号（务必是 **m.weibo.cn** 这个手机版域名）。
2. 登录后，打开 <https://m.weibo.cn/u/1769787285> 确认能看到微博内容。
3. 按 **F12**（Mac 上是 **⌥ Option + ⌘ Command + I**）打开开发者工具，切到 **Network（网络）** 标签。
4. 按 **F5** 刷新页面，在左侧列表里找一个名字以 `getIndex` 开头的请求，点它。
5. 右侧 **Headers（标头）** → **Request Headers（请求标头）** 里找到 **Cookie:** 这一行，把冒号后面的整串内容复制下来（很长，类似 `SUB=_2A25...; SUBP=...; _T_WM=...; ...`）。

   一定要包含 `SUB=` 这一项，它是登录凭证本体。

### 存进 GitHub Secrets

1. 仓库 → **Settings** → **Secrets and variables** → **Actions**。
2. 第一次：点 **New repository secret**，Name 填 `WEIBO_COOKIE`，Secret 粘贴刚才复制的内容，点 **Add secret**。
   更新：在列表里找到 `WEIBO_COOKIE`，点右侧铅笔图标 ✏️，粘贴新内容，点 **Update secret**。
3. 到 **Actions** 手动运行一次 **每日抓取微博**，确认变成绿色 ✓。

> 注意：在电脑浏览器里点“退出登录”会让这个 cookie 立刻失效。复制完之后直接关掉标签页即可，不要退出登录。

---

## 四、常用操作

### 手动触发一次抓取

**Actions** → **每日抓取微博** → **Run workflow** → **Run workflow**。

### 只重新部署网页（不抓取）

**Actions** → **部署网页** → **Run workflow**。修改 `docs/` 里的网页代码并推送到 `main` 时也会自动部署。

### 想重新从头抓

删除 `docs/data/posts.json` 里的内容（改成 `[]`）并提交，再手动运行抓取；已经下载过的图片不会重复下载。

### 在本地预览网页

```bash
cd docs
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

### 在本地运行抓取

```bash
export WEIBO_COOKIE='你的 cookie'
python3 scripts/fetch_weibo.py            # 首次默认抓约 100 条
python3 scripts/fetch_weibo.py --initial 50
```

---

## 关于存储空间

图片保存的是微博的大图（`large`），每张一般几百 KB。初始 100 条大约占 50–200 MB，之后每天增加几 MB。GitHub Pages 站点上限 1 GB，按这个速度可以用好几年；快满时可以考虑删掉最早的图片，或者改存小一点的图（在脚本的 `pic_urls` 里把网址中的 `/large/` 换成 `/mw1024/`）。
