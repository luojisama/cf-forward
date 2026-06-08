export interface Route {
  /** 本项目路径前缀，必须以 "/" 开头和结尾 */
  prefix: string;
  /** 上游基地址，剩余 path 直接拼接在其后 */
  upstream: string;
  /** 上游有防盗链时，转发时注入的 Referer */
  referer?: string;
  /** 是否启用边缘缓存（仅对 GET 生效，用于图片） */
  cache?: boolean;
}

/**
 * 路由表：唯一需要扩展的地方。
 * 规则：剥掉 prefix，把剩余 path + query 拼到 upstream 后面 —— 官方接口新增方法无需改代码。
 */
export const ROUTES: Route[] = [
  // Steam CS Major 竞猜管理（ICSGOTournaments_730）：steamidkey = 竞猜管理验证码，key = 开发者 key
  { prefix: "/steam/cs/major/", upstream: "https://api.steampowered.com/ICSGOTournaments_730/" },
  // Steam 战绩 / 比赛记录（ICSGOPlayers_730）：steamidkey = 比赛记录验证码
  { prefix: "/steam/cs/record/", upstream: "https://api.steampowered.com/ICSGOPlayers_730/" },
  // Pixiv 图片（注入 Referer 绕过 403 防盗链 + 缓存）
  { prefix: "/pixiv/img/", upstream: "https://i.pximg.net/", referer: "https://www.pixiv.net/", cache: true },
  // 注：Pixiv 鉴权(oauth.secure.pixiv.net) 与数据接口(app-api.pixiv.net) 在 Cloudflare 后面、
  // 会把来自 CF Workers 出口的请求判为机器人并返回 403 挑战页，无法在本 Worker 上提供（实测：
  // 同请求头，CF 出口 403、住宅出口 200）。如需 token/数据接口，请另起非 CF 出口的代理承载。
  // Bangumi 图片（注入 Referer + 缓存）
  { prefix: "/bgm/pic/", upstream: "https://lain.bgm.tv/pic/", referer: "https://bgm.tv/", cache: true },
];

export function matchRoute(pathname: string): { route: Route; rest: string } | null {
  for (const route of ROUTES) {
    if (pathname.startsWith(route.prefix)) {
      return { route, rest: pathname.slice(route.prefix.length) };
    }
  }
  return null;
}
