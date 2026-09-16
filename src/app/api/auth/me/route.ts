import {
  allowedEmailDomains,
  clerkConfigured,
  isAdminEmail,
  requireAppUser,
} from "@/lib/server/app-auth";

export const runtime = "nodejs";

/**
 * 현재 로그인 계정이 유니버스를 쓸 수 있는지. 허용 판단은 서버에서만 하고,
 * 관리자 이메일 목록은 화면에 내려보내지 않는다.
 *
 * `domains` 는 가입 신청 화면의 **사전 검사·안내 문구용**이다 — 진짜 판단은
 * 여기(서버)가 하고, 화면은 잘못된 주소로 신청해 승인 대기만 쌓이는 걸 막는다.
 */
export async function GET() {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const domains = allowedEmailDomains();
  if (!clerkConfigured()) {
    return Response.json(
      {
        enabled: false,
        signedIn: false,
        allowed: false,
        admin: false,
        email: null,
        domains,
      },
      noStore,
    );
  }
  const who = await requireAppUser();
  if (who.ok) {
    return Response.json(
      {
        enabled: true,
        signedIn: true,
        allowed: true,
        admin: isAdminEmail(who.email),
        email: who.email,
        domains,
      },
      noStore,
    );
  }
  return Response.json(
    {
      enabled: true,
      signedIn: who.status !== 401,
      allowed: false,
      admin: false,
      email: null,
      domains,
      reason: who.error,
    },
    noStore,
  );
}
