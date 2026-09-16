import { clerkConfigured, isAdminEmail, requireAppUser } from "@/lib/server/app-auth";

export const runtime = "nodejs";

/**
 * 현재 로그인 계정이 유니버스를 쓸 수 있는지. 허용 판단은 서버에서만 하고,
 * 관리자 이메일 목록은 화면에 내려보내지 않는다.
 */
export async function GET() {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (!clerkConfigured()) {
    return Response.json(
      { enabled: false, signedIn: false, allowed: false, admin: false, email: null },
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
      reason: who.error,
    },
    noStore,
  );
}
