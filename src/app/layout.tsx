import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { koKR } from "@clerk/localizations";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { resolveAuthStateFast } from "@/lib/server/app-auth";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const notoKR = Noto_Sans_KR({
  variable: "--font-noto-kr",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "글로벌 종목 리서치",
  description: "유니버스 종목의 재무제표 · 공시 · 뉴스 · 멀티플 통합 조회",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Clerk 키가 없으면(로컬 초기 상태) 인증 없이 렌더 — 유니버스 화면만 잠긴다.
  const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  // 로그인 여부만 빠르게(네트워크 없이) 판정해 내려준다 — allowed/admin/email
  // 확정은 클라이언트(/api/auth/me, 비차단)에 맡긴다. 자세한 이유는
  // resolveAuthStateFast() 주석 참고 — 여기서 currentUser() 까지 기다리면
  // 루트 레이아웃이 Suspense 없이 통째로 멈춰서 로그인 후 전 화면이 느려졌다.
  const initialAuth = clerkEnabled ? await resolveAuthStateFast() : null;

  const body = (
    <html
      lang="ko"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${notoKR.variable} h-full antialiased`}
    >
      <body className="bg-background text-foreground min-h-full">
        <Providers authEnabled={clerkEnabled} initialAuth={initialAuth}>
          {children}
        </Providers>
        {/* Vercel Analytics — 방문자·페이지뷰 집계. 배포된 Vercel 프로젝트에서
            자동 수집되고 별도 키·설정이 필요 없다. */}
        <Analytics />
      </body>
    </html>
  );

  if (!clerkEnabled) return body;
  return (
    <ClerkProvider
      localization={koKR}
      // 로그인 팝업의 "가입" 링크 → 승인 대기 신청 안내로
      waitlistUrl="/kr/universe?signup=1"
      afterSignOutUrl="/"
    >
      {body}
    </ClerkProvider>
  );
}
