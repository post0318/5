"use client";

import { useState, type ReactNode } from "react";
import { useAppAuth } from "@/components/auth/app-auth";
import { SignupDialog } from "@/components/auth/signup-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * 유니버스에 의존하는 화면(통합 뷰·통합 뉴스·유니버스 관리)의 진입 문.
 * 유니버스가 계정별로 분리돼 로그인 없이는 보여줄 내용 자체가 없다.
 * 진짜 잠금은 서버 라우트(`requireAppUser`)가 하고, 여기서는 안내만 한다.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAppAuth();
  const [signupOpen, setSignupOpen] = useState(false);

  if (auth.enabled && auth.isSignedIn && auth.allowed === true) return <>{children}</>;

  let body: ReactNode;
  if (!auth.enabled) {
    body = (
      <>
        <p className="font-medium">인증 서비스가 아직 설정되지 않았습니다.</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Clerk 키(NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY)를 넣으면
          유니버스 화면이 열립니다.
        </p>
      </>
    );
  } else if (!auth.isLoaded || (auth.isSignedIn && auth.allowed === null)) {
    body = <p className="text-muted-foreground text-sm">접근 권한 확인 중…</p>;
  } else if (auth.isSignedIn && auth.allowed === false) {
    body = (
      <>
        <p className="text-destructive font-medium">
          이 계정은 유니버스를 사용할 수 없습니다.
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          현재 계정 {auth.email}
          {auth.deniedReason ? ` · ${auth.deniedReason}` : ""}
        </p>
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={() => void auth.signOut()}>
            로그아웃
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="font-medium">유니버스는 로그인한 계정에만 보입니다.</p>
        <p className="text-muted-foreground mt-1 text-xs">
          계정마다 유니버스가 따로 관리됩니다. 계정이 없으면 가입을 신청하세요.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={auth.openSignIn}>
            로그인
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSignupOpen(true)}>
            가입 신청
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <Card className="mx-auto mt-10 w-full max-w-md">
        <CardContent className="p-6 text-sm">{body}</CardContent>
      </Card>
      <SignupDialog open={signupOpen} onOpenChange={setSignupOpen} />
    </>
  );
}
