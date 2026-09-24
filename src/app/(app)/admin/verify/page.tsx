import Link from "next/link";
import { VerifyBoard } from "@/components/admin/verify-board";
import { requireAdmin } from "@/lib/server/app-auth";

export const dynamic = "force-dynamic";

/** 재무 숫자 검증 결과 — 관리자(`ADMIN_EMAILS`)만. 서버에서 권한을 먼저 확인한다(API 도 같은 검사). */
export default async function AdminVerifyPage() {
  const who = await requireAdmin();
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">재무 검증</h1>
        <Link href="/admin" className="text-muted-foreground hover:text-foreground text-sm">계정 승인 관리 →</Link>
      </div>
      {who.ok ? (
        <VerifyBoard />
      ) : (
        <p className="text-destructive text-sm">
          {who.status === 401 ? "로그인이 필요합니다. 헤더에서 로그인한 뒤 계정 메뉴 → 재무 검증으로 들어오세요." : who.error}
        </p>
      )}
    </div>
  );
}
