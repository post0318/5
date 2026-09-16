"use client";

import { useState } from "react";
import { toast } from "sonner";
import { isAllowedEmail, useAppAuth } from "@/components/auth/app-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 가입 신청(승인 대기) 팝업. Clerk 대기자 모드라 신청만 접수되고, 관리자가
 * Clerk 대시보드에서 승인해야 로그인할 수 있다 — 4번 프로젝트와 같은 방식.
 *
 * 허용 도메인 검사도 4번과 같이 **이 화면에서 먼저** 한다(기본 hanwha.com,
 * `lib/server/app-auth.ts` 의 코드 기본값이라 Vercel 설정이 필요 없다).
 * 서버가 같은 값으로 한 번 더 확인하므로 여기 검사는 안내용이다 — 잘못된
 * 주소로 신청해 승인 대기만 쌓이는 걸 막는다.
 */
export function SignupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const auth = useAppAuth();
  const domains = auth.allowedDomains;
  const domainsLabel = domains.map((d) => `@${d}`).join(", ");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      toast.error("이메일 형식이 올바르지 않습니다.");
      return;
    }
    if (!isAllowedEmail(value, domains)) {
      toast.error(`${domainsLabel} 이메일만 신청할 수 있습니다.`);
      return;
    }
    setBusy(true);
    try {
      await auth.joinWaitlist(value);
      setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "가입 신청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function change(v: boolean) {
    onOpenChange(v);
    if (!v) {
      setDone(false);
      setEmail("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>가입 신청</DialogTitle>
          <DialogDescription>
            {domains.length > 0
              ? `${domainsLabel} 이메일만 신청할 수 있으며 관리자 승인이 필요합니다.`
              : "신청하면 관리자 승인 뒤에 로그인할 수 있습니다."}
            {" 승인되면 가입 안내 메일이 신청한 주소로 갑니다."}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <p className="text-sm">
            신청이 접수되었습니다. 승인되면 메일로 알려 드립니다.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signup-email">이메일</Label>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={`이름@${domains[0] ?? "example.com"}`}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy}>
                {busy ? "신청 중…" : "신청하기"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
