import { matchRoute, ROUTES } from "./routes";
import { forward, preflightResponse, corsHeaders } from "./proxy";
import { fetchUserTweets } from "./twitter";

/** 路由表之外的便捷接口（需自定义多跳逻辑，非纯透传），仅用于根路径展示 */
const EXTRA_ENDPOINTS = ["/twitter/user/tweets"];

export interface Env {
  /** 访问令牌，用 `wrangler secret put ACCESS_TOKEN` 注入；未配置则一律拒绝 */
  ACCESS_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS 预检
    if (request.method === "OPTIONS") return preflightResponse();

    const url = new URL(request.url);

    // 健康检查 / 根路径（公开，仅列出支持的前缀）
    if (url.pathname === "/" || url.pathname === "/favicon.ico") {
      return json(
        { ok: true, service: "cf-forward", routes: [...ROUTES.map((r) => r.prefix), ...EXTRA_ENDPOINTS] },
        200,
      );
    }

    // 令牌校验
    if (!(await isAuthorized(request, url, env))) {
      return json({ error: "unauthorized", hint: "带上 X-Proxy-Token 头，或 ?_token= 查询参数" }, 401);
    }

    try {
      // 便捷接口：自动获取指定用户最新推文（用户名→ID→时间线，两跳）
      if (url.pathname === "/twitter/user/tweets") {
        return await fetchUserTweets(request, url);
      }

      // 路由匹配（纯透传）
      const matched = matchRoute(url.pathname);
      if (!matched) {
        return json(
          { error: "not_found", hint: "未知路径", supported: [...ROUTES.map((r) => r.prefix), ...EXTRA_ENDPOINTS] },
          404,
        );
      }

      return await forward(request, matched.route, matched.rest, ctx);
    } catch (err) {
      return json({ error: "bad_gateway", detail: String(err) }, 502);
    }
  },
} satisfies ExportedHandler<Env>;

async function isAuthorized(request: Request, url: URL, env: Env): Promise<boolean> {
  const expected = env.ACCESS_TOKEN;
  if (!expected) return false; // 未配置 Secret 时一律拒绝，避免裸奔
  const provided = request.headers.get("X-Proxy-Token") ?? url.searchParams.get("_token") ?? "";
  // 先 SHA-256 再定长常量时间比较，避免长度/时序侧信道
  return constantTimeEqual(await sha256(provided), await sha256(expected));
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}
