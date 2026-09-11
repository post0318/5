import { NextRequest, NextResponse } from "next/server";

/**
 * 쓰기·갱신 경로 보호 (조회는 공개).
 * - 인증: `x-app-token` 헤더 또는 `app_session` 쿠키 == APP_PASSWORD
 * - 보호 대상:
 *     /manage                                (페이지 → /login 리다이렉트)
 *     POST   /api/universe                   (GET 목록은 공개)
 *     *      /api/universe/[id]              (PATCH·DELETE)
 *     POST   /api/universe/bulk
 *     GET    /api/universe/overview?refresh=1 (캐시 조회는 공개)
 *     *      /api/markets/[market]/[symbol]/news/summarize (LLM 비용 발생 — 비로그인 남용 방지)
 * - /api/cron/* 은 자체 CRON_SECRET 검증 → 여기서 제외
 */

function safeEq(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authed(req: NextRequest): boolean {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return false; // 미설정 시 fail-closed
  return (
    safeEq(req.headers.get("x-app-token"), pw) ||
    safeEq(req.cookies.get("app_session")?.value, pw)
  );
}

export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;
  const method = req.method;

  const isProtected =
    pathname === "/manage" ||
    (pathname === "/api/universe" && method !== "GET") ||
    pathname === "/api/universe/bulk" ||
    (pathname === "/api/universe/overview" &&
      searchParams.get("refresh") === "1") ||
    /^\/api\/universe\/(?!overview$|bulk$)[^/]+$/.test(pathname) || // /api/universe/[id]
    /^\/api\/markets\/[^/]+\/[^/]+\/news\/summarize$/.test(pathname);

  if (!isProtected || authed(req)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", pathname);
  const res = NextResponse.redirect(url);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = {
  matcher: ["/manage", "/api/universe/:path*", "/api/markets/:path*"],
};
