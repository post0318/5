"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useClerk, useUser } from "@clerk/nextjs";

/**
 * 앱 인증 컨텍스트 — 4번 프로젝트(post0318/4)의 `components/auth/AppAuth.tsx`
 * 와 같은 구조. Clerk 훅은 ClerkProvider 밖에서 부르면 예외가 나므로 키가 없는
 * 환경에서는 "비활성" 값을 대신 제공한다. 화면 컴포넌트는 이 훅만 쓰고 Clerk
 * 를 직접 참조하지 않는다.
 */
export interface AppAuth {
  /** Clerk 키가 설정되어 인증을 쓸 수 있는가 */
  enabled: boolean;
  /** Clerk 초기화 완료 여부 (false 면 아직 모름) */
  isLoaded: boolean;
  isSignedIn: boolean;
  email: string | null;
  /** 유니버스 사용 허용 여부 — 서버(/api/auth/me)가 판단. null 이면 확인 전 */
  allowed: boolean | null;
  /** 관리자(ADMIN_EMAILS) 여부 — 「기존 유니버스 가져오기」 노출 판단 */
  isAdmin: boolean;
  /** 서버가 거부한 이유 */
  deniedReason: string | null;
  /**
   * 가입 가능한 이메일 도메인. 서버(`/api/auth/me`)가 내려준다 — 가입 신청
   * 화면의 **사전 검사·안내 문구용**이고 진짜 판단은 서버가 한다.
   * 빈 배열이면 도메인 제한 없음.
   */
  allowedDomains: string[];
  openSignIn: () => void;
  openProfile: () => void;
  signOut: () => Promise<void>;
  /** 승인 대기 가입 신청. 실패 시 메시지를 던진다. */
  joinWaitlist: (emailAddress: string) => Promise<void>;
  /**
   * 가입 신청 팝업 열기. 팝업 자체는 `SignupHost` 가 앱에 하나만 띄운다 —
   * 4번 프로젝트가 콜백(onSignup)을 내려주던 자리를 컨텍스트로 대신한다.
   */
  openSignup: () => void;
  /** SignupHost 전용 — 화면 컴포넌트는 쓰지 않는다 */
  signupOpen: boolean;
  setSignupOpen: (v: boolean) => void;
}

const DISABLED: AppAuth = {
  enabled: false,
  isLoaded: true,
  isSignedIn: false,
  email: null,
  allowed: false,
  isAdmin: false,
  deniedReason: null,
  allowedDomains: [],
  openSignIn: () => {},
  openProfile: () => {},
  signOut: async () => {},
  joinWaitlist: async () => {
    throw new Error("인증 서비스가 설정되지 않았습니다.");
  },
  openSignup: () => {},
  signupOpen: false,
  setSignupOpen: () => {},
};

const Ctx = createContext<AppAuth>(DISABLED);

function ClerkBridge({ children }: { children: ReactNode }) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();
  const [signupOpen, setSignupOpen] = useState(false);
  const [verdict, setVerdict] = useState<{
    allowed: boolean;
    admin: boolean;
    reason: string | null;
  } | null>(null);
  const [domains, setDomains] = useState<string[]>([]);

  // 로그인 상태가 바뀔 때마다 서버에 허용 여부를 묻는다. 로그아웃 상태에서도
  // 부른다 — 가입 신청 화면이 쓸 허용 도메인 목록이 같은 응답에 들어있다.
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then(
        (d: {
          allowed?: boolean;
          admin?: boolean;
          reason?: string;
          domains?: string[];
        }) => {
          if (cancelled) return;
          if (Array.isArray(d.domains)) setDomains(d.domains);
          setVerdict({
            allowed: !!isSignedIn && d.allowed === true,
            admin: !!isSignedIn && d.admin === true,
            reason: isSignedIn ? (d.reason ?? null) : null,
          });
        },
      )
      .catch(() => {
        if (!cancelled)
          setVerdict({
            allowed: false,
            admin: false,
            reason: isSignedIn ? "허용 여부를 확인하지 못했습니다." : null,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, user?.id]);

  // Clerk 로그인 팝업의 "가입" 링크는 `waitlistUrl`(= /kr/universe?signup=1)
  // 로 돌아온다. 4번 프로젝트가 서버에서 searchParams 를 읽어 내려주던 자리를
  // 여기서 대신한다 — 어느 화면으로 돌아와도 가입 폼이 열리게. 한 번 열고
  // 주소에서 지워 새로고침에 다시 뜨지 않게 한다.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("signup") !== "1") return;
    url.searchParams.delete("signup");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    // 효과 안에서 곧바로 setState 하면 연쇄 렌더 경고가 난다 — 한 틱 미룬다.
    const id = setTimeout(() => setSignupOpen(true), 0);
    return () => clearTimeout(id);
  }, []);

  const value: AppAuth = {
    enabled: true,
    isLoaded,
    isSignedIn: !!isSignedIn,
    email:
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress ??
      null,
    allowed: !isSignedIn ? false : verdict ? verdict.allowed : null,
    isAdmin: !!isSignedIn && verdict?.admin === true,
    deniedReason: verdict?.reason ?? null,
    allowedDomains: domains,
    openSignIn: () => clerk.openSignIn({}),
    openProfile: () => clerk.openUserProfile({}),
    signOut: () => clerk.signOut(),
    openSignup: () => setSignupOpen(true),
    signupOpen,
    setSignupOpen,
    joinWaitlist: async (emailAddress) => {
      try {
        await clerk.joinWaitlist({ emailAddress });
      } catch (e) {
        const errs = (e as { errors?: { longMessage?: string; message?: string }[] })
          ?.errors;
        throw new Error(
          errs?.[0]?.longMessage ??
            errs?.[0]?.message ??
            (e instanceof Error ? e.message : "가입 신청에 실패했습니다."),
        );
      }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function AppAuthProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  if (!enabled) return <Ctx.Provider value={DISABLED}>{children}</Ctx.Provider>;
  return <ClerkBridge>{children}</ClerkBridge>;
}

export function useAppAuth(): AppAuth {
  return useContext(Ctx);
}

/**
 * 가입 신청 화면의 사전 검사. 허용 판단 자체는 서버(`/api/auth/me`,
 * `requireAppUser`)가 하고, 여기서는 잘못된 주소로 신청해 승인 대기만 쌓이는
 * 걸 막는다. `domains` 가 비어 있으면 제한이 없다는 뜻이라 통과시킨다.
 */
export function isAllowedEmail(email: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((d) => domain === d.toLowerCase());
}
