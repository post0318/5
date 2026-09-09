"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/manage";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(j?.error ?? "로그인 실패");
        return;
      }
      router.replace(next.startsWith("/") ? next : "/manage");
      router.refresh();
    } catch {
      setError("네트워크 오류");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-border bg-card w-full max-w-xs space-y-4 rounded-xl border p-6"
    >
      <div className="space-y-1">
        <h1 className="text-base font-semibold">관리자 로그인</h1>
        <p className="text-muted-foreground text-xs">
          유니버스 편집·갱신에는 인증이 필요합니다.
        </p>
      </div>
      <Input
        type="password"
        autoFocus
        placeholder="비밀번호"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={error ? true : undefined}
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy || !password}>
        {busy ? "확인 중…" : "로그인"}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
