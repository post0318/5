import { clerkClient } from "@clerk/nextjs/server";
import { jsonError, ok } from "@/lib/api";
import { claimLegacyUniverse, countLegacyUniverse } from "@/lib/universe/repo";
import { authErrorResponse, requireAdmin } from "@/lib/server/app-auth";

/**
 * Clerk 도입 이전(공유 비밀번호 시절)에 만들어진 소유자 없는 유니버스를 한
 * 계정에 귀속시킨다. 계정별 분리로 넘어가는 **1회성 마이그레이션**이라 관리
 * 화면에 남은 건수가 있을 때만 배너로 노출한다.
 *
 * 두 가지로 부를 수 있다.
 *  1) 관리자 세션 — 관리 화면 배너의 버튼. `ADMIN_EMAILS` 에 있는 계정만.
 *  2) 기계 토큰(CRON_SECRET / APP_PASSWORD) — `ADMIN_EMAILS` 를 아직 안 넣어
 *     배너가 안 보이는 상황을 푸는 경로(오너 요청 2026-09). 승인된 Clerk
 *     사용자가 **정확히 한 명일 때만** 그 계정으로 귀속시키고, 여러 명이면
 *     `?email=` 로 대상을 지정해야 한다. 마이그레이션이 끝나면 이 경로는
 *     지워도 된다.
 */
function machineAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

type TargetResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string };

/** 기계 토큰 경로에서 귀속시킬 Clerk 계정 고르기 */
async function resolveTargetUser(email: string | null): Promise<TargetResult> {
  const client = await clerkClient();
  const { data: users } = await client.users.getUserList({ limit: 100 });
  if (users.length === 0) return { ok: false, error: "승인된 계정이 아직 없습니다." };

  const emailOf = (u: (typeof users)[number]) =>
    u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? "";

  if (email) {
    const want = email.trim().toLowerCase();
    const hit = users.find((u) => emailOf(u).toLowerCase() === want);
    if (!hit) return { ok: false, error: `${email} 계정을 찾지 못했습니다.` };
    return { ok: true, userId: hit.id, email: emailOf(hit) };
  }
  if (users.length > 1) {
    return {
      ok: false,
      error: `승인된 계정이 ${users.length}개라 대상을 고를 수 없습니다. ?email= 로 지정하세요.`,
    };
  }
  return { ok: true, userId: users[0].id, email: emailOf(users[0]) };
}

export async function GET(req: Request) {
  try {
    if (!machineAuthorized(req)) {
      const who = await requireAdmin();
      if (!who.ok) return authErrorResponse(who);
    }
    return ok(
      { pending: await countLegacyUniverse() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(req: Request) {
  try {
    if (machineAuthorized(req)) {
      const email = new URL(req.url).searchParams.get("email");
      const target = await resolveTargetUser(email);
      if (!target.ok) return Response.json({ error: target.error }, { status: 400 });
      const res = await claimLegacyUniverse(target.userId);
      return ok({ ...res, target: target.email });
    }
    const who = await requireAdmin();
    if (!who.ok) return authErrorResponse(who);
    const res = await claimLegacyUniverse(who.userId);
    return ok({ ...res, target: who.email });
  } catch (err) {
    return jsonError(err);
  }
}
