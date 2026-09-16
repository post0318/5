import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * 앱 사용자 인증 — 4번 프로젝트(post0318/4)의 `lib/server/appAuth.ts` 와 동일한
 * 구조를 이식했다. Clerk 세션이 있고, 그 계정 이메일이 허용 도메인
 * (`ALLOWED_EMAIL_DOMAINS`)에 속하거나 관리자 목록(`ADMIN_EMAILS`)에 있어야 통과.
 *
 * Clerk 대기자(Waitlist) 모드에서는 관리자가 승인한 사람만 사용자로 존재하므로
 * 세션이 있다는 것 자체가 "승인됨"을 뜻한다. 도메인 검사는 승인 실수를 막는
 * 두 번째 방어선이다.
 *
 * 유니버스는 계정별로 분리되므로(`universe_items.ownerId`) 여기서 돌려주는
 * `userId` 가 곧 데이터 소유자 키다.
 *
 * 주의: `/api/cron/*` 는 사람이 아니라 수집 스크립트가 부르는 경로라 여기와
 * 무관하다 — 그쪽은 계속 CRON_SECRET / APP_PASSWORD 로 검증한다.
 */

export function clerkConfigured(): boolean {
  return (
    !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  );
}

/**
 * 허용 이메일 도메인. 비워 두면(기본) 도메인 제한 없이 "Clerk 이 승인한 계정"
 * 만으로 판단한다 — 개인용이라 승인 대기제 하나로 충분하고, 회사 도메인으로
 * 좁히고 싶으면 이 환경변수를 채우면 된다.
 */
export function allowedEmailDomains(): string[] {
  return (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** 관리자 이메일(`ADMIN_EMAILS`, 쉼표 구분) — 도메인 제한과 무관하게 통과 */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

export function isAllowedEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (isAdminEmail(e)) return true;
  const domains = allowedEmailDomains();
  if (domains.length === 0) return true; // 도메인 제한 미설정 = 승인만으로 충분
  const at = e.lastIndexOf("@");
  if (at < 0) return false;
  return domains.includes(e.slice(at + 1));
}

export type AppUserResult =
  | { ok: true; userId: string; email: string; admin: boolean }
  | { ok: false; status: 401 | 403 | 503; error: string };

export async function requireAppUser(): Promise<AppUserResult> {
  if (!clerkConfigured()) {
    return { ok: false, status: 503, error: "인증 서비스(Clerk)가 설정되지 않았습니다." };
  }
  const { userId } = await auth();
  if (!userId) return { ok: false, status: 401, error: "로그인이 필요합니다." };

  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "";
  if (!email || !isAllowedEmail(email)) {
    const domains = allowedEmailDomains();
    return {
      ok: false,
      status: 403,
      error: domains.length
        ? `허용된 이메일(${domains.map((d) => "@" + d).join(", ")}) 계정만 사용할 수 있습니다.`
        : "이 계정은 사용 승인되지 않았습니다.",
    };
  }
  return { ok: true, userId, email, admin: isAdminEmail(email) };
}

export async function requireAdmin(): Promise<AppUserResult> {
  const who = await requireAppUser();
  if (!who.ok) return who;
  if (!who.admin) return { ok: false, status: 403, error: "관리자만 할 수 있습니다." };
  return who;
}

/** 라우트에서: 인증 실패를 그대로 응답으로 바꾼다. */
export function authErrorResponse(who: Extract<AppUserResult, { ok: false }>): Response {
  return Response.json(
    { error: who.error },
    { status: who.status, headers: { "Cache-Control": "no-store" } },
  );
}
