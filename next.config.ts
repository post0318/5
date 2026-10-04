import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 컨테이너·서버(구글 Cloud Run·오라클) 배포용 단독 실행 빌드 — BUILD_STANDALONE=1 일 때만(Vercel 빌드는 그대로, 2026-10-03)
  // 로컬 SEC 캐시(.cache, 수 GB)·검증 결과(reports)는 실행 파일에 넣지 않는다(파일 추적이 process.cwd() 경로를 따라 통째로 담았다 — 7.4GB 실측)
  ...(process.env.BUILD_STANDALONE === "1"
    ? { output: "standalone" as const, outputFileTracingExcludes: { "*": [".cache/**", "reports/**", "scripts/.tmp/**", ".claude/**", "docs/**"] } }
    : {}),
  // 서버 전용 패키지는 번들하지 않고 Node가 직접 require 하게 둔다.
  // mongodb(오너 지시 2026-09-19 — Vercel "Deployment Storage" 10GB 초과
  // 대응, src/lib/db/* 를 쓰는 라우트 18곳에 번들마다 중복 포함되던 것 방지)
  // + 실측으로 함께 확인된 bson.
  serverExternalPackages: ["yahoo-finance2", "mongodb", "bson"],
};

export default nextConfig;
