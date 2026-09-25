import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Clerk 세션을 요청에 붙이는 Next 16 Proxy(구 middleware).
 * 여기서는 아무것도 막지 않는다 — 실제 잠금은 각 라우트가
 * `requireAppUser()`(`lib/server/app-auth.ts`)로 하고, 화면은 `AuthGate` 가
 * 로그인 안내를 띄운다. 4번 프로젝트(post0318/4)와 같은 구조.
 *
 * 잠기는 경로(모두 라우트 내부에서 검증):
 *   /api/universe 이하 전부           유니버스 조회·등록·수정·삭제 (계정별)
 *   /api/news/universe                유니버스통합 뉴스 (계정별)
 *   /api/weekly (GET 제외)            주간 리포트 생성·수정·발행
 *   종목뉴스 summarize 라우트          LLM 비용 발생
 *
 * `/api/cron/*` 은 사람이 아니라 수집 스크립트가 부르는 경로라 여기와 무관하다
 * — CRON_SECRET(로컬 수동 실행 시 APP_PASSWORD)으로 각자 검증한다.
 *
 * Clerk 키가 없으면(로컬 초기 상태, CI) 통과시켜 앱 나머지는 그대로 돌게 한다.
 * 이때 보호 경로는 `requireAppUser()` 가 503 으로 닫는다(fail-closed).
 */
const clerkConfigured =
  !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default clerkConfigured ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // 정적 파일·Next 내부 경로 제외
    "/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // API 는 항상
    "/(api|trpc)(.*)",
  ],
};
