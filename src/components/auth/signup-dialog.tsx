"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useAppAuth } from "@/components/auth/app-auth";
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
 */
export function SignupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const auth = useAppAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value.includes("@")) {
      toast.error("이메일 주소를 확인해 주세요.");
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
            신청하면 관리자 승인 뒤에 로그인할 수 있습니다. 승인되면 가입 안내
            메일이 신청한 주소로 갑니다.
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
                placeholder="name@example.com"
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
