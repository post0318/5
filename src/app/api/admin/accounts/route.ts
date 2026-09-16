import { clerkClient } from "@clerk/nextjs/server";
import { authErrorResponse, requireAdmin } from "@/lib/server/app-auth";

export const runtime = "nodejs";

/**
 * 계정 승인 관리 API — 관리자(`ADMIN_EMAILS`)만. 4번 프로젝트
 * (post0318/4)의 `/api/admin/accounts` 를 그대로 이식했다.
 *
 *  GET  → 대기자(신청·승인됨·거절됨) + 사용자 목록
 *  POST { action: "invite" | "reject" | "ban" | "unban", id }
 *    invite: 대기자 승인 → Clerk 가 가입 안내 메일 발송
 *    reject: 대기자 거절
 *    ban / unban: 이미 계정이 있는 사용자의 접근 차단·해제
 *      (삭제가 아니라 차단이다 — 되돌릴 수 있고, 그 계정의 유니버스도 남는다)
 */

export interface AdminWaitlistEntry {
  id: string;
  email: string;
  status: "pending" | "invited" | "completed" | "rejected";
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  banned: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  /** 이 계정이 담고 있는 유니버스 종목 수 */
  universeCount: number;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

const ACTIONS = ["invite", "reject", "ban", "unban"] as const;
type Action = (typeof ACTIONS)[number];

function clerkErrorMessage(e: unknown, fallback: string): string {
  const errs = (e as { errors?: { longMessage?: string; message?: string }[] })?.errors;
  return (
    errs?.[0]?.longMessage ??
    errs?.[0]?.message ??
    (e instanceof Error ? e.message : fallback)
  );
}

export async function GET() {
  const who = await requireAdmin();
  if (!who.ok) return authErrorResponse(who);

  const { countUniverseByOwner } = await import("@/lib/universe/repo");
  const client = await clerkClient();
  const [wl, us, counts] = await Promise.all([
    client.waitlistEntries.list({ limit: 100, orderBy: "-created_at" }),
    client.users.getUserList({ limit: 100, orderBy: "-created_at" }),
    countUniverseByOwner(),
  ]);

  const waitlist: AdminWaitlistEntry[] = wl.data.map((e) => ({
    id: e.id,
    email: e.emailAddress,
    status: e.status,
    createdAt: iso(e.createdAt) ?? "",
  }));
  const users: AdminUser[] = us.data.map((u) => ({
    id: u.id,
    email:
      u.emailAddresses.find((a) => a.id === u.primaryEmailAddressId)?.emailAddress ??
      u.emailAddresses[0]?.emailAddress ??
      "",
    banned: u.banned,
    createdAt: iso(u.createdAt) ?? "",
    lastSignInAt: iso(u.lastSignInAt),
    universeCount: counts.get(u.id) ?? 0,
  }));

  return Response.json(
    { waitlist, users, me: who.email },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const who = await requireAdmin();
  if (!who.ok) return authErrorResponse(who);

  let body: { action?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "요청 본문이 JSON 이 아닙니다." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const action = String(body.action) as Action;
  if (!id || !ACTIONS.includes(action)) {
    return Response.json({ error: "action/id 가 올바르지 않습니다." }, { status: 400 });
  }

  const client = await clerkClient();
  try {
    if (action === "invite") await client.waitlistEntries.invite(id);
    else if (action === "reject") await client.waitlistEntries.reject(id);
    else if (action === "ban") {
      if (id === who.userId) {
        return Response.json({ error: "자기 자신은 차단할 수 없습니다." }, { status: 400 });
      }
      await client.users.banUser(id);
    } else await client.users.unbanUser(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: clerkErrorMessage(e, "처리에 실패했습니다.") },
      { status: 502 },
    );
  }
}
