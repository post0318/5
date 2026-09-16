"use client";

import { useAppAuth } from "@/components/auth/app-auth";
import { SignupDialog } from "@/components/auth/signup-dialog";

/**
 * 가입 신청 팝업을 앱에 하나만 띄운다. 헤더 계정 메뉴·유니버스 안내 박스·
 * Clerk 로그인 팝업의 "가입" 링크(`?signup=1`)가 모두 같은 팝업을 연다.
 */
export function SignupHost() {
  const auth = useAppAuth();
  if (!auth.enabled) return null;
  return <SignupDialog open={auth.signupOpen} onOpenChange={auth.setSignupOpen} />;
}
