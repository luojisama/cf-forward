# cf-forward

部署到 **Cloudflare Workers** 的**无状态透明反向代理**，让国内用户能访问 Steam Web API（CS Major 竞猜 / 战绩）、Pixiv（鉴权 + 数据接口 + 图片）、Bangumi 图片。

核心原则：**客户端照常把 `key / token / 验证码(steamidkey) / knowncode` 带在请求里**，Worker 只改写「域名 + 路径」并在上游有防盗链处注入 `Referer`，再原样回传响应。所以：

> 国内请求本项目 == 翻墙直连官方 API，**同一个 key / token 效果完全一致**。Worker 不存储任何密钥。

---

## 路由映射表

| 本项目路径 | 官方上游 | 说明 |
|---|---|---|
| `/steam/cs/major/<...>` | `https://api.steampowered.com/ICSGOTournaments_730/<...>` | CS Major 竞猜管理。`steamidkey` = 竞猜管理验证码，`key` = 开发者 key，由客户端在 query 带入 |
| `/steam/cs/record/<...>` | `https://api.steampowered.com/ICSGOPlayers_730/<...>` | 战绩 / 比赛记录。`steamidkey` = 比赛记录验证码。上游严格限流，429/503 原样回传 |
| `/pixiv/auth/<...>` | `https://oauth.secure.pixiv.net/auth/<...>` | 获取 / 刷新 token（POST） |
| `/pixiv/app/<...>` | `https://app-api.pixiv.net/<...>` | 数据接口，透传 `Authorization: Bearer` |
| `/pixiv/img/<...>` | `https://i.pximg.net/<...>` | 图片，自动注入 `Referer` 绕过 403 + 边缘缓存 |
| `/bgm/pic/<...>` | `https://lain.bgm.tv/pic/<...>` | Bangumi 图片，注入 `Referer` + 边缘缓存 |

**映射规则**：剥掉前缀，把剩余 path + query 拼到上游后面。官方接口新增方法**无需改代码**，自动可用。扩展新上游只需在 [`src/routes.ts`](src/routes.ts) 加一行。

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

仓库 `https://github.com/luojisama/cf-forward` 已配置 GitHub Actions（[.github/workflows/deploy.yml](.github/workflows/deploy.yml)）：**push 到 `main` 即自动 `wrangler deploy`**，也可在仓库 Actions 页手动触发（workflow_dispatch）。

### 需在仓库配置 3 个 Secret

Settings → Secrets and variables → Actions（或用 `gh secret set`）：

| Secret | 说明 | 获取方式 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 部署用 API Token | CF 控制台 → My Profile → API Tokens → Create Token → 用 **Edit Cloudflare Workers** 模板 |
| `CLOUDFLARE_ACCOUNT_ID` | 账户 ID | CF 控制台 → Workers & Pages → 右侧 Account ID |
| `ACCESS_TOKEN` | 代理访问令牌 | 自定；每次部署会自动同步为 worker 的 Secret，**无需再手动** `wrangler secret put` |

命令行设置：

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set ACCESS_TOKEN
```

配好后，对 `main` 的任何提交都会自动重新部署；首次可在 Actions 页手动触发一次验证。自定义域名仍在 [`wrangler.jsonc`](wrangler.jsonc) 的 `routes` 配置。

---

## 客户端改写示例

把原本指向官方的地址，改成「本项目域名 + 对应前缀」，其余 path / query / 头 / body 不变即可：

| 原始 | 改写后 |
|---|---|
| `https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1?...` | `https://你的域名/steam/cs/record/GetNextMatchSharingCode/v1?...&_token=XXX` |
| `https://app-api.pixiv.net/v1/illust/detail?...` | `https://你的域名/pixiv/app/v1/illust/detail?...`（头带 `X-Proxy-Token`） |
| `https://i.pximg.net/img-original/img/.../p0.jpg` | `https://你的域名/pixiv/img/img-original/img/.../p0.jpg?_token=XXX` |
| `https://lain.bgm.tv/pic/cover/l/.../x.jpg` | `https://你的域名/bgm/pic/cover/l/.../x.jpg?_token=XXX` |

---

## 可选增强（默认关闭）

- 把 `/pixiv/app` 响应 JSON 里的 `i.pximg.net` 改写为 `<本域名>/pixiv/img`，让客户端图片也自动走代理（需缓冲 + 替换，牺牲纯透传）。
- 扩展 `api.bgm.tv` 数据接口、其它 Steam `I*_730` 接口：在 [`src/routes.ts`](src/routes.ts) 加一行。
- 按上游分别限速 / 配额，防单点刷爆 Steam 限流。

## 结构

```
src/index.ts    入口：OPTIONS / 鉴权 / 路由匹配 / 分发 / 统一错误与 CORS
src/routes.ts   路由表（前缀 → 上游 + referer + cache）—— 扩展点
src/proxy.ts    forward()：清洗头、注入 Referer、fetch、组装响应、缓存
```
