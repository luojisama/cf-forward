import { corsHeaders } from "./proxy";

/** X API v2 便捷接口：自动把「用户名 → 用户 ID → 最新推文」一次调通。
 *  纯透传路由 /twitter/api/ 只做一次转发；取某人最新推文需要先解析 ID 再取时间线（两跳），
 *  故单独封装。鉴权仍由 index.ts 的 _token 校验把关，本文件只负责对上游 X 的 Bearer。 */

const X_API_BASE = "https://api.twitter.com/2";

/** 本项目自有 / 已被便捷接口消费、不应透传给上游时间线的 query 参数 */
const CONSUMED_PARAMS = new Set(["username", "_token", "bearer"]);

/** 时间线默认带的字段（客户端显式传同名参数则以客户端为准） */
const DEFAULT_MAX_RESULTS = "10";
const DEFAULT_TWEET_FIELDS = "created_at,public_metrics,referenced_tweets,lang";

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

/** 上游 X 的 Bearer：优先 Authorization 头（去掉 "Bearer " 前缀），其次 ?bearer=（无法设头的场景） */
function resolveBearer(request: Request, url: URL): string {
  const header = request.headers.get("Authorization");
  if (header) return header.replace(/^Bearer\s+/i, "").trim();
  return (url.searchParams.get("bearer") ?? "").trim();
}

/** 把上游 X 的响应（状态码 + JSON 体）原样回传，附带 CORS */
async function relay(resp: Response): Promise<Response> {
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

/**
 * GET /twitter/user/tweets?username=<用户名>&max_results=10&...
 *   头：Authorization: Bearer <X API token>（或 ?bearer=）
 * 返回该用户的最新推文（X API v2 user tweets timeline）。
 * 除 username/_token/bearer 外的 query 参数（tweet.fields、expansions、exclude、
 * pagination_token、since_id、start_time 等）原样透传给时间线接口。
 */
export async function fetchUserTweets(request: Request, url: URL): Promise<Response> {
  const username = (url.searchParams.get("username") ?? "").trim().replace(/^@/, "");
  if (!username) {
    return json({ error: "bad_request", hint: "缺少 username 查询参数" }, 400);
  }

  const bearer = resolveBearer(request, url);
  if (!bearer) {
    return json(
      { error: "missing_bearer", hint: "需要 X API Bearer：带 Authorization: Bearer <token> 头，或 ?bearer=<token>" },
      400,
    );
  }
  const authHeaders = { Authorization: `Bearer ${bearer}` };

  // 第 1 跳：用户名 → 用户 ID
  const userResp = await fetch(
    `${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`,
    { headers: authHeaders },
  );
  if (!userResp.ok) return relay(userResp); // 401/403/429 等原样回传，便于排查
  const userJson = (await userResp.json()) as { data?: { id?: string } };
  const userId = userJson?.data?.id;
  if (!userId) {
    return json({ error: "user_not_found", username, upstream: userJson }, 404);
  }

  // 第 2 跳：用户 ID → 最新推文时间线
  const timeline = new URL(`${X_API_BASE}/users/${userId}/tweets`);
  url.searchParams.forEach((value, key) => {
    if (!CONSUMED_PARAMS.has(key)) timeline.searchParams.append(key, value);
  });
  if (!timeline.searchParams.has("max_results")) {
    timeline.searchParams.set("max_results", DEFAULT_MAX_RESULTS);
  }
  if (!timeline.searchParams.has("tweet.fields")) {
    timeline.searchParams.set("tweet.fields", DEFAULT_TWEET_FIELDS);
  }

  const timelineResp = await fetch(timeline.toString(), { headers: authHeaders });
  return relay(timelineResp);
}
