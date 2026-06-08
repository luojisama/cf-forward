import type { Route } from "./routes";

/** 转发前要从请求头删除的项：hop-by-hop、CF 注入、宿主相关、本项目自有鉴权头 */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-proxy-token",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, X-Proxy-Token, App-OS, App-OS-Version, App-Version, User-Agent, Accept-Language",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export function corsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS };
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

function applyCors(headers: Headers): void {
  for (const key in CORS_HEADERS) headers.set(key, CORS_HEADERS[key]);
}

function withCors(resp: Response): Response {
  const r = new Response(resp.body, resp);
  applyCors(r.headers);
  return r;
}

/** 上游 URL = 上游基址 + 剩余 path + 清洗后的 query（剥除自有的 _token） */
function buildUpstreamUrl(route: Route, rest: string, search: URLSearchParams): string {
  const url = new URL(route.upstream + rest);
  search.forEach((value, key) => {
    if (key === "_token") return; // 本项目令牌，不外泄给上游
    url.searchParams.append(key, value);
  });
  return url.toString();
}

function buildUpstreamHeaders(request: Request, route: Route): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  if (route.referer) {
    headers.set("Referer", route.referer);
    headers.delete("Origin"); // 避免暴露真实来源触发防盗链
  }
  return headers;
}

export async function forward(
  request: Request,
  route: Route,
  rest: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const reqUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(route, rest, reqUrl.searchParams);

  const cacheable = route.cache === true && request.method === "GET";
  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: "GET" });

  if (cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request, route),
    body: hasBody ? request.body : undefined,
    redirect: "follow",
  });

  const upstreamResponse = await fetch(upstreamRequest);

  // 用上游响应同时作为 body 来源和 init，保证 body 帧与 content-length/encoding 一致；
  // 经 new Response(...) 构造后头部可写，便于追加 CORS。
  const response = new Response(upstreamResponse.body, upstreamResponse);
  applyCors(response.headers);

  if (cacheable && upstreamResponse.ok) {
    // 缓存一份克隆，包进 waitUntil 避免悬空 Promise；put 失败（如含 Set-Cookie）静默忽略
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  }

  return response;
}
