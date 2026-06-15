import { corsHeaders } from "./proxy";

/** 便捷接口：免官方付费 API，直接抓取指定用户最新推文。
 *
 *  走 X 官方给网页嵌入 widget 用的 syndication 接口（免鉴权、免费）：
 *    https://syndication.twitter.com/srv/timeline-profile/screen-name/<用户名>
 *  返回的是含 __NEXT_DATA__ 的页面，里面带完整时间线 JSON，提取后规整回传。
 *  鉴权仍由 index.ts 的 _token 校验把关；对上游 syndication 无需任何 token。 */

const SYND_BASE = "https://syndication.twitter.com/srv/timeline-profile/screen-name/";

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_CAP = 100;

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

/** 从 syndication 页面里抠出 __NEXT_DATA__ JSON */
function extractNextData(html: string): any | null {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 从一条原始 tweet 里抽取媒体（图片/视频/动图） */
function extractMedia(tweet: any): Array<{ type: string; url: string }> {
  const list = tweet?.extended_entities?.media ?? tweet?.entities?.media ?? [];
  const out: Array<{ type: string; url: string }> = [];
  for (const m of list) {
    if (m?.type === "photo") {
      out.push({ type: "photo", url: m.media_url_https });
    } else if (m?.type === "video" || m?.type === "animated_gif") {
      // 取码率最高的 mp4 变体
      const variants = (m?.video_info?.variants ?? []).filter((v: any) => v.content_type === "video/mp4");
      variants.sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      out.push({ type: m.type, url: variants[0]?.url ?? m.media_url_https });
    }
  }
  return out;
}

/** 把 syndication 的原始 tweet 规整成干净结构 */
function normalizeTweet(tweet: any): any {
  const screenName = tweet?.user?.screen_name ?? "";
  const isRetweet = Boolean(tweet?.retweeted_status);
  const isQuote = Boolean(tweet?.is_quote_status || tweet?.quoted_status);
  const isReply = tweet?.in_reply_to_screen_name != null;
  return {
    id: tweet?.id_str,
    created_at: tweet?.created_at,
    text: tweet?.full_text ?? tweet?.text ?? "",
    lang: tweet?.lang,
    url: tweet?.id_str ? `https://x.com/${screenName}/status/${tweet.id_str}` : undefined,
    is_retweet: isRetweet,
    is_reply: isReply,
    is_quote: isQuote,
    public_metrics: {
      favorite_count: tweet?.favorite_count ?? 0,
      retweet_count: tweet?.retweet_count ?? 0,
      reply_count: tweet?.reply_count ?? 0,
      quote_count: tweet?.quote_count ?? 0,
    },
    media: extractMedia(tweet),
  };
}

/**
 * GET /twitter/user/tweets?username=<用户名>&max_results=20&exclude=replies,retweets
 * 免官方 API，免鉴权抓取指定用户最新推文（按时间倒序）。
 *  - username 必填（可带或不带 @）
 *  - max_results：默认 20，上限 100
 *  - exclude：可选，逗号分隔，支持 replies / retweets
 */
export async function fetchUserTweets(url: URL): Promise<Response> {
  const username = (url.searchParams.get("username") ?? "").trim().replace(/^@/, "");
  if (!username || !/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    return json({ error: "bad_request", hint: "username 必填，且只能是字母/数字/下划线（1-15 位）" }, 400);
  }

  let maxResults = parseInt(url.searchParams.get("max_results") ?? "", 10);
  if (!Number.isFinite(maxResults) || maxResults <= 0) maxResults = DEFAULT_MAX_RESULTS;
  maxResults = Math.min(maxResults, MAX_RESULTS_CAP);

  const exclude = new Set(
    (url.searchParams.get("exclude") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  // 抓 syndication 页面（带浏览器 UA，避免被判库默认 UA）
  const resp = await fetch(SYND_BASE + encodeURIComponent(username), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!resp.ok) {
    return json({ error: "upstream_error", status: resp.status, hint: "syndication 抓取失败" }, 502);
  }

  const html = await resp.text();
  const data = extractNextData(html);
  const entries = data?.props?.pageProps?.timeline?.entries;
  if (!Array.isArray(entries)) {
    // 账号不存在/受保护/无推文时常见
    return json(
      { error: "no_timeline", username, hint: "未取到时间线：用户名可能不存在、账号受保护或无公开推文" },
      404,
    );
  }

  const rawTweets = entries
    .map((e: any) => e?.content?.tweet)
    .filter((t: any) => t && t.id_str);

  if (rawTweets.length === 0) {
    return json(
      { error: "no_tweets", username, hint: "无公开推文：用户名可能不存在、账号受保护或暂无推文" },
      404,
    );
  }

  let normalized = rawTweets.map(normalizeTweet);

  if (exclude.has("replies")) normalized = normalized.filter((t: any) => !t.is_reply);
  if (exclude.has("retweets")) normalized = normalized.filter((t: any) => !t.is_retweet);

  // 按时间倒序（syndication 返回的 entries 并非严格有序），取前 N 条
  normalized.sort((a: any, b: any) => Date.parse(b.created_at) - Date.parse(a.created_at));
  normalized = normalized.slice(0, maxResults);

  // 用户信息：取第一条原始推文里的 user
  const u = rawTweets[0]?.user;
  const user = u
    ? {
        id: u.id_str,
        screen_name: u.screen_name,
        name: u.name,
        profile_image_url: u.profile_image_url_https,
        verified: Boolean(u.verified || u.is_blue_verified),
      }
    : { screen_name: username };

  return json(
    { source: "syndication", user, count: normalized.length, tweets: normalized },
    200,
  );
}
