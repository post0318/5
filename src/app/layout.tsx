import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { koKR } from "@clerk/localizations";
import "./globals.css";
import { Providers } from "@/components/providers";
import { resolveAuthState } from "@/lib/server/app-auth";

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
  // 인증 상태를 서버 렌더링에서 미리 판정해 내려준다 — 예전에는 화면이 뜬 뒤
  // /api/auth/me 를 따로 불러 왕복이 한 번 더 붙었다.
  const initialAuth = clerkEnabled ? await resolveAuthState() : null;

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
