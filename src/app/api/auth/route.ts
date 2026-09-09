import { cookies } from "next/headers";

/**
 * 관리자 세션 — 공유 비밀번호(APP_PASSWORD) 검증 후 httpOnly 쿠키 발급.
 * POST   { password }  → 로그인 (쿠키 설정)
 * DELETE               → 로그아웃 (쿠키 삭제)
 */

const COOKIE = "app_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30일

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function POST(request: Request) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) {
    return Response.json({ error: "APP_PASSWORD 미설정" }, { status: 503 });
  }
  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }
  if (!password || !safeEq(password, pw)) {
    return Response.json({ error: "비밀번호가 올바르지 않습니다" }, { status: 401 });
  }

  const jar = await cookies();
  jar.set(COOKIE, pw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // 로컬 http 에서도 로그인 가능
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return Response.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(COOKIE);
  return Response.json({ ok: true });
}
