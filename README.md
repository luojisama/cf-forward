# cf-forward

部署到 **Cloudflare Workers** 的**无状态透明反向代理**，让国内用户能访问 Steam Web API（CS Major 竞猜 / 战绩）、Pixiv 图片、Bangumi 图片、X/Twitter 媒体与嵌入、GitHub raw/API/下载资源。

核心原则：**客户端照常把 `key / token / 验证码(steamidkey) / knowncode` 带在请求里**，Worker 只改写「域名 + 路径」并在上游有防盗链处注入 `Referer`，再原样回传响应。所以：

> 国内请求本项目 == 翻墙直连官方 API，**同一个 key / token 效果完全一致**。Worker 不存储任何密钥。

---

## 路由映射表

| 本项目路径 | 官方上游 | 说明 |
|---|---|---|
| `/steam/cs/major/<...>` | `https://api.steampowered.com/ICSGOTournaments_730/<...>` | CS Major 竞猜管理。`steamidkey` = 竞猜管理验证码，`key` = 开发者 key，由客户端在 query 带入 |
| `/steam/cs/record/<...>` | `https://api.steampowered.com/ICSGOPlayers_730/<...>` | 战绩 / 比赛记录。`steamidkey` = 比赛记录验证码。上游严格限流，429/503 原样回传 |
| `/steam/user/<...>` | `https://api.steampowered.com/ISteamUser/<...>` | 用户资料。`GetPlayerSummaries`（头像/昵称）、`ResolveVanityURL`（vanity→steamid）等。需开发者 `key` |
| `/pixiv/img/<...>` | `https://i.pximg.net/<...>` | 图片，自动注入 `Referer` 绕过 403 + 边缘缓存 |
| `/bgm/pic/<...>` | `https://lain.bgm.tv/pic/<...>` | Bangumi 图片，注入 `Referer` + 边缘缓存 |
| `/bgm/api/<...>` | `https://api.bgm.tv/<...>` | Bangumi 数据 API（搜索/条目/角色等 v0 接口）。**客户端建议带合规 `User-Agent`**（Bangumi 会封禁 `requests`/`axios` 等库默认 UA）；认证接口透传 `Authorization: Bearer`。不缓存 |
| `/twitter/user/tweets?username=<...>` | `https://syndication.twitter.com/...`（嵌入 widget 接口） | **自动获取指定用户最新推文，免官方付费 API、免鉴权**。详见下文 |
| `/twitter/api/<...>` | `https://api.twitter.com/<...>` | X 官方 API v2 纯透传，需**付费** token（客户端自带 `Authorization: Bearer`）。仅为发推 / 转发（retweet）等需官方 API 的场景保留。不缓存 |
| `/x/oembed/` | `https://publish.x.com/oembed` | X/Twitter 推文嵌入 JSON；文本响应会 best-effort 改写其中的脚本、媒体域名 |
| `/x/media/<...>` | `https://pbs.twimg.com/<...>` | X/Twitter 图片，注入 `Referer` + 边缘缓存 |
| `/x/video/<...>` | `https://video.twimg.com/<...>` | X/Twitter 视频资源，注入 `Referer`，不缓存 Range/分片响应 |
| `/x/web/<...>` | `https://x.com/<...>` | X 页面 best-effort 透传与文本域名改写；不保证完整交互网页可用 |
| `/github/raw/<...>` | `https://raw.githubusercontent.com/<...>` | GitHub raw 文件透明透传 |
| `/github/api/<...>` | `https://api.github.com/<...>` | GitHub API 透明透传；认证接口透传 `Authorization` |
| `/github/codeload/<...>` | `https://codeload.github.com/<...>` | GitHub 源码包下载透明透传 |
| `/github/web/<...>` | `https://github.com/<...>` | GitHub 页面 best-effort 透传与文本域名改写 |

**映射规则**：剥掉前缀，把剩余 path + query 拼到上游后面。官方接口新增方法**无需改代码**，自动可用。扩展新上游只需在 [`src/routes.ts`](src/routes.ts) 加一行。

### 便捷接口：自动获取指定用户最新推文（免费、免鉴权）

X 官方 API v2 现已付费，故「取某人最新推文」改走 X 官方给网页**嵌入 widget** 用的 syndication 接口（`syndication.twitter.com`，**免 token、免费**），抓取后解析 `__NEXT_DATA__` 并规整成干净 JSON。实现见 [`src/twitter.ts`](src/twitter.ts)：

```
GET /twitter/user/tweets?username=<用户名>&max_results=20&exclude=replies,retweets&_token=<令牌>
```

- `username` **必填**（可带或不带 `@`；仅字母/数字/下划线，1-15 位）。
- `max_results`：默认 `20`，上限 `100`。
- `exclude`：可选，逗号分隔，支持 `replies`（排除回复）、`retweets`（排除转推）。
- 结果按**时间倒序**（最新在前），每条含 `id` / `created_at` / `text` / `lang` / `url` / `public_metrics`（赞/转/评/引用数）/ `media`（图片或视频直链）/ `is_retweet` `is_reply` `is_quote` 标记，并附 `user`（昵称/头像/认证）。
- 仅需本项目 `_token`，**无需任何 Twitter token**。
- 用户名不存在 / 账号受保护 / 无公开推文 → `404`。

> 说明：syndication 是只读的公开嵌入接口，仅能取**公开**账号的推文，不支持发推 / 转发等写操作——写操作需官方付费 API（走上面的 `/twitter/api/` 透传，客户端自带用户 token）。CF Workers 出口访问 `syndication.twitter.com` 实测正常。

> ⚠️ **Pixiv 的 token 鉴权（`oauth.secure.pixiv.net`）与数据接口（`app-api.pixiv.net`）未提供**：这两个上游在 Cloudflare 后面、会拦截来自 CF Workers 出口的请求（返回 403 机器人挑战页，基于出口 IP/指纹，改请求头无法绕过）。如需 token / 数据接口，请用**非 CF 出口**的代理（Deno Deploy / Vercel / 日本 VPS）承载。Pixiv 图片（`i.pximg.net`，另一套 CDN）不受影响，正常可用。

### X/Twitter 展示说明

X/Twitter 的完整网页高度依赖登录态、反爬策略、前端脚本和 CSP，**不能保证只靠 Workers 域名替换就完整打开 x.com 页面**。本项目做了可控范围内的增强：

- 优先尝试展示推文：走 `/x/oembed/` 转发 `publish.x.com/oembed`，返回 JSON 中的 `platform.x.com`、`pbs.twimg.com` 等域名会 best-effort 改写到本项目对应前缀。
- 推荐展示图片 / 视频：走 `/x/media/`、`/x/video/`；图片会缓存，视频因常见 Range/分片请求只做透传。
- `/x/web/` 与 `/twitter/web/` 只是 best-effort 页面透传。公开页面可能成功，登录、交互、无限滚动等不作为可靠能力承诺。

常用 X/Twitter 前缀：

| 本项目路径 | 官方上游 |
|---|---|
| `/x/oembed/` | `https://publish.x.com/oembed` |
| `/x/publish/<...>` | `https://publish.x.com/<...>` |
| `/x/platform/<...>` | `https://platform.x.com/<...>` |
| `/x/syndication/<...>` | `https://syndication.twitter.com/<...>` |
| `/x/syndication-cdn/<...>` | `https://cdn.syndication.twimg.com/<...>` |
| `/x/media/<...>` | `https://pbs.twimg.com/<...>` |
| `/x/video/<...>` | `https://video.twimg.com/<...>` |
| `/x/abs/<...>` | `https://abs.twimg.com/<...>` |
| `/x/api/<...>` | `https://api.x.com/<...>` |
| `/twitter/api/<...>` | `https://api.twitter.com/<...>` |
| `/x/web/<...>` | `https://x.com/<...>` |
| `/twitter/web/<...>` | `https://twitter.com/<...>` |

### GitHub 转发前缀

GitHub 的 raw/API/下载资源按透明透传处理；`/github/web/` 和 `/github/assets/` 会对小型文本响应做 best-effort 域名改写，方便页面里继续通过本项目域名请求资源。

| 本项目路径 | 官方上游 |
|---|---|
| `/github/raw/<...>` | `https://raw.githubusercontent.com/<...>` |
| `/github/api/<...>` | `https://api.github.com/<...>` |
| `/github/codeload/<...>` | `https://codeload.github.com/<...>` |
| `/github/assets/<...>` | `https://github.githubassets.com/<...>` |
| `/github/avatars/<...>` | `https://avatars.githubusercontent.com/<...>` |
| `/github/objects/<...>` | `https://objects.githubusercontent.com/<...>` |
| `/github/user-images/<...>` | `https://user-images.githubusercontent.com/<...>` |
| `/github/private-user-images/<...>` | `https://private-user-images.githubusercontent.com/<...>` |
| `/github/web/<...>` | `https://github.com/<...>` |

---

## 鉴权（令牌校验）

每个请求（除 `/` 健康检查）必须携带令牌，二选一（转发前会被剥除，不外泄给上游）：

- 请求头：`X-Proxy-Token: <你的令牌>` —— 脚本 / API 客户端用
- 查询参数：`?_token=<你的令牌>` —— 浏览器 `<img src>` 等无法设头的场景用

令牌存在 Cloudflare Secret `ACCESS_TOKEN` 里，**不进代码、不进仓库**。

---

## 本地开发

```bash
npm install -D wrangler typescript @cloudflare/workers-types
npm run dev        # wrangler dev，默认 http://127.0.0.1:8787
```

本地令牌取自 [`.dev.vars`](.dev.vars)（默认 `test123`，已 gitignore）。

冒烟测试（把占位符换成真实值）：

```bash
# 战绩：取下一个比赛分享码
curl "http://127.0.0.1:8787/steam/cs/record/GetNextMatchSharingCode/v1?key=K&steamid=S&steamidkey=A-A-A&knowncode=CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx&_token=test123"

# 竞猜：取赛事 layout
curl "http://127.0.0.1:8787/steam/cs/major/GetTournamentLayout/v1?event=21&_token=test123"

# Pixiv 图片（直连 i.pximg.net 会 403，这里应得 200）
curl -o a.jpg "http://127.0.0.1:8787/pixiv/img/img-original/img/2023/01/01/00/00/00/12345678_p0.jpg?_token=test123"

# Bangumi 图片
curl -o c.jpg "http://127.0.0.1:8787/bgm/pic/cover/l/aa/bb/12345_abcd.jpg?_token=test123"

# Twitter：自动取指定用户最新推文（免费、免鉴权，走 syndication）
curl "http://127.0.0.1:8787/twitter/user/tweets?username=Lyytoaoitori&max_results=5&_token=test123"

# Twitter：官方 API 纯透传（发推/转发等写操作，需付费 token，客户端自带）
curl "http://127.0.0.1:8787/twitter/api/2/users/by/username/jack?_token=test123" \
  -H "Authorization: Bearer <X_API_TOKEN>"

# X/Twitter oEmbed（把 url 换成真实推文 URL）
curl "http://127.0.0.1:8787/x/oembed/?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20&_token=test123"

# X/Twitter 图片
curl -o tw.jpg "http://127.0.0.1:8787/x/media/media/example.jpg?_token=test123"

# GitHub raw
curl "http://127.0.0.1:8787/github/raw/octocat/Hello-World/master/README?_token=test123"

# 鉴权失败 → 401
curl -i "http://127.0.0.1:8787/bgm/pic/cover/l/aa/bb/12345_abcd.jpg"
```

---

## 部署

```bash
npx wrangler login
npx wrangler secret put ACCESS_TOKEN   # 输入生产令牌
npm run deploy
```

### ⚠️ 国内可达性（关键）

- **`*.workers.dev` 在中国大陆被普遍污染 / 封锁**，仅适合联调。面向国内**必须绑定自有自定义域名**：域名需先托管在 Cloudflare 并开启橙云代理，然后在 [`wrangler.jsonc`](wrangler.jsonc) 里取消 `routes` 注释填上你的域名。
- 即便用自定义域名，Cloudflare Anycast 到大陆线路仍可能不稳。追求稳定需考虑 CF 中国接入（企业版）或择优 IP。这是**部署层的现实约束，与本项目代码无关**。
- Worker 出口在墙外，连 Steam / Pixiv / Bangumi 均正常。

---

## 自动部署（CI/CD）

通过 **Cloudflare Workers Builds（Connect to Git）** 部署：在 Cloudflare 控制台把本仓库连上后，**push 到 `main` 即由 Cloudflare 自动构建并部署**（无需 GitHub Actions）。

一次性配置：

- **运行时令牌**：Workers & Pages → `cf-forward` → **Settings → Variables and Secrets**，添加**类型为 Secret** 的 `ACCESS_TOKEN`（值即客户端请求要带的令牌）。
  - ⚠️ 必须是 **Secret** 类型：若设为明文 **Variable**，下次构建跑 `wrangler deploy` 会按 `wrangler.jsonc`（未声明它）把它**冲掉**，导致运行时读不到、一律 `401`。
  - ⚠️ 密钥**只写不可读**，忘了只能覆盖重设（`wrangler secret put ACCESS_TOKEN` 或控制台编辑）。
- **自定义域名**：在 [`wrangler.jsonc`](wrangler.jsonc) 的 `routes` 配置，或在控制台为 Worker 绑定。当前生产域名 `forward.shiro.team`。

### GitHub Actions 部署（可选）

仓库内也提供 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)。相比旧版 `cloudflare/wrangler-action@v3` 的 `secrets:` 上传流程，它直接调用本仓库锁定的 `npx wrangler deploy --keep-vars --secrets-file .wrangler/secrets.json`：

- 首次部署时不再因为 Worker 尚未创建而卡在 “Uploading secrets...”。
- `ACCESS_TOKEN` 会随本次部署作为 Worker Secret 一起上传，不写入代码或日志。
- `--keep-vars` 会保留控制台里已有的变量 / Secret，避免部署时被清空。

需要在 GitHub 仓库 `Settings → Secrets and variables → Actions` 配置 3 个 Secret：

| GitHub Secret | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token；建议使用 Cloudflare 的 “Edit Cloudflare Workers” 模板，若通过 `routes` 绑定域名，还需对应 Zone 的 Worker Routes 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `ACCESS_TOKEN` | 本项目运行时鉴权令牌，即客户端请求要带的 `X-Proxy-Token` / `_token` |

---

## 客户端改写示例

把原本指向官方的地址，改成「本项目域名 + 对应前缀」，其余 path / query / 头 / body 不变即可：

| 原始 | 改写后 |
|---|---|
| `https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1?...` | `https://你的域名/steam/cs/record/GetNextMatchSharingCode/v1?...&_token=XXX` |
| `https://i.pximg.net/img-original/img/.../p0.jpg` | `https://你的域名/pixiv/img/img-original/img/.../p0.jpg?_token=XXX` |
| `https://lain.bgm.tv/pic/cover/l/.../x.jpg` | `https://你的域名/bgm/pic/cover/l/.../x.jpg?_token=XXX` |
| `https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fu%2Fstatus%2F123` | `https://你的域名/x/oembed/?url=https%3A%2F%2Fx.com%2Fu%2Fstatus%2F123&_token=XXX` |
| `https://pbs.twimg.com/media/xxx.jpg` | `https://你的域名/x/media/media/xxx.jpg?_token=XXX` |
| `https://raw.githubusercontent.com/owner/repo/main/file.txt` | `https://你的域名/github/raw/owner/repo/main/file.txt?_token=XXX` |
| `https://codeload.github.com/owner/repo/zip/refs/heads/main` | `https://你的域名/github/codeload/owner/repo/zip/refs/heads/main?_token=XXX` |

---

## 可选增强（默认关闭）

- Pixiv token / 数据接口：另起**非 CF 出口**代理（Deno Deploy / Vercel / 日本 VPS）承载，CF 仍可作统一入口转发过去。
- X/Twitter 完整页面：当前只做 best-effort 文本域名改写；需要稳定展示推文时优先使用 `/x/oembed/`，需要稳定媒体时优先使用 `/x/media/` / `/x/video/`。
- 扩展 `api.bgm.tv` 数据接口、其它 Steam `I*_730` 接口：在 [`src/routes.ts`](src/routes.ts) 加一行。
- 按上游分别限速 / 配额，防单点刷爆 Steam 限流。

## 结构

```
src/index.ts    入口：OPTIONS / 鉴权 / 便捷接口 / 路由匹配 / 分发 / 统一错误与 CORS
src/routes.ts   路由表（前缀 → 上游 + referer + cache）—— 纯透传扩展点
src/proxy.ts    forward()：清洗头、注入 Referer、fetch、组装响应、缓存
src/twitter.ts  便捷接口：免费抓指定用户最新推文（syndication 接口 → 解析 → 规整 JSON）
```
