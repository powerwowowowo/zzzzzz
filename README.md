# BlBl — B站自动化融合仓库

把两个各自独立的 B站自动化项目融合进同一个仓库，共用一套账号配置，在 **GitHub Actions** 上每天自动运行，不需要服务器、不需要常开电脑。

| 引擎 | 上游项目 | 技术栈 | 负责的事 |
| :--- | :--- | :--- | :--- |
| `bili-tool/` | [RayWangQvQ/BiliBiliToolPro](https://github.com/RayWangQvQ/BiliBiliToolPro) `4.0.5` | C# / .NET 10 | 每日经验（登录·观看·分享·投币）、漫画签到、银瓜子兑换硬币、大会员福利、大积分、月底充电、批量取关、直播间天选抽奖 |
| `lottery/` | [shanmiteko/LotteryAutoScript](https://github.com/shanmiteko/LotteryAutoScript) `2.11.2` | Node.js 22 | 动态转发抽奖：扫描抽奖动态、自动关注/转发/评论、AI 判断与 AI 评论、中奖检测、动态与关注清理 |

两者能力互补 —— 一个管"日常攒经验"，一个管"转发抽奖"，只有"天选时刻"一处重叠（默认关闭，见下文）。

---

## 一、融合点在哪

不只是把两个文件夹放进一个仓库，实际打通的环节：

1. **一套 Secrets 驱动两个引擎**
   `BILI_COOKIES` 配一次，`scripts/prepare-env.js` 会按引擎翻译成各自认识的格式：
   - C# 侧 → `Ray_BiliBiliCookies__1..N`
   - Node 侧 → `COOKIE` 或 `MULTIPLE_ACCOUNT_PARM`(JSON)

2. **推送配置同样只配一次**
   PushPlus / Server酱 / Telegram / 企业微信 / 钉钉 五家的密钥填一次，两边都会收到播报。

3. **定时错峰**
   日常任务与抽奖任务拉开一个多小时，避免同一 IP 在短时间内连续请求 B站接口。

4. **多账号统一**
   用 `|||` 分隔写多个 Cookie，两个引擎都会按顺序逐个账号执行。

---

## 二、部署步骤

### 1. 获取登录凭据（扫码，不用抓包）

> **为什么不能用账号密码？**
> B 站密码登录强制人机验证（极验 GeeTest）：先调 `/x/passport-login/captcha` 拿 `gt`/`challenge`，
> 用户在浏览器里拖滑块拿到 `validate`/`seccode`，登录接口的 `token` 还和这次验证绑定。
> 官方文档原话是"扫码登录不需要进行人机验证"。GitHub Actions 是无人值守环境，过不了滑块，
> 所以密码登录这条路在 B 站走不通。扫码登录才是唯一可行的自动化路径，而且它比抓包更省事。

**方式一：扫码自动写入（推荐）**

```bash
cd scripts && npm install && cd ..     # 首次需要，装两个小依赖
node scripts/bili-login.js
```

终端会直接渲染出二维码（同时另存一张 PNG 并自动打开），用手机「哔哩哔哩」App 扫一扫并确认，
脚本会自动换取 Cookie、校验登录态、加密后写入仓库的 `BILI_COOKIES` Secret —— 全程不需要复制粘贴。

常用参数：

| 参数 | 说明 |
| :--- | :--- |
| `--dry-run` | 只登录并打印 Cookie，不写 Secret |
| `--secret <名称>` | 写入别的 Secret 名 |
| `--extra "<Cookie>"` | 追加为第二个账号（多账号用 `\|\|\|` 连接） |
| `--proxy <地址>` | 访问 GitHub 的代理，默认读 `HTTPS_PROXY` 环境变量 |
| `--token <PAT>` | 显式指定 GitHub 凭据 |
| `--no-open` | 不自动弹出二维码图片 |

凭据来源优先级：`--token` > 环境变量 `GITHUB_TOKEN`/`GH_TOKEN` > git 凭据管理器。
写到 GitHub 的值用 libsodium sealed box 加密，明文不离开本机。

**方式二：手动抓 Cookie**

浏览器登录 B站 → `F12` → `Application` → `Cookies` → `https://www.bilibili.com`，拼成一行：

```
DedeUserID=xxx; SESSDATA=xxx; bili_jct=xxx; buvid3=xxx
```

> 扫码拿到的是一份**独立会话**，跟你在浏览器/App 里的登录互不干扰 ——
> 你在别处退出登录、清理浏览器数据，都不会让 Actions 里这份凭据失效。
> `SESSDATA` 本身有效期约 30 天，到期重跑一次脚本扫码即可。

### 2. 配置 Secrets

进入仓库 `Settings → Secrets and variables → Actions → New repository secret`。

**必填**

| 名称 | 说明 |
| :--- | :--- |
| `BILI_COOKIES` | 上一步拼好的 Cookie。**多账号用 `\|\|\|` 分隔**，例：`CookieA\|\|\|CookieB` |

**可选 —— 多账号简写**

| 名称 | 说明 |
| :--- | :--- |
| `BILI_COOKIE` | 仅单账号时可用，`BILI_COOKIES` 未配置时生效 |

**可选 —— 推送通知（不配则静默运行）**

| 名称 | 对应渠道 |
| :--- | :--- |
| `PUSH_PLUS_TOKEN` | PushPlus |
| `SERVERCHAN_KEY` | Server 酱 Turbo |
| `TG_BOT_TOKEN` + `TG_CHAT_ID` | Telegram |
| `QYWX_KEY` | 企业微信群机器人 key 或完整 webhook |
| `DINGTALK_TOKEN` + `DINGTALK_SECRET` | 钉钉机器人 |

**可选 —— 其他**

| 名称 | 说明 |
| :--- | :--- |
| `WEB_PROXY` | 访问 B站接口的代理，形如 `http://host:port`。仅在 Actions 出口 IP 被 B站风控时才需要配 |

### 3. 启用 Actions 并自检

刚建好的仓库默认关闭 Actions：

1. 进入 `Actions` 标签页，点 **I understand my workflows, go ahead and enable them**
2. 先跑 **环境自检**。它会编译 C# 引擎、安装抽奖依赖、并调用 B站只读接口校验 Cookie —— **不执行任何真实任务**（不投币、不关注、不转发）
3. 自检全绿后，再手动跑一次 `Bili 日常任务` 和 `B站动态抽奖`

手动跑通后，定时任务才会按计划启动。之后每次改了 Secrets，也可以重跑一次自检确认。

---

## 三、定时策略

GitHub Actions 的 cron 一律按 **UTC** 计算，下面已换算成北京时间：

| 任务 | 北京时间 | UTC cron |
| :--- | :--- | :--- |
| Bili 日常任务 | 每天 08:17 | `17 0 * * *` |
| B站动态抽奖 | 每天 09:23 | `23 1 * * *` |

刻意避开整点，是因为整点前后 Actions 排队最拥挤，执行时间可能被推迟几十分钟；错峰也能降低同一出口 IP 的请求撞车概率。

> `schedule` 只对**默认分支**生效。请确保这些 workflow 存在于默认分支（通常为 `main`）。

---

## 四、日常任务执行内容

日常清单不是固定的，workflow 会按当天日期自动组合，避免"每月一次"的任务被天天执行：

| 周期 | 执行的任务 | 说明 |
| :--- | :--- | :--- |
| 每天 | `Daily` `Manga` `Silver2Coin` | 每日经验、漫画签到、银瓜子换硬币 |
| 每月 1~3 日 | `VipPrivilege` `MangaPrivilege` `VipBigPoint` `UnfollowBatched` | 大会员福利、漫画福利、大积分、批量取关。连续 3 天尝试，防止 1 号当天接口异常导致整月错过 |
| 每月 28 日 | `Charge` | 月底把即将过期的 B 币券充给自己 |

**⚠️ 为什么必须按日期分组：** 这些任务的 AppService 内部**只有 `IsEnable` 开关，没有日期守卫**（日期调度原本由 Docker 模式下的 Quartz 负责）。如果每天都跑 `Charge`，就会每天真的给自己充电扣钱；每天跑 `UnfollowBatched`，就会每天批量取关 20 个。上述分组逻辑写在 workflow 的「计算当日任务清单」步骤里。

### 默认关闭的任务

以下任务需要额外消耗大量 Actions 时长或有副作用，默认不执行，需要时在手动触发时通过 `tasks` 输入框指定：

- `LiveLottery` — 直播间天选时刻抽奖。会关注大量主播，建议配合 `UnfollowBatched` 定期清理
- `LiveFansMedal` — 直播间粉丝牌亲密度。**单次需要挂机 70 分钟**，非常消耗 Actions 额度

手动触发时填写示例：`Daily&LiveLottery`

---

## 五、自定义抽奖策略

`lottery/my_config.js` 由上游模板生成，用于控制抽奖行为。这个文件**已被有意纳入版本管理**（不含任何凭据），你可以直接修改并提交，下一轮 Actions 就会生效。

常见调整项：

| 配置项 | 作用 |
| :--- | :--- |
| `default_config.UIDs` | 监视指定 UP 主的动态 |
| `default_config.TAGs` | 监视指定话题标签下的动态 |
| `default_config.Articles` | 监视专栏合集（默认 `抽奖合集`） |
| `default_config.model` | `'11'` 官方与非官方抽奖都转 |
| `default_config.chatmodel` | `'01'` 只评论非官方抽奖 |
| `default_config.minfollower` | UP 主粉丝数下限过滤（默认 1000） |
| `default_config.wait` | 转发间隔毫秒数（默认 30 秒，上下浮动 50%） |
| `default_config.uid_scan_page` / `tag_scan_page` | 检索页数，越大覆盖越广但越慢 |

首次运行请保留默认值，确认链路通了再逐步调整。

---

## 六、常见问题

**Q：私有仓库跑 Actions 会花很多钱吗？**

GitHub Free 账户的私有仓库每月有 2000 分钟免费额度（公开仓库不限量）。这套配置实测每次运行：日常任务约 3~8 分钟，抽奖约 5~30 分钟（取决于当天新增抽奖数量）。按每天一轮估算，每月约 300~1100 分钟，在免费额度内。如果抽奖频繁触发 90 分钟超时上限，建议缩小 `uid_scan_page` / `tag_scan_page`。

**Q：定时任务突然不跑了？**

GitHub 会在仓库**连续 60 天没有任何提交活动**后自动停用定时 workflow。解决办法：随便提交一次，或到 Actions 页面重新启用。想彻底避免，可以配一个每月一次的空提交。

**Q：怎么手动只跑某几个任务？**

`Actions → Bili 日常任务 → Run workflow`，在 `tasks` 输入框里填任务名，用 `&` 连接，例如 `Daily&LiveLottery`。留空则按当天日期自动组合。

**Q：Cookie 失效了怎么办？**

跑完后看 Actions 日志里的「Cookie有效性检测」，失效会明确报出 `登录失败 COOKIE 已失效 UID:xxx`。
此时重新执行一次 `node scripts/bili-login.js` 扫码即可，脚本会自动更新 Secret。

**Q：扫码脚本报 `unable to get local issuer certificate`？**

这说明你的网络里有个工具（Watt Toolkit / Steamcommunity302 等）在对 GitHub 做 TLS 中间人加速，
它的根证书只装在系统证书库里。脚本已经会自动把系统证书合并进 Node 的信任链，正常情况下无需干预。
如果仍报错，检查 Node 版本是否 ≥ 22.15（脚本依赖 `tls.getCACertificates`），
或改用代理：`node scripts/bili-login.js --proxy http://127.0.0.1:端口`。

**Q：为什么不用账号密码登录？**

见上文「获取登录凭据」一节。B 站密码登录强制极验人机验证，必须在浏览器里手动拖滑块，
任何无人值守环境都过不去。这不是本项目没做，而是 B 站设计上就不允许。

**Q：为什么子目录里也有 `.github/workflows`？**

那是两个上游项目自带的 CI 配置（CodeQL、Docker 构建、镜像同步等），**GitHub 只识别仓库根目录的 `.github/workflows/`**，子目录里的不会被加载执行，保留仅为对照上游。不放心可以直接删掉 `bili-tool/.github` 与 `lottery/.github`。

**Q：构建失败提示找不到 .NET 10 SDK？**

`bili-tool/global.json` 锁定 SDK `10.0.401` 且 `rollForward: latestFeature`。workflow 里用 `dotnet-version: '10.0.x'` 安装最新 10.0 SDK。若上游未来提升到 10.0.5xx，此处会自动满足。

---

## 七、本地运行（可选）

需要 .NET SDK 10 与 Node.js 22。

```bash
# 先拿一份 Cookie（不写 Secret，直接打印出来供本地使用）
node scripts/bili-login.js --dry-run

# C# 日常任务
cd bili-tool
export HUSKY=0
export Ray_BiliBiliCookies__1="DedeUserID=xxx; SESSDATA=xxx; bili_jct=xxx"
dotnet run --project src/Ray.BiliBiliTool.Console -- --runTasks "Daily"

# Node 抽奖
cd lottery
cp my_config.example.js my_config.js
export COOKIE="DedeUserID=xxx; SESSDATA=xxx; bili_jct=xxx"
node main.js start
```

---

## 八、目录结构

```
BlBl/
├── .github/workflows/
│   ├── bili-daily.yml          # 日常任务（.NET 10）
│   ├── lottery-daily.yml       # 动态抽奖（Node.js 22）
│   └── self-check.yml          # 环境自检（只读，不执行真实任务）
├── scripts/
│   ├── bili-login.js           # 扫码登录并自动写入 GitHub Secret
│   ├── prepare-env.js          # 统一配置下发：一套 Secrets -> 两个引擎
│   └── check-cookies.js        # Cookie 有效性只读校验
├── bili-tool/                  # BiliBiliToolPro 4.0.5
├── lottery/                    # LotteryAutoScript 2.11.2
└── .gitignore
```

---

## 九、上游与许可

本项目是两个开源项目的融合部署配置，两个上游均为 **GPL-3.0**，本仓库同样以 GPL-3.0 分发。

- [RayWangQvQ/BiliBiliToolPro](https://github.com/RayWangQvQ/BiliBiliToolPro) — MIT? 见 `bili-tool/LICENSE`
- [shanmiteko/LotteryAutoScript](https://github.com/shanmiteko/LotteryAutoScript) — 见 `lottery/LICENSE`

所有自动化行为仅用于个人学习与测试，请自行评估账号风险。
