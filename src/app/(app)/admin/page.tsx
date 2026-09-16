import { AdminAccounts } from "@/components/auth/admin-accounts";
import { requireAdmin } from "@/lib/server/app-auth";

export const dynamic = "force-dynamic";

/**
 * 계정 승인 관리 — 관리자(`ADMIN_EMAILS`)만. 헤더 계정 메뉴의 「승인 관리」로
 * 들어온다. 서버에서 먼저 권한을 확인해 관리자가 아니면 화면 자체를 안 내려
 * 준다(API 도 같은 검사).
 */
export default async function AdminPage() {
  const who = await requireAdmin();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">계정 승인 관리</h1>
      {who.ok ? (
        <AdminAccounts />
      ) : (
        <p className="text-destructive text-sm">
          {who.status === 401
            ? "로그인이 필요합니다. 헤더에서 로그인한 뒤 계정 메뉴 → 승인 관리로 들어오세요."
            : who.error}
        </p>
      )}
    </div>
  );
}
