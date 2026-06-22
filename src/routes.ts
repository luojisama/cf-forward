export interface Route {
  /** 本项目路径前缀，必须以 "/" 开头和结尾 */
  prefix: string;
  /** 上游基地址；通常以 "/" 结尾，不以 "/" 结尾时剩余 path 会按路径段拼接 */
  upstream: string;
  /** 上游有防盗链时，转发时注入的 Referer */
  referer?: string;
  /** 是否启用边缘缓存（仅对 GET 生效，用于图片） */
  cache?: boolean;
  /** 文本响应里的上游绝对 URL 改写为本项目路径；仅用于网页 / oEmbed 等展示场景 */
  rewriteHosts?: HostRewrite[];
}

export interface HostRewrite {
  /** 上游绝对 URL 前缀，通常是 https://host/ */
  from: string;
  /** 本项目路径前缀，必须以 "/" 开头和结尾 */
  toPrefix: string;
}

const TWITTER_REWRITES: HostRewrite[] = [
  { from: "https://x.com/", toPrefix: "/x/web/" },
  { from: "https://twitter.com/", toPrefix: "/x/web/" },
  { from: "https://mobile.twitter.com/", toPrefix: "/x/web/" },
  { from: "https://publish.x.com/", toPrefix: "/x/publish/" },
  { from: "https://publish.twitter.com/", toPrefix: "/x/publish/" },
  { from: "https://platform.x.com/", toPrefix: "/x/platform/" },
  { from: "https://platform.twitter.com/", toPrefix: "/x/platform/" },
  { from: "https://syndication.twitter.com/", toPrefix: "/x/syndication/" },
  { from: "https://cdn.syndication.twimg.com/", toPrefix: "/x/syndication-cdn/" },
  { from: "https://pbs.twimg.com/", toPrefix: "/x/media/" },
  { from: "https://video.twimg.com/", toPrefix: "/x/video/" },
  { from: "https://abs.twimg.com/", toPrefix: "/x/abs/" },
  { from: "https://api.x.com/", toPrefix: "/x/api/" },
  { from: "https://api.twitter.com/", toPrefix: "/twitter/api/" },
];

const GITHUB_REWRITES: HostRewrite[] = [
  { from: "https://github.com/", toPrefix: "/github/web/" },
  { from: "https://raw.githubusercontent.com/", toPrefix: "/github/raw/" },
  { from: "https://api.github.com/", toPrefix: "/github/api/" },
  { from: "https://codeload.github.com/", toPrefix: "/github/codeload/" },
  { from: "https://github.githubassets.com/", toPrefix: "/github/assets/" },
  { from: "https://avatars.githubusercontent.com/", toPrefix: "/github/avatars/" },
  { from: "https://objects.githubusercontent.com/", toPrefix: "/github/objects/" },
  { from: "https://user-images.githubusercontent.com/", toPrefix: "/github/user-images/" },
  { from: "https://private-user-images.githubusercontent.com/", toPrefix: "/github/private-user-images/" },
];

/**
 * 路由表：唯一需要扩展的地方。
 * 规则：剥掉 prefix，把剩余 path + query 拼到 upstream 后面 —— 官方接口新增方法无需改代码。
 */
export const ROUTES: Route[] = [
  // Steam CS Major 竞猜管理（ICSGOTournaments_730）：steamidkey = 竞猜管理验证码，key = 开发者 key
  { prefix: "/steam/cs/major/", upstream: "https://api.steampowered.com/ICSGOTournaments_730/" },
  // Steam 战绩 / 比赛记录（ICSGOPlayers_730）：steamidkey = 比赛记录验证码
  { prefix: "/steam/cs/record/", upstream: "https://api.steampowered.com/ICSGOPlayers_730/" },
  // Steam 用户资料（ISteamUser）：GetPlayerSummaries(头像/昵称)、ResolveVanityURL(vanity→steamid) 等，需开发者 key
  { prefix: "/steam/user/", upstream: "https://api.steampowered.com/ISteamUser/" },
  // Pixiv 图片（注入 Referer 绕过 403 防盗链 + 缓存）
  { prefix: "/pixiv/img/", upstream: "https://i.pximg.net/", referer: "https://www.pixiv.net/", cache: true },
  // 注：Pixiv 鉴权(oauth.secure.pixiv.net) 与数据接口(app-api.pixiv.net) 在 Cloudflare 后面、
  // 会把来自 CF Workers 出口的请求判为机器人并返回 403 挑战页，无法在本 Worker 上提供（实测：
  // 同请求头，CF 出口 403、住宅出口 200）。如需 token/数据接口，请另起非 CF 出口的代理承载。
  // Bangumi 图片（注入 Referer + 缓存）
  { prefix: "/bgm/pic/", upstream: "https://lain.bgm.tv/pic/", referer: "https://bgm.tv/", cache: true },
  // Bangumi 数据 API（api.bgm.tv）：搜索/条目/角色等 v0 接口。纯透传——建议客户端带合规 User-Agent
  // （Bangumi 封禁 requests/axios 等库默认 UA）；认证类接口透传 Authorization: Bearer。不缓存（数据动态/含用户态）。
  { prefix: "/bgm/api/", upstream: "https://api.bgm.tv/" },
  // Twitter / X 官方 API v2（api.twitter.com）：纯透传，需付费 token，客户端自带 `Authorization: Bearer`。
  // 发推 / 转发(retweet) 等需用户上下文 OAuth 的 POST 走这里。不缓存。
  // 注：「自动取指定用户最新推文」改走免费的 syndication 接口（见 src/twitter.ts，/twitter/user/tweets），
  // 无需付费 API。此透传路由仅为需要官方 API 的场景（如发推/转发）保留。
  { prefix: "/twitter/api/", upstream: "https://api.twitter.com/" },
  // X/Twitter 展示相关：完整 x.com 页面受登录态、反爬和前端运行时影响，仅做 best-effort 域名改写；
  // 推荐优先使用 /x/oembed/ 展示推文，用 /x/media/ 和 /x/video/ 展示静态媒体。
  { prefix: "/x/oembed/", upstream: "https://publish.x.com/oembed", rewriteHosts: TWITTER_REWRITES },
  { prefix: "/x/publish/", upstream: "https://publish.x.com/", rewriteHosts: TWITTER_REWRITES },
  { prefix: "/x/platform/", upstream: "https://platform.x.com/", rewriteHosts: TWITTER_REWRITES },
  { prefix: "/x/syndication-cdn/", upstream: "https://cdn.syndication.twimg.com/", rewriteHosts: TWITTER_REWRITES },
  { prefix: "/x/syndication/", upstream: "https://syndication.twitter.com/", rewriteHosts: TWITTER_REWRITES },
  { prefix: "/x/media/", upstream: "https://pbs.twimg.com/", referer: "https://x.com/", cache: true },
  { prefix: "/x/video/", upstream: "https://video.twimg.com/", referer: "https://x.com/" },
  { prefix: "/x/abs/", upstream: "https://abs.twimg.com/", referer: "https://x.com/", cache: true },
  { prefix: "/x/api/", upstream: "https://api.x.com/" },
  { prefix: "/x/web/", upstream: "https://x.com/", rewriteHosts: TWITTER_REWRITES },
  { prefix: "/twitter/web/", upstream: "https://twitter.com/", rewriteHosts: TWITTER_REWRITES },
  // GitHub 转发：raw/api/codeload 为透明透传；web/assets 仅对文本响应做 best-effort 域名改写。
  { prefix: "/github/raw/", upstream: "https://raw.githubusercontent.com/" },
  { prefix: "/github/api/", upstream: "https://api.github.com/" },
  { prefix: "/github/codeload/", upstream: "https://codeload.github.com/" },
  { prefix: "/github/assets/", upstream: "https://github.githubassets.com/", rewriteHosts: GITHUB_REWRITES },
  { prefix: "/github/avatars/", upstream: "https://avatars.githubusercontent.com/" },
  { prefix: "/github/objects/", upstream: "https://objects.githubusercontent.com/" },
  { prefix: "/github/user-images/", upstream: "https://user-images.githubusercontent.com/" },
  { prefix: "/github/private-user-images/", upstream: "https://private-user-images.githubusercontent.com/" },
  { prefix: "/github/web/", upstream: "https://github.com/", rewriteHosts: GITHUB_REWRITES },
];

export function matchRoute(pathname: string): { route: Route; rest: string } | null {
  for (const route of ROUTES) {
    if (pathname.startsWith(route.prefix)) {
      return { route, rest: pathname.slice(route.prefix.length) };
    }
  }
  return null;
}
