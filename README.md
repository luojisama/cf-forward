# cf-forward

部署到 **Cloudflare Workers** 的**无状态透明反向代理**，让国内用户能访问 Steam Web API（CS Major 竞猜 / 战绩）、Pixiv 图片、Bangumi 图片。

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
| `/twitter/api/<...>` | `https://api.twitter.com/<...>` | Twitter / X API v2。纯透传，客户端自带 `Authorization: Bearer <token>`。发推 / 转发（retweet）等 POST 也走这里（需用户上下文 OAuth token）。不缓存 |

**映射规则**：剥掉前缀，把剩余 path + query 拼到上游后面。官方接口新增方法**无需改代码**，自动可用。扩展新上游只需在 [`src/routes.ts`](src/routes.ts) 加一行。

### 便捷接口：自动获取指定用户最新推文

X API v2 取「某人最新推文」需要两跳（用户名 → 用户 ID → 时间线），纯透传一次只能转一跳，故单独封装在 [`src/twitter.ts`](src/twitter.ts)：

```
GET /twitter/user/tweets?username=<用户名>&max_results=10&_token=<令牌>
Authorization: Bearer <X API token>      # 或浏览器等无法设头时用 ?bearer=<token>
```

- `username` **必填**（可带或不带 `@`）。
- 上游 X 的 Bearer：优先 `Authorization: Bearer` 头，其次 `?bearer=`。
- 除 `username` / `_token` / `bearer` 外的 query 参数（`max_results`、`tweet.fields`、`expansions`、`exclude`、`pagination_token`、`since_id`、`start_time` 等）**原样透传**给时间线接口。
- 默认带 `max_results=10`、`tweet.fields=created_at,public_metrics,referenced_tweets,lang`（客户端显式传同名参数则以客户端为准）。
- 上游错误（401 token 无效 / 403 权限不足 / 429 限流 / 用户名不存在）**原样回传**，便于排查。

> ⚠️ X API 需要付费/有额度的 Bearer token，本项目不存储、由客户端自带。CF Workers 出口访问 `api.twitter.com` 一般正常（面向服务端的 API），若遇区域性拦截，同 Pixiv 说明，需改用非 CF 出口承载。

> ⚠️ **Pixiv 的 token 鉴权（`oauth.secure.pixiv.net`）与数据接口（`app-api.pixiv.net`）未提供**：这两个上游在 Cloudflare 后面、会拦截来自 CF Workers 出口的请求（返回 403 机器人挑战页，基于出口 IP/指纹，改请求头无法绕过）。如需 token / 数据接口，请用**非 CF 出口**的代理（Deno Deploy / Vercel / 日本 VPS）承载。Pixiv 图片（`i.pximg.net`，另一套 CDN）不受影响，正常可用。

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

# Pixiv 刷新 token
curl -X POST "http://127.0.0.1:8787/pixiv/auth/token" \
  -H "X-Proxy-Token: test123" \
  -d "grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=..."

# Pixiv 图片（直连 i.pximg.net 会 403，这里应得 200）
curl -o a.jpg "http://127.0.0.1:8787/pixiv/img/img-original/img/2023/01/01/00/00/00/12345678_p0.jpg?_token=test123"

# Bangumi 图片
curl -o c.jpg "http://127.0.0.1:8787/bgm/pic/cover/l/aa/bb/12345_abcd.jpg?_token=test123"

# Twitter：自动取指定用户最新推文（用户名→ID→时间线，两跳）
curl "http://127.0.0.1:8787/twitter/user/tweets?username=jack&max_results=5&_token=test123" \
  -H "Authorization: Bearer <X_API_TOKEN>"

# Twitter：纯透传（任意 X API v2 端点，含发推/转发等 POST）
curl "http://127.0.0.1:8787/twitter/api/2/users/by/username/jack?_token=test123" \
  -H "Authorization: Bearer <X_API_TOKEN>"

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

---

## 客户端改写示例

把原本指向官方的地址，改成「本项目域名 + 对应前缀」，其余 path / query / 头 / body 不变即可：

| 原始 | 改写后 |
|---|---|
| `https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1?...` | `https://你的域名/steam/cs/record/GetNextMatchSharingCode/v1?...&_token=XXX` |
| `https://i.pximg.net/img-original/img/.../p0.jpg` | `https://你的域名/pixiv/img/img-original/img/.../p0.jpg?_token=XXX` |
| `https://lain.bgm.tv/pic/cover/l/.../x.jpg` | `https://你的域名/bgm/pic/cover/l/.../x.jpg?_token=XXX` |

---

## 可选增强（默认关闭）

- Pixiv token / 数据接口：另起**非 CF 出口**代理（Deno Deploy / Vercel / 日本 VPS）承载，CF 仍可作统一入口转发过去。
- 扩展 `api.bgm.tv` 数据接口、其它 Steam `I*_730` 接口：在 [`src/routes.ts`](src/routes.ts) 加一行。
- 按上游分别限速 / 配额，防单点刷爆 Steam 限流。

## 结构

```
src/index.ts    入口：OPTIONS / 鉴权 / 便捷接口 / 路由匹配 / 分发 / 统一错误与 CORS
src/routes.ts   路由表（前缀 → 上游 + referer + cache）—— 纯透传扩展点
src/proxy.ts    forward()：清洗头、注入 Referer、fetch、组装响应、缓存
src/twitter.ts  便捷接口：自动取指定用户最新推文（用户名→ID→时间线，两跳）
```
