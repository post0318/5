import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 서버 전용 패키지는 번들하지 않고 Node가 직접 require 하게 둔다.
  // mongodb(오너 지시 2026-09-19 — Vercel "Deployment Storage" 10GB 초과
  // 대응, src/lib/db/* 를 쓰는 라우트 18곳에 번들마다 중복 포함되던 것 방지)
  // + 실측으로 함께 확인된 bson.
  serverExternalPackages: ["yahoo-finance2", "@libsql/client", "libsql", "pptxgenjs", "mongodb", "bson"],
};

export default nextConfig;
